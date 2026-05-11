/**
 * Phase 47 → Phase 63 — Module 2 orchestrator.
 *
 * Apollo-first contact discovery with primary-only auto-enrich:
 *
 *   1. Read brand_qualifications.selected_entity → derive domain.
 *   2. apolloSearchPeople(domain, titles=[founder,ceo,president,owner])
 *      — slim records only, no credit-burning unlock.
 *   3. Rank the returned people via `rankCandidates` (founder/CEO > C-suite
 *      > VP/Head > Director > other). Take the top 5. The #1 ranked
 *      candidate becomes `is_primary=true`.
 *   4. Persist all 5 rows with `enrichment_state='discovered'`. Mark
 *      #1 with `is_primary=true`.
 *   5. Run the FULL enrichment pipeline (`enrichSingleContact`) on the
 *      primary only — Apollo unlock → if email, MillionVerifier; if no
 *      email but Apollo returned last_name, Hunter finder; if no email
 *      from Hunter but pattern+last_name available, pattern_guess →
 *      MillionVerifier. After the primary chain runs, set
 *      `enrichment_state='enriched'` regardless of email outcome.
 *   6. For each of the other 4 contacts, write a single
 *      `enrichment_deferred` audit event explaining the row is
 *      intentionally not enriched yet (one Apollo email credit per
 *      enrich, click Enrich on the row when ready). They stay at
 *      `enrichment_state='discovered'` until the on-demand enrich
 *      endpoint runs.
 *
 * Phase 61 sticky-merge behavior is preserved: rows the user has
 * committed (`email_source='manual'`, `is_primary=true`, or
 * `ready_to_send=true`) survive re-discovery untouched on user-edited
 * fields. Non-sticky existing rows that don't appear in the new run
 * are removed.
 */
import { randomUUID } from "crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { apolloSearchPeople, type ApolloPersonSlim } from "./apollo";
import { hunterDomainPattern } from "./hunter";
import { readPatternCache, writePatternCache } from "./pattern";
import { recordDiscoveryEvent } from "./events";
import { rankCandidates } from "./rank";
import { enrichSingleContact } from "./enrich-contact";

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
  organization_name: string | null;
  raw_apollo: unknown;
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

