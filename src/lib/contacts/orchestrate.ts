/**
 * Phase 47 — Module 2 orchestrator. Discovery flow:
 *
 *   1. Read brand_qualifications.selected_entity → derive domain.
 *   2. apolloSearchPeople(domain, titles=[founder,ceo,president,owner]).
 *   3. For each candidate:
 *        a. apolloMatchPerson → email if available.
 *        b. If empty: hunterEmailFinder via cached/looked-up pattern.
 *        c. If still empty: pattern_guess from contact_domain_cache
 *           (only if pattern_confidence >= 0.7).
 *   4. verifyEmail(email) for each candidate WITH an email.
 *   5. ready_to_send = email_status === 'verified'.
 *   6. Pick primary by deterministic title hierarchy
 *      (founder > owner > ceo > president > first verified > first found).
 *   7. Persist all contacts; mark contacts_state='complete'.
 */
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { apolloMatchPerson, apolloSearchPeople, type ApolloPersonSlim } from "./apollo";
import {
  hunterDomainPattern,
  hunterEmailFinder,
} from "./hunter";
import { verifyEmail, type VerifyResult } from "./email-verify";
import {
  applyEmailPattern,
  readPatternCache,
  writePatternCache,
} from "./pattern";

const PATTERN_CONFIDENCE_FLOOR = 0.7;
const SEARCH_TITLES = ["founder", "ceo", "president", "owner"];

export interface RunContactDiscoveryResult {
  ok: boolean;
  state: "complete" | "error" | "skipped";
  contact_count?: number;
  primary_id?: string | null;
  error?: string;
}

interface CandidateRecord {
  apollo_person_id: string | null;
  apollo_organization_id: string | null;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  linkedin_url: string | null;
  email: string | null;
  email_source:
    | "apollo"
    | "apollo_crm"
    | "hunter"
    | "hunter_pattern"
    | "pattern_guess"
    | "manual"
    | "unknown";
  email_pattern_used: string | null;
  email_status:
    | "verified"
    | "likely"
    | "risky"
    | "catch_all"
    | "guessed"
    | "bounced"
    | "invalid"
    | "unknown"
    | "not_found"
    | null;
  email_verifier: "millionverifier" | "zerobounce" | "none" | null;
  email_verifier_score: number | null;
  email_verified_at: string | null;
  raw_apollo: unknown;
  raw_hunter: unknown;
}

