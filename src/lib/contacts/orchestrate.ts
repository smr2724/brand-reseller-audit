/**
 * Phase 47 → Phase 61 — Module 2 orchestrator. Discovery flow:
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
 *   7. Upsert all contacts; mark contacts_state='complete'.
 *
 * Phase 61 additions:
 *   - A single `run_id` (uuid) is generated for the entire discovery run
 *     and emitted on every provider boundary as a row in
 *     `brand_contact_discovery_events` (see ./events.ts). The UI reads
 *     this to render the per-row provider-chain audit trail.
 *   - Persistence is now upsert-by-(brand_id, apollo_person_id) (or
 *     name fallback) instead of delete-then-insert. Rows where the user
 *     has committed (`email_source='manual'`, `is_primary=true`, or
 *     `ready_to_send=true`) survive re-discovery untouched on
 *     user-edited fields. Other rows that didn't appear in the new run
 *     and aren't sticky get removed.
 *   - The Apollo `/people/match` payload is now persisted on the contact
 *     row as `raw_apollo_match` (previously dropped after the email was
 *     extracted).
 */
import { randomUUID } from "crypto";
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
import { recordDiscoveryEvent } from "./events";

const PATTERN_CONFIDENCE_FLOOR = 0.7;
const SEARCH_TITLES = ["founder", "ceo", "president", "owner"];

export interface RunContactDiscoveryResult {
  ok: boolean;
  state: "complete" | "error" | "skipped";
  contact_count?: number;
  primary_id?: string | null;
  run_id?: string;
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
  raw_apollo_match: unknown;
  raw_hunter: unknown;
  verify_raw: unknown;
}

interface ExistingContactRow {
  id: string;
  full_name: string;
  apollo_person_id: string | null;
  email: string | null;
  email_source: string | null;
  is_primary: boolean;
  ready_to_send: boolean;
  notes: string | null;
}