function clampScore(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function deriveNameParts(p: ApolloPersonSlim): {
  first: string;
  last: string;
  full_name: string;
} {
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
  return { first, last, full_name: fullName };
}

function candidateFromApolloPerson(p: ApolloPersonSlim): CandidateRecord {
  const { first, last, full_name } = deriveNameParts(p);
  return {
    apollo_person_id: p.id || null,
    apollo_organization_id: p.organization_id ?? null,
    full_name,
    first_name: first || null,
    last_name: last || null,
    title: p.title ?? null,
    linkedin_url: p.linkedin_url ?? null,
    organization_name: p.organization_name ?? null,
    raw_apollo: p,
  };
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

  // 3. Rank + take top 5.
  const ranked = search.ok ? rankCandidates(search) : [];
  const candidates: CandidateRecord[] = ranked.map((r) =>
    candidateFromApolloPerson(r.person),
  );

  // 4. Hunter domain-pattern (cache lookup OR fresh lookup) for the
  //    primary enrichment pipeline to use later. We do this once at the
  //    run level so the event surfaces in the audit trail above the
  //    contact rows.
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

  // 6. The #1-ranked candidate is the new primary. We still preserve an
  //    existing sticky primary if one survives sticky-merge.
  const existingPrimary = existingRows.find((r) => r.is_primary === true) ?? null;
  const newPrimaryIdx = candidates.length > 0 ? 0 : -1;

  // 7. Upsert candidates as `enrichment_state='discovered'`. The primary
  //    chain runs separately below.
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    const existing = findExisting(c);
    const sticky = existing ? isSticky(existing) : false;
    const wantsPrimary = !existingPrimary && i === newPrimaryIdx;

    const baseFields: Record<string, unknown> = {
      brand_id: brandId,
      qualification_id: qual?.id ?? null,
      full_name: c.full_name,
      first_name: c.first_name,
      last_name: c.last_name,
      title: c.title,
      linkedin_url: c.linkedin_url,
      company_name: c.organization_name,
      company_domain: domain,
      apollo_person_id: c.apollo_person_id,
      apollo_organization_id: c.apollo_organization_id,
      raw_apollo: c.raw_apollo,
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      matchedExistingIds.add(existing.id);
      const update: Record<string, unknown> = { ...baseFields };
      if (!sticky) {
        // Non-sticky rows go back to 'discovered' state. Their email
        // fields will be refreshed by enrichSingleContact below if this
        // row ends up being the primary.
        update.email = null;
        update.email_source = null;
        update.email_pattern_used = null;
        update.email_status = null;
        update.email_verifier = null;
        update.email_verifier_score = null;
        update.email_verified_at = null;
        update.enrichment_state = "discovered";
        update.is_primary = wantsPrimary;
        update.ready_to_send = false;
        update.raw_apollo_match = null;
        update.raw_hunter = null;
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
        email: null,
        email_source: null,
        email_pattern_used: null,
        email_status: null,
        email_verifier: null,
        email_verifier_score: null,
        email_verified_at: null,
        is_primary: wantsPrimary,
        ready_to_send: false,
        enrichment_state: "discovered",
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

  // 9. Determine the primary contact_id to enrich. Precedence:
  //      sticky existing primary (if surviving in the new candidate set) →
  //      new rank-1 candidate.
  //    The earlier sticky-primary-only branch had a bug: if the sticky
  //    primary was NOT in the new candidate set, `primaryCandidateIdx`
  //    stayed -1, enrichment was skipped, AND all 5 new candidates got
  //    `enrichment_deferred` including the new #1. Now we fall through to
  //    the rank-1 candidate from the new search so we always have a
  //    primary to auto-enrich when there are any candidates.
  let primaryId: string | null = null;
  let primaryCandidateIdx = -1;
  if (existingPrimary) {
    const stickyIdx = candidates.findIndex(
      (_, i) => candidateContactIds[i] === existingPrimary.id,
    );
    if (stickyIdx >= 0) {
      primaryId = existingPrimary.id;
      primaryCandidateIdx = stickyIdx;
    } else if (newPrimaryIdx >= 0) {
      // Sticky primary is no longer in the new candidate set — fall
      // through to the new rank-1 candidate.
      primaryId = candidateContactIds[newPrimaryIdx] ?? null;
      primaryCandidateIdx = newPrimaryIdx;
    }
  } else if (newPrimaryIdx >= 0) {
    primaryId = candidateContactIds[newPrimaryIdx] ?? null;
    primaryCandidateIdx = newPrimaryIdx;
  }

  // 10. Auto-enrich the primary (credit-burn). Other 4 get deferred event.
  //     Server-side idempotency: claim the row by transitioning
  //     discovered → enriching BEFORE calling apolloUnlockPerson. If
  //     another runContactDiscovery is somehow racing this same brand
  //     (parent code does not allow it, but cheap insurance), the second
  //     caller's claim returns no rows and we skip enrichment. The
  //     try/finally guarantees the row is flipped to 'enriched' or
  //     'error' — never left at 'enriching'.
  if (primaryId && primaryCandidateIdx >= 0) {
    const c = candidates[primaryCandidateIdx];
    const { data: claimed } = await admin
      .from("brand_contacts")
      .update({
        enrichment_state: "enriching",
        updated_at: new Date().toISOString(),
      })
      .eq("id", primaryId)
      .eq("brand_id", brandId)
      .eq("enrichment_state", "discovered")
      .select("id")
      .maybeSingle();
    if (claimed) {
      try {
        const enriched = await enrichSingleContact({
          brand_id: brandId,
          run_id: runId,
          contact_id: primaryId,
          domain,
          first_name: c.first_name,
          last_name: c.last_name,
          full_name: c.full_name,
          organization_name: c.organization_name,
          apollo_person_id: c.apollo_person_id,
        });
        // Phase 64 — surface update errors so a CHECK violation or
        // schema mismatch flips state to 'error' instead of leaving
        // the row stuck at 'enriching'. See the matching guard in
        // src/app/api/brands/[id]/contacts/[contactId]/enrich/route.ts.
        const { error: updateErr } = await admin
          .from("brand_contacts")
          .update({
            email: enriched.email,
            email_source: enriched.email ? enriched.email_source : null,
            email_pattern_used: enriched.email_pattern_used,
            email_status: enriched.email
              ? enriched.email_status
              : "not_found",
            email_verifier: enriched.email_verifier,
            email_verifier_score: enriched.email_verifier_score,
            email_verified_at: enriched.email_verified_at,
            last_name: enriched.last_name,
            full_name: enriched.full_name,
            raw_apollo_match: enriched.raw_apollo_match,
            raw_hunter: enriched.raw_hunter,
            ready_to_send: enriched.email_status === "verified",
            enrichment_state: "enriched",
            updated_at: new Date().toISOString(),
          })
          .eq("id", primaryId)
          .eq("brand_id", brandId);
        if (updateErr) {
          throw new Error(
            `brand_contacts update failed: ${(updateErr as { message?: string }).message ?? String(updateErr)}`,
          );
        }
      } catch (err) {
        await admin
          .from("brand_contacts")
          .update({
            enrichment_state: "error",
            updated_at: new Date().toISOString(),
          })
          .eq("id", primaryId)
          .eq("brand_id", brandId);
        await recordDiscoveryEvent({
          brand_id: brandId,
          run_id: runId,
          contact_id: primaryId,
          provider: "orchestrator",
          outcome: "error",
          reason: `Primary enrichment threw: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // 11. Defer enrichment for the non-primary 4: write one transparent
  //     audit event per row so the user understands why no email is
  //     populated yet.
  for (let i = 0; i < candidates.length; i += 1) {
    if (i === primaryCandidateIdx) continue;
    const cid = candidateContactIds[i];
    if (!cid) continue;
    const c = candidates[i];
    await recordDiscoveryEvent({
      brand_id: brandId,
      run_id: runId,
      contact_id: cid,
      provider: "enrichment_deferred",
      outcome: "skipped",
      reason: `Deferred enrichment for ${c.full_name} — click Enrich to spend an Apollo credit.`,
    });
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
