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
import { seedFromGateC, type GateCPersonSeed } from "./gate-c-seed";
import { verifyEmail } from "./email-verify";

const SEARCH_TITLES = ["founder", "ceo", "president", "owner"];

interface GateCJson {
  passed?: boolean;
  person?: {
    full_name?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    title?: string | null;
    linkedin_url?: string | null;
  } | null;
}

interface GateAJson {
  controlling_entity?: { domain?: string | null } | null;
}

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
    .select(
      "id, selected_entity, gate_c_named_decision_maker, gate_a_corporate_hierarchy",
    )
    .eq("brand_id", brandId)
    .maybeSingle<{
      id: string;
      selected_entity: { evidence_url?: string } | null;
      gate_c_named_decision_maker: GateCJson | null;
      gate_a_corporate_hierarchy: GateAJson | null;
    }>();

  const gateCJson = qual?.gate_c_named_decision_maker ?? null;
  const gateADomain =
    qual?.gate_a_corporate_hierarchy?.controlling_entity?.domain ?? null;
  const domain =
    extractDomain(brand.resolved_owner_domain) ||
    extractDomain(gateADomain) ||
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

  // 1b. Phase 71 — Gate C decision-maker seeding.
  //
  // When Gate C (Phase 68) named a specific human, that person is the
  // highest-confidence seed for enrichment. We attempt Apollo
  // /people/match keyed on LinkedIn URL → Apollo mixed_people/search
  // seeded with the Gate C title → Hunter email-finder. On a hit we
  // write the contact straight into brand_contacts (verified via MV)
  // and skip the generic founder/CEO title scan below. On a full miss
  // we log NEEDS_HUMAN_REVIEW so the Contact Strategy UI surfaces the
  // specific copy ("Gate C identified X but we couldn't find their
  // email via Apollo or Hunter").
  let gateCSeededPrimaryId: string | null = null;
  let gateCMissed = false;
  let gateCMissedReason: string | null = null;
  const gateCPerson: GateCPersonSeed | null =
    gateCJson?.passed === true && gateCJson?.person
      ? {
          full_name: gateCJson.person.full_name ?? null,
          first_name: gateCJson.person.first_name ?? null,
          last_name: gateCJson.person.last_name ?? null,
          title: gateCJson.person.title ?? null,
          linkedin_url: gateCJson.person.linkedin_url ?? null,
        }
      : null;

  if (gateCPerson) {
    const seed = await seedFromGateC(
      {
        person: gateCPerson,
        brand_name: brand.name,
        domain,
      },
      {
        // Phase 72 — surface linkedin_verify events into the discovery
        // audit trail. HEAD-verifying the Gate C LinkedIn URL before
        // Apollo lets us skip hallucinated slugs (Carna4's bogus
        // /in/maria-ringo-4a6b1b16) and fall back to name+org match.
        onLinkedInVerify: async ({ raw_url, normalized, ok, reason }) => {
          await recordDiscoveryEvent({
            brand_id: brandId,
            run_id: runId,
            provider: "linkedin_verify",
            outcome: ok ? "found" : "not_found",
            reason: ok
              ? `LinkedIn URL ${raw_url} verified (${reason}).`
              : `LinkedIn URL ${raw_url} did not verify: ${reason}.`,
            raw_payload: { raw_url, normalized, ok, reason },
          });
        },
        // Phase 72 — Hunter pattern-construction fallback events. Phase
        // 73 — also fires per-attempt during the 8-pattern loop and on
        // a summary `pattern_loop_complete` event.
        onHunterPattern: async ({
          pattern,
          pattern_confidence,
          constructed_email,
          mv_status,
          outcome,
          reason,
        }) => {
          await recordDiscoveryEvent({
            brand_id: brandId,
            run_id: runId,
            provider: "hunter_pattern",
            outcome,
            reason,
            email_returned: constructed_email,
            status_returned: mv_status,
            score_returned:
              typeof pattern_confidence === "number"
                ? pattern_confidence
                : null,
            raw_payload: {
              pattern,
              pattern_confidence,
              constructed_email,
              mv_status,
            },
          });
        },
        // Phase 73 — LLM web-search last-resort events. Fires when
        // Apollo + Hunter-finder + 8-pattern all miss and we ask an
        // LLM with web_search to look for a published email.
        onLlmWebSearch: async ({
          email,
          source_url,
          confidence,
          mv_status,
          outcome,
          reason,
        }) => {
          await recordDiscoveryEvent({
            brand_id: brandId,
            run_id: runId,
            provider: "llm_websearch",
            outcome,
            reason,
            email_returned: email,
            status_returned: mv_status,
            raw_payload: { email, source_url, confidence, mv_status },
          });
        },
      },
    );

    if (seed.provider === "needs_review") {
      gateCMissed = true;
      gateCMissedReason = seed.reason;
      await recordDiscoveryEvent({
        brand_id: brandId,
        run_id: runId,
        provider: "orchestrator",
        outcome: "not_found",
        reason: `gate_c_needs_review: ${seed.reason}`,
      });
    } else if (seed.person) {
      // Verify via MillionVerifier when we have an email.
      //
      // Phase 72 — the hunter_pattern seed step already MV-verified the
      // constructed email inline (per spec §3c) so we trust its mv_status
      // and skip the second verify call. For every other provider
      // (apollo_linkedin_match / apollo_mixed_search / hunter_finder),
      // run MV here as before.
      let verifyStatus: string | null = null;
      let verifyScore: number | null = null;
      let verifierName: "millionverifier" | "zerobounce" | "none" | null =
        null;
      let emailVerifiedAt: string | null = null;
      if (seed.provider === "hunter_pattern" && seed.hunter_pattern_meta) {
        verifyStatus = seed.hunter_pattern_meta.mv_status;
        verifierName = "millionverifier";
        emailVerifiedAt = new Date().toISOString();
        await recordDiscoveryEvent({
          brand_id: brandId,
          run_id: runId,
          provider: "millionverifier",
          outcome:
            verifyStatus === "verified"
              ? "found"
              : verifyStatus === "invalid"
                ? "not_found"
                : "skipped",
          reason: `MillionVerifier verdict ${verifyStatus} for ${seed.person.email} (hunter_pattern).`,
          status_returned: verifyStatus,
        });
      } else if (seed.provider === "llm_websearch" && seed.llm_websearch_meta) {
        // Phase 73 — LLM web-search already MV-verified inside the
        // seed. Trust its mv_status and skip the second verify call.
        verifyStatus = seed.llm_websearch_meta.mv_status;
        verifierName = "millionverifier";
        emailVerifiedAt = new Date().toISOString();
        await recordDiscoveryEvent({
          brand_id: brandId,
          run_id: runId,
          provider: "millionverifier",
          outcome:
            verifyStatus === "verified"
              ? "found"
              : verifyStatus === "invalid"
                ? "not_found"
                : "skipped",
          reason: `MillionVerifier verdict ${verifyStatus} for ${seed.person.email} (llm_websearch).`,
          status_returned: verifyStatus,
        });
      } else if (seed.person.email) {
        const v = await verifyEmail(seed.person.email).catch(() => null);
        if (v) {
          verifyStatus = v.status;
          verifyScore = typeof v.score === "number" ? v.score : null;
          verifierName = v.verifier;
          emailVerifiedAt = new Date().toISOString();
          await recordDiscoveryEvent({
            brand_id: brandId,
            run_id: runId,
            provider: "millionverifier",
            outcome:
              v.status === "verified" || v.status === "likely"
                ? "found"
                : v.status === "invalid"
                  ? "not_found"
                  : "skipped",
            reason: `MillionVerifier verdict ${v.status} for ${seed.person.email}.`,
            status_returned: v.status,
            score_returned:
              typeof v.score === "number" ? v.score : null,
          });
        }
      }

      // Phase 65 — trust the bounce signal: downgrade to invalid when
      // MillionVerifier said so.
      const isVerified = verifyStatus === "verified";
      const finalStatus =
        verifyStatus === "verified"
          ? "verified"
          : verifyStatus === "likely"
            ? "likely"
            : verifyStatus === "invalid"
              ? "invalid"
              : verifyStatus === "risky"
                ? "risky"
                : verifyStatus === "catch_all"
                  ? "catch_all"
                  : seed.person.email
                    ? "unknown"
                    : "unknown";

      const fullName =
        (seed.person.name ??
          `${seed.person.first_name ?? ""} ${seed.person.last_name ?? ""}`.trim()) ||
        gateCPerson.full_name ||
        "(unnamed)";

      // Sticky-merge protection — Phase 47/61 invariant: rows with
      // `email_source='manual'` OR `ready_to_send=true` are user-pinned
      // and survive re-discovery. Look up any existing sticky primary
      // before we touch is_primary on anything; if one exists for a
      // DIFFERENT person, the new Gate C row goes in as is_primary=false
      // so we don't clobber the user's pin.
      const { data: existingRowsForBrand } = await admin
        .from("brand_contacts")
        .select("id, full_name, email_source, is_primary, ready_to_send")
        .eq("brand_id", brandId);
      const existingList = (existingRowsForBrand ?? []) as Array<{
        id: string;
        full_name: string | null;
        email_source: string | null;
        is_primary: boolean | null;
        ready_to_send: boolean | null;
      }>;
      const stickyPrimary = existingList.find(
        (r) =>
          r.is_primary === true &&
          (r.email_source === "manual" || r.ready_to_send === true),
      );
      const stickyPrimaryMatchesGateC =
        !!stickyPrimary &&
        (stickyPrimary.full_name ?? "").trim().toLowerCase() ===
          fullName.trim().toLowerCase();

      // Demote existing primaries — but NEVER touch user-pinned rows
      // (manual or ready_to_send=true).
      await admin
        .from("brand_contacts")
        .update({ is_primary: false, updated_at: new Date().toISOString() })
        .eq("brand_id", brandId)
        .neq("email_source", "manual")
        .neq("ready_to_send", true);

      // Sticky-merge: prefer updating an existing row that matches by
      // full_name (case-insensitive) so we don't duplicate the row.
      const existingForName =
        existingList.find(
          (r) =>
            (r.full_name ?? "").trim().toLowerCase() ===
            fullName.trim().toLowerCase(),
        ) ?? null;

      // Promote the Gate C row to primary only when no sticky-pinned
      // OTHER person owns the slot already. If the sticky primary is
      // the same Gate C person, we still want is_primary=true (which
      // it already is on the sticky row).
      //
      // Phase 72 — Hunter pattern-constructed rows: only the verified
      // (MV='ok') variant goes in as is_primary=true. Risky / catch_all
      // rows go in as is_primary=false so the Phase 70 OUTREACH picker
      // (which filters by email_status='verified') hides them.
      let wantPrimary = !stickyPrimary || stickyPrimaryMatchesGateC;
      if (seed.provider === "hunter_pattern" && seed.hunter_pattern_meta) {
        wantPrimary = wantPrimary && seed.hunter_pattern_meta.is_primary;
      }
      if (seed.provider === "llm_websearch" && seed.llm_websearch_meta) {
        wantPrimary = wantPrimary && seed.llm_websearch_meta.is_primary;
      }

      // Phase 72/73 — fallback rows carry a transparent note so the
      // reviewer can see the email was constructed (hunter_pattern) or
      // discovered via LLM web search.
      const seedNotes =
        seed.provider === "hunter_pattern" && seed.hunter_pattern_meta
          ? seed.hunter_pattern_meta.notes
          : seed.provider === "llm_websearch" && seed.llm_websearch_meta
            ? seed.llm_websearch_meta.notes
            : null;

      const baseFields: Record<string, unknown> = {
        brand_id: brandId,
        qualification_id: qual?.id ?? null,
        full_name: fullName,
        first_name: seed.person.first_name ?? gateCPerson.first_name,
        last_name: seed.person.last_name ?? gateCPerson.last_name,
        title: seed.person.title ?? gateCPerson.title,
        linkedin_url: seed.person.linkedin_url ?? gateCPerson.linkedin_url,
        company_domain: domain,
        apollo_person_id:
          seed.person.id?.startsWith("hunter:") ||
          seed.person.id?.startsWith("hunter_pattern:") ||
          seed.person.id?.startsWith("llm_websearch:")
            ? null
            : seed.person.id || null,
        email: seed.person.email,
        email_source: seed.person.email ? seed.email_source : null,
        email_status: finalStatus,
        email_verifier: verifierName,
        email_verifier_score: verifyScore,
        email_verified_at: emailVerifiedAt,
        is_primary: wantPrimary,
        ready_to_send: isVerified,
        enrichment_state: "enriched",
        raw_apollo_match: seed.person,
        updated_at: new Date().toISOString(),
        ...(seedNotes ? { notes: seedNotes } : {}),
      };

      if (existingForName?.id) {
        // Existing row matches Gate C person by name. If that row is
        // user-pinned (manual or ready_to_send), do NOT overwrite the
        // user-edited fields — only refresh metadata + enrichment state.
        const existingIsSticky =
          existingForName.email_source === "manual" ||
          existingForName.ready_to_send === true;
        const updateFields: Record<string, unknown> = existingIsSticky
          ? {
              full_name: fullName,
              first_name: baseFields.first_name,
              last_name: baseFields.last_name,
              title: baseFields.title,
              linkedin_url: baseFields.linkedin_url,
              company_domain: baseFields.company_domain,
              apollo_person_id: baseFields.apollo_person_id,
              raw_apollo_match: baseFields.raw_apollo_match,
              enrichment_state: "enriched",
              updated_at: baseFields.updated_at,
            }
          : baseFields;
        const { data: upd } = await admin
          .from("brand_contacts")
          .update(updateFields)
          .eq("id", existingForName.id)
          .eq("brand_id", brandId)
          .select("id")
          .maybeSingle();
        gateCSeededPrimaryId = upd?.id ?? null;
      } else {
        const { data: ins } = await admin
          .from("brand_contacts")
          .insert(baseFields)
          .select("id")
          .maybeSingle();
        gateCSeededPrimaryId = ins?.id ?? null;
      }

      // Telemetry: provider+reason per spec.
      const eventProvider =
        seed.provider === "apollo_linkedin_match" ||
        seed.provider === "apollo_mixed_search"
          ? "apollo_match"
          : seed.provider === "hunter_pattern"
            ? "hunter_pattern"
            : seed.provider === "llm_websearch"
              ? "llm_websearch"
              : "hunter_finder";
      const eventReason =
        seed.provider === "apollo_linkedin_match"
          ? "gate_c_linkedin_match"
          : seed.provider === "apollo_mixed_search"
            ? "gate_c_mixed_search"
            : seed.provider === "hunter_pattern"
              ? "gate_c_hunter_pattern"
              : seed.provider === "llm_websearch"
                ? "gate_c_llm_websearch"
                : "gate_c_hunter_finder";
      await recordDiscoveryEvent({
        brand_id: brandId,
        run_id: runId,
        contact_id: gateCSeededPrimaryId,
        provider: eventProvider,
        outcome: seed.person.email ? "found" : "not_found",
        reason: `${eventReason}: ${fullName}${seed.person.title ? ` (${seed.person.title})` : ""}.`,
        email_returned: seed.person.email ?? null,
      });

      // Skip the generic founder/CEO scan: the Gate C person IS the
      // primary, and we don't silently fall back to title-scanning per
      // Phase 71 spec.
      await admin
        .from("brands")
        .update({
          contacts_state: "complete",
          updated_at: new Date().toISOString(),
        })
        .eq("id", brandId);
      return {
        ok: true,
        state: "complete",
        contact_count: 1,
        primary_id: gateCSeededPrimaryId,
        run_id: runId,
      };
    }
  }

  // Phase 71 — When Gate C found a person but Apollo+Hunter all missed
  // their email, surface NEEDS_HUMAN_REVIEW. Do NOT silently fall back
  // to a generic CEO/founder title scan.
  if (gateCMissed) {
    await admin
      .from("brands")
      .update({
        contacts_state: "complete",
        updated_at: new Date().toISOString(),
      })
      .eq("id", brandId);
    return {
      ok: true,
      state: "complete",
      contact_count: 0,
      primary_id: null,
      run_id: runId,
      error: gateCMissedReason ?? undefined,
    };
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