export async function runContactDiscovery(
  brandId: string,
): Promise<RunContactDiscoveryResult> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return { ok: false, state: "error", error: "missing SUPABASE_SERVICE_ROLE_KEY" };
  }

  // Mark running.
  const nowIso = new Date().toISOString();
  await admin
    .from("brands")
    .update({ contacts_state: "running", updated_at: nowIso })
    .eq("id", brandId);

  // 1. Derive domain. Prefer `brands.resolved_owner_domain`, else
  //    `brand_qualifications.selected_entity.evidence_url` host fallback.
  const { data: brand } = await admin
    .from("brands")
    .select("id, name, resolved_owner_domain")
    .eq("id", brandId)
    .maybeSingle<{ id: string; name: string; resolved_owner_domain: string | null }>();
  if (!brand) {
    return await markError(brandId, "brand not found");
  }

  const { data: qual } = await admin
    .from("brand_qualifications")
    .select("id, selected_entity")
    .eq("brand_id", brandId)
    .maybeSingle<{ id: string; selected_entity: { evidence_url?: string } | null }>();

  const domain =
    extractDomain(brand.resolved_owner_domain) ||
    extractDomain(qual?.selected_entity?.evidence_url ?? null);
  if (!domain) {
    return await markError(brandId, "no domain resolved for brand");
  }

  // 2. Apollo search.
  const search = await apolloSearchPeople({
    organization_domain: domain,
    titles: SEARCH_TITLES,
    page: 1,
  });
  const apolloCandidates: ApolloPersonSlim[] = search.ok ? search.people.slice(0, 10) : [];

  // 3. Pattern cache lookup. If absent, try Hunter domain-search to
  //    populate it once. Then any candidate without an Apollo email can
  //    fall back through pattern_guess.
  let cache = await readPatternCache(domain);
  if (!cache) {
    const pat = await hunterDomainPattern(domain);
    if (pat.ok) {
      await writePatternCache({
        domain,
        email_pattern: pat.pattern,
        pattern_source: "hunter",
        pattern_confidence: pat.pattern_confidence,
        is_catch_all: pat.is_catch_all,
      });
      cache = await readPatternCache(domain);
    }
  }

  // 4. Per-candidate enrichment.
  const candidates: CandidateRecord[] = [];
  for (const p of apolloCandidates) {
    // Split `name` if Apollo only returned the combined string (basic
    // plan responses sometimes omit first_name/last_name fields). Without
    // first/last we cannot call Hunter at all.
    let first = (p.first_name ?? "").trim();
    let last = (p.last_name ?? "").trim();
    const combined = (p.name ?? "").trim();
    if ((!first || !last) && combined) {
      const parts = combined.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        if (!first) first = parts[0];
        if (!last) last = parts[parts.length - 1];
      } else if (parts.length === 1 && !first) {
        first = parts[0];
      }
    }
    const fullName = combined || `${first} ${last}`.trim() || "(unknown)";
    // Apollo basic plan often returns placeholder strings instead of a
    // real address — strip those before treating the field as an email.
    let email: string | null = sanitizeApolloEmail(p.email ?? null);
    let email_source: CandidateRecord["email_source"] = "unknown";
    let email_pattern_used: string | null = null;
    let raw_hunter: unknown = null;
    if (email) {
      email_source = "apollo";
    } else {
      // a) Try Apollo match-by-name.
      const match = await apolloMatchPerson({
        domain,
        first_name: first || undefined,
        last_name: last || undefined,
      });
      const matchedEmail = sanitizeApolloEmail(match.ok ? match.person?.email ?? null : null);
      if (matchedEmail) {
        email = matchedEmail;
        email_source = "apollo";
      }
    }
    if (!email && first && last) {
      // b) Hunter email-finder.
      const hf = await hunterEmailFinder({
        domain,
        first_name: first,
        last_name: last,
      });
      raw_hunter = hf.raw;
      if (hf.ok && hf.email) {
        email = hf.email;
        email_source = "hunter";
        email_pattern_used = hf.pattern ?? null;
      }
    }
    if (!email && first && last && cache?.email_pattern) {
      // c) Pattern guess from cache (only when confidence is high enough).
      const conf = cache.pattern_confidence ?? 0;
      if (conf >= PATTERN_CONFIDENCE_FLOOR) {
        const guessed = applyEmailPattern(cache.email_pattern, first, last, domain);
        if (guessed) {
          email = guessed;
          email_source = "pattern_guess";
          email_pattern_used = cache.email_pattern;
        }
      }
    }
    // d) Verify.
    let verify: VerifyResult | null = null;
    if (email) {
      verify = await verifyEmail(email);
    }

    candidates.push({
      apollo_person_id: p.id || null,
      apollo_organization_id: p.organization_id ?? null,
      full_name: fullName,
      first_name: first || null,
      last_name: last || null,
      title: p.title ?? null,
      linkedin_url: p.linkedin_url ?? null,
      email,
      email_source: email ? email_source : "unknown",
      email_pattern_used,
      email_status: email
        ? verify
          ? mapVerifyStatus(verify.status)
          : "guessed"
        : "not_found",
      email_verifier: email ? (verify?.verifier ?? "none") : null,
      email_verifier_score:
        email && verify && typeof verify.score === "number"
          ? verify.score
          : null,
      email_verified_at: email && verify ? new Date().toISOString() : null,
      raw_apollo: p,
      raw_hunter,
    });
  }

  // 5. Pick primary by title hierarchy.
  const primaryIdx = pickPrimaryIndex(candidates);

  // 6. Persist (replace existing rows for this brand).
  await admin.from("brand_contacts").delete().eq("brand_id", brandId);
  let primaryId: string | null = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    const ready_to_send = c.email_status === "verified";
    const { data, error } = await admin
      .from("brand_contacts")
      .insert({
        brand_id: brandId,
        qualification_id: qual?.id ?? null,
        full_name: c.full_name,
        first_name: c.first_name,
        last_name: c.last_name,
        title: c.title,
        linkedin_url: c.linkedin_url,
        company_name: null,
        company_domain: domain,
        email: c.email,
        email_source: c.email ? c.email_source : null,
        email_pattern_used: c.email_pattern_used,
        email_status: c.email_status,
        email_verifier: c.email_verifier,
        email_verifier_score: c.email_verifier_score,
        email_verified_at: c.email_verified_at,
        is_primary: i === primaryIdx,
        ready_to_send,
        apollo_person_id: c.apollo_person_id,
        apollo_organization_id: c.apollo_organization_id,
        raw_apollo: c.raw_apollo,
        raw_hunter: c.raw_hunter,
      })
      .select("id")
      .single();
    if (!error && data && i === primaryIdx) {
      primaryId = data.id;
    }
  }

  await admin
    .from("brands")
    .update({ contacts_state: "complete", updated_at: new Date().toISOString() })
    .eq("id", brandId);

  return {
    ok: true,
    state: "complete",
    contact_count: candidates.length,
    primary_id: primaryId,
  };
}

async function markError(
  brandId: string,
  message: string,
): Promise<RunContactDiscoveryResult> {
  const admin = createSupabaseAdminClient();
  if (admin) {
    await admin
      .from("brands")
      .update({ contacts_state: "error", updated_at: new Date().toISOString() })
      .eq("id", brandId);
  }
  return { ok: false, state: "error", error: message };
}

function pickPrimaryIndex(candidates: CandidateRecord[]): number {
  if (candidates.length === 0) return -1;
  const matchers: Array<RegExp> = [
    /founder/i,
    /owner/i,
    /\bceo\b/i,
    /president/i,
  ];
  for (const m of matchers) {
    const idx = candidates.findIndex((c) => c.title && m.test(c.title));
    if (idx >= 0) return idx;
  }
  const verifiedIdx = candidates.findIndex((c) => c.email_status === "verified");
  if (verifiedIdx >= 0) return verifiedIdx;
  return 0;
}

function mapVerifyStatus(
  s: VerifyResult["status"],
): CandidateRecord["email_status"] {
  switch (s) {
    case "verified":
    case "likely":
    case "risky":
    case "catch_all":
    case "invalid":
    case "unknown":
      return s;
    default:
      return "unknown";
  }
}

/**
 * Apollo basic plan returns sentinel values like
 * "email_not_unlocked@domain.com" or "domain_catch_all@…" instead of a
 * real email when the credit-gated email field is locked. Treat anything
 * that matches those well-known patterns as no-email so the orchestrator
 * falls through to Hunter.
 */
function sanitizeApolloEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = String(input).trim().toLowerCase();
  if (!v) return null;
  if (
    v.startsWith("email_not_unlocked") ||
    v.startsWith("domain_catch_all") ||
    v.includes("not_unlocked@") ||
    v.includes("@domain.com")
  ) {
    return null;
  }
  return v;
}

function extractDomain(input: string | null): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("/")[0];
  s = s.split("?")[0];
  if (!s.includes(".")) return null;
  return s;
}