export async function runContactDiscovery(
  brandId: string,
): Promise<RunContactDiscoveryResult> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return { ok: false, state: "error", error: "missing SUPABASE_SERVICE_ROLE_KEY" };
  }

  const runId = randomUUID();

  // Mark running.
  const nowIso = new Date().toISOString();
  await admin
    .from("brands")
    .update({ contacts_state: "running", updated_at: nowIso })
    .eq("id", brandId);

  // 1. Derive domain.
  const { data: brand } = await admin
    .from("brands")
    .select("id, name, resolved_owner_domain")
    .eq("id", brandId)
    .maybeSingle<{ id: string; name: string; resolved_owner_domain: string | null }>();
  if (!brand) {
    return await markError(brandId, "brand not found", runId);
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
    await recordDiscoveryEvent({
      brand_id: brandId,
      run_id: runId,
      provider: "orchestrator",
      outcome: "error",
      reason: "No domain resolved for brand — set resolved_owner_domain or selected_entity.evidence_url.",
    });
    return await markError(brandId, "no domain resolved for brand", runId);
  }

  // 2. Apollo search.
  const search = await apolloSearchPeople({
    organization_domain: domain,
    titles: SEARCH_TITLES,
    page: 1,
  });
  if (!search.ok) {
    await recordDiscoveryEvent({
      brand_id: brandId,
      run_id: runId,
      provider: "apollo_search",
      outcome:
        search.error === "apollo_retry_exhausted"
          ? "retry_exhausted"
          : "error",
      reason: `Apollo search failed for ${domain}: ${search.error}`,
      http_status: search.status ?? null,
      raw_payload: { error: search.error, status: search.status ?? null },
    });
  } else {
    await recordDiscoveryEvent({
      brand_id: brandId,
      run_id: runId,
      provider: "apollo_search",
      outcome: search.people.length > 0 ? "found" : "not_found",
      reason:
        search.people.length > 0
          ? `Apollo: ${search.people.length} candidate(s) at ${domain} for titles ${SEARCH_TITLES.join("/")}.`
          : `Apollo: search returned 0 candidates for titles ${SEARCH_TITLES.join("/")} at ${domain}.`,
      raw_payload: search.raw,
    });
  }
  const apolloCandidates: ApolloPersonSlim[] = search.ok ? search.people.slice(0, 10) : [];

  // 3. Pattern cache lookup. If absent, try Hunter domain-search to
  //    populate it once.
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
      await recordDiscoveryEvent({
        brand_id: brandId,
        run_id: runId,
        provider: "hunter_domain",
        outcome: pat.pattern ? "found" : "not_found",
        reason: pat.pattern
          ? `Hunter: pattern ${pat.pattern} (confidence ${pat.pattern_confidence.toFixed(2)}) for ${domain}.`
          : `Hunter: no email pattern available for ${domain}.`,
        score_returned: clampScore(pat.pattern_confidence),
        raw_payload: pat.raw,
      });
    } else {
      await recordDiscoveryEvent({
        brand_id: brandId,
        run_id: runId,
        provider: "hunter_domain",
        outcome: "error",
        reason: `Hunter domain-search failed for ${domain}: ${pat.error ?? "unknown error"}`,
        raw_payload: { error: pat.error ?? null },
      });
    }
  } else {
    await recordDiscoveryEvent({
      brand_id: brandId,
      run_id: runId,
      provider: "hunter_domain",
      outcome: "skipped",
      reason: `Hunter domain-search skipped — cached pattern ${cache.email_pattern ?? "(none)"} for ${domain} still fresh.`,
      score_returned: clampScore(cache.pattern_confidence),
    });
  }

  // 4. Per-candidate enrichment. We emit events as we go; we don't yet
  //    have `contact_id`s (rows are upserted at the end), so per-candidate
  //    events carry a `candidate_index` in `reason` and we backfill
  //    `contact_id` after upsert.
  type CandidateEventDraft = Omit<Parameters<typeof recordDiscoveryEvent>[0], "brand_id" | "run_id"> & {
    candidate_index: number;
  };
  const candidateEvents: CandidateEventDraft[] = [];

  const candidates: CandidateRecord[] = [];
  for (let idx = 0; idx < apolloCandidates.length; idx += 1) {
    const p = apolloCandidates[idx];
    // Split `name` if Apollo only returned the combined string.
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

    let email: string | null = sanitizeApolloEmail(p.email ?? null);
    let email_source: CandidateRecord["email_source"] = "unknown";
    let email_pattern_used: string | null = null;
    let raw_hunter: unknown = null;
    let raw_apollo_match: unknown = null;

    if (email) {
      email_source = "apollo";
      candidateEvents.push({
        candidate_index: idx,
        provider: "apollo_match",
        outcome: "skipped",
        reason: `Apollo: search row already contained an email for ${fullName} — skipped /people/match.`,
        email_returned: email,
      });
    } else {
      // a) Try Apollo match-by-name.
      const match = await apolloMatchPerson({
        domain,
        first_name: first || undefined,
        last_name: last || undefined,
      });
      if (!match.ok) {
        candidateEvents.push({
          candidate_index: idx,
          provider: "apollo_match",
          outcome:
            match.error === "apollo_retry_exhausted"
              ? "retry_exhausted"
              : "error",
          reason: `Apollo: /people/match failed for ${fullName} at ${domain}: ${match.error}`,
          http_status: match.status ?? null,
          raw_payload: { error: match.error, status: match.status ?? null },
        });
      } else {
        const matchedEmail = sanitizeApolloEmail(match.person?.email ?? null);
        raw_apollo_match = match.raw;
        if (matchedEmail) {
          email = matchedEmail;
          email_source = "apollo";
          candidateEvents.push({
            candidate_index: idx,
            provider: "apollo_match",
            outcome: "found",
            reason: `Apollo: matched ${fullName} at ${domain} → ${matchedEmail}.`,
            email_returned: matchedEmail,
            raw_payload: match.raw,
          });
        } else {
          candidateEvents.push({
            candidate_index: idx,
            provider: "apollo_match",
            outcome: "not_found",
            reason: match.person
              ? `Apollo: matched ${fullName} but no unlocked email returned.`
              : `Apollo: no person match for ${fullName} at ${domain}.`,
            raw_payload: match.raw,
          });
        }
      }
    }

    // b) Hunter email-finder.
    if (!email && first && last) {
      const hf = await hunterEmailFinder({
        domain,
        first_name: first,
        last_name: last,
      });
      raw_hunter = hf.raw;
      if (!hf.ok) {
        candidateEvents.push({
          candidate_index: idx,
          provider: "hunter_finder",
          outcome: "error",
          reason: `Hunter email-finder failed for ${fullName} at ${domain}: ${hf.error ?? "unknown error"}`,
          raw_payload: hf.raw ?? { error: hf.error ?? null },
        });
      } else if (hf.email) {
        email = hf.email;
        email_source = "hunter";
        email_pattern_used = hf.pattern ?? null;
        candidateEvents.push({
          candidate_index: idx,
          provider: "hunter_finder",
          outcome: "found",
          reason: `Hunter: ${fullName} → ${hf.email} (pattern ${hf.pattern ?? "n/a"}, score ${hf.score ?? "?"}).`,
          email_returned: hf.email,
          score_returned:
            typeof hf.score === "number" ? clampScore(hf.score / 100) : null,
          raw_payload: hf.raw,
        });
      } else {
        candidateEvents.push({
          candidate_index: idx,
          provider: "hunter_finder",
          outcome: "not_found",
          reason: `Hunter: no email found for ${fullName} at ${domain}.`,
          raw_payload: hf.raw,
        });
      }
    } else if (!email) {
      candidateEvents.push({
        candidate_index: idx,
        provider: "hunter_finder",
        outcome: "skipped",
        reason: `Hunter email-finder skipped for ${fullName} — missing first/last name.`,
      });
    } else {
      candidateEvents.push({
        candidate_index: idx,
        provider: "hunter_finder",
        outcome: "skipped",
        reason: `Hunter email-finder skipped — Apollo already produced ${email} for ${fullName}.`,
      });
    }

    // c) Pattern guess.
    if (!email && first && last && cache?.email_pattern) {
      const conf = cache.pattern_confidence ?? 0;
      if (conf >= PATTERN_CONFIDENCE_FLOOR) {
        const guessed = applyEmailPattern(cache.email_pattern, first, last, domain);
        if (guessed) {
          email = guessed;
          email_source = "pattern_guess";
          email_pattern_used = cache.email_pattern;
          candidateEvents.push({
            candidate_index: idx,
            provider: "pattern_guess",
            outcome: "found",
            reason: `Pattern guess: applied ${cache.email_pattern} (confidence ${conf.toFixed(2)}) → ${guessed}.`,
            email_returned: guessed,
            score_returned: clampScore(conf),
          });
        } else {
          candidateEvents.push({
            candidate_index: idx,
            provider: "pattern_guess",
            outcome: "not_found",
            reason: `Pattern guess: pattern ${cache.email_pattern} present but could not synthesize email for ${fullName}.`,
          });
        }
      } else {
        candidateEvents.push({
          candidate_index: idx,
          provider: "pattern_guess",
          outcome: "skipped",
          reason: `Pattern guess: pattern_confidence ${conf.toFixed(2)} below floor ${PATTERN_CONFIDENCE_FLOOR} — skipped.`,
          score_returned: clampScore(conf),
        });
      }
    } else if (!email) {
      candidateEvents.push({
        candidate_index: idx,
        provider: "pattern_guess",
        outcome: "skipped",
        reason: cache?.email_pattern
          ? `Pattern guess skipped — missing first/last name.`
          : `Pattern guess skipped — no domain pattern available for ${domain}.`,
      });
    } else {
      candidateEvents.push({
        candidate_index: idx,
        provider: "pattern_guess",
        outcome: "skipped",
        reason: `Pattern guess skipped — email already resolved via ${email_source}.`,
      });
    }

    // d) Verify.
    let verify: VerifyResult | null = null;
    if (email) {
      verify = await verifyEmail(email);
      const isMv = verify.verifier === "millionverifier";
      const isZb = verify.verifier === "zerobounce";
      const mvOutcome: "found" | "skipped" = isMv ? "found" : "skipped";
      const mvReason = isMv
        ? `MillionVerifier: ${verify.status}${typeof verify.score === "number" ? ` (score ${verify.score.toFixed(2)})` : ""} for ${email}.`
        : verify.verifier === "none"
          ? `MillionVerifier: skipped — provider unavailable or unconfigured.`
          : `MillionVerifier: ${verify.status === "catch_all" || verify.status === "unknown" ? `returned ${verify.status}, deferred to ZeroBounce` : "skipped"}.`;
      candidateEvents.push({
        candidate_index: idx,
        provider: "millionverifier",
        outcome: mvOutcome,
        reason: mvReason,
        email_returned: email,
        status_returned: isMv ? verify.status : null,
        score_returned: isMv && typeof verify.score === "number" ? clampScore(verify.score) : null,
        raw_payload: isMv ? verify.raw : null,
      });
      const zbOutcome: "found" | "skipped" = isZb ? "found" : "skipped";
      const zbReason = isZb
        ? `ZeroBounce: ${verify.status}${typeof verify.score === "number" ? ` (score ${verify.score.toFixed(2)})` : ""} for ${email}.`
        : isMv
          ? `ZeroBounce: skipped — MillionVerifier returned ${verify.status}.`
          : `ZeroBounce: skipped — no verifier returned a definite result.`;
      candidateEvents.push({
        candidate_index: idx,
        provider: "zerobounce",
        outcome: zbOutcome,
        reason: zbReason,
        email_returned: email,
        status_returned: isZb ? verify.status : null,
        score_returned: isZb && typeof verify.score === "number" ? clampScore(verify.score) : null,
        raw_payload: isZb ? verify.raw : null,
      });
    } else {
      candidateEvents.push({
        candidate_index: idx,
        provider: "millionverifier",
        outcome: "skipped",
        reason: `MillionVerifier: skipped — no email candidate to verify for ${fullName}.`,
      });
      candidateEvents.push({
        candidate_index: idx,
        provider: "zerobounce",
        outcome: "skipped",
        reason: `ZeroBounce: skipped — no email candidate to verify for ${fullName}.`,
      });
    }

    if (!email) {
      candidateEvents.push({
        candidate_index: idx,
        provider: "orchestrator",
        outcome: "not_found",
        reason: `No email resolved for ${fullName} after Apollo, Hunter, and pattern-guess fallbacks.`,
      });
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
      raw_apollo_match,
      raw_hunter,
      verify_raw: verify?.raw ?? null,
    });
  }

  // 5. Load existing rows for sticky-merge.
  const { data: existingRowsRaw } = await admin
    .from("brand_contacts")
    .select(
      "id, full_name, apollo_person_id, email, email_source, is_primary, ready_to_send, notes",
    )
    .eq("brand_id", brandId);
  const existingRows: ExistingContactRow[] = (existingRowsRaw ?? []) as ExistingContactRow[];

  function findExisting(c: CandidateRecord): ExistingContactRow | null {
    if (c.apollo_person_id) {
      const byId = existingRows.find(
        (r) => r.apollo_person_id && r.apollo_person_id === c.apollo_person_id,
      );
      if (byId) return byId;
    }
    const lname = c.full_name.trim().toLowerCase();
    if (!lname) return null;
    return (
      existingRows.find((r) => (r.full_name ?? "").trim().toLowerCase() === lname) ??
      null
    );
  }

  function isSticky(r: ExistingContactRow): boolean {
    return r.email_source === "manual" || r.is_primary === true || r.ready_to_send === true;
  }

  const matchedExistingIds = new Set<string>();
  const candidateContactIds: Array<string | null> = new Array(candidates.length).fill(null);

  // 6. Pick primary by title hierarchy among candidates (only used when
  //    no existing primary row survives).
  const newPrimaryIdx = pickPrimaryIndex(candidates);
  const existingPrimary = existingRows.find((r) => r.is_primary === true) ?? null;

  // 7. Upsert candidates.
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    const existing = findExisting(c);
    const sticky = existing ? isSticky(existing) : false;

    // The new row should be primary only if there is no surviving
    // existing primary AND this is the chosen index from the new run.
    const wantsPrimary = !existingPrimary && i === newPrimaryIdx;

    // Compute fields to write. Sticky rows preserve email/source/verifier
    // chain plus user fields. Non-sticky existing rows get a fresh refresh
    // from the new run. New rows (no existing match) get inserted.
    const refreshFromRun = {
      email: c.email,
      email_source: c.email ? c.email_source : null,
      email_pattern_used: c.email_pattern_used,
      email_status: c.email_status,
      email_verifier: c.email_verifier,
      email_verifier_score: c.email_verifier_score,
      email_verified_at: c.email_verified_at,
    };

    const baseFields: Record<string, unknown> = {
      brand_id: brandId,
      qualification_id: qual?.id ?? null,
      full_name: c.full_name,
      first_name: c.first_name,
      last_name: c.last_name,
      title: c.title,
      linkedin_url: c.linkedin_url,
      company_name: null,
      company_domain: domain,
      apollo_person_id: c.apollo_person_id,
      apollo_organization_id: c.apollo_organization_id,
      raw_apollo: c.raw_apollo,
      raw_apollo_match: c.raw_apollo_match,
      raw_hunter: c.raw_hunter,
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      matchedExistingIds.add(existing.id);
      const update: Record<string, unknown> = { ...baseFields };
      if (sticky) {
        // Preserve user-committed email/source/verifier on sticky rows.
        // Always refresh forensic fields (raw_*) regardless — those
        // describe what providers said *this run*, not user intent.
        // Don't touch is_primary, ready_to_send, notes either.
      } else {
        Object.assign(update, refreshFromRun);
        update.is_primary = wantsPrimary;
        update.ready_to_send = c.email_status === "verified";
      }
      const { data: updated, error: upErr } = await admin
        .from("brand_contacts")
        .update(update)
        .eq("id", existing.id)
        .eq("brand_id", brandId)
        .select("id")
        .maybeSingle();
      if (!upErr && updated) {
        candidateContactIds[i] = updated.id;
      }
    } else {
      const insert: Record<string, unknown> = {
        ...baseFields,
        ...refreshFromRun,
        is_primary: wantsPrimary,
        ready_to_send: c.email_status === "verified",
      };
      const { data: inserted, error: insErr } = await admin
        .from("brand_contacts")
        .insert(insert)
        .select("id")
        .maybeSingle();
      if (!insErr && inserted) {
        candidateContactIds[i] = inserted.id;
      }
    }
  }

  // 8. Remove orphaned non-sticky rows.
  const orphanIds = existingRows
    .filter((r) => !matchedExistingIds.has(r.id) && !isSticky(r))
    .map((r) => r.id);
  if (orphanIds.length > 0) {
    await admin
      .from("brand_contacts")
      .delete()
      .in("id", orphanIds)
      .eq("brand_id", brandId);
  }

  // 9. Backfill events with contact_id and persist.
  for (const ev of candidateEvents) {
    const contactId = candidateContactIds[ev.candidate_index] ?? null;
    const { candidate_index, ...rest } = ev;
    void candidate_index;
    await recordDiscoveryEvent({
      brand_id: brandId,
      run_id: runId,
      contact_id: contactId,
      ...rest,
    });
  }

  let primaryId: string | null = existingPrimary?.id ?? null;
  if (!primaryId && newPrimaryIdx >= 0) {
    primaryId = candidateContactIds[newPrimaryIdx] ?? null;
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
    run_id: runId,
  };
}

async function markError(
  brandId: string,
  message: string,
  runId?: string,
): Promise<RunContactDiscoveryResult> {
  const admin = createSupabaseAdminClient();
  if (admin) {
    await admin
      .from("brands")
      .update({ contacts_state: "error", updated_at: new Date().toISOString() })
      .eq("id", brandId);
  }
  return { ok: false, state: "error", error: message, run_id: runId };
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

function clampScore(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
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
