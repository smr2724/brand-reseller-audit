/**
 * Phase 33 / 34 / 34.2 — Brand Owner Resolver orchestrator.
 *
 * Phase 34.2 splits the pipeline at a transparency checkpoint:
 *
 *   pending
 *     -> running                    (USPTO + web + extractor)
 *     -> awaiting_apollo_selection  (user reviews extractor candidates)
 *     -> enriching_apollo           (selected candidates -> Apollo)
 *     -> candidates_ready
 *     -> selected
 *
 * `resolveBrandOwner` runs Phase 1 only (USPTO + web + extractor) and
 * stops at `awaiting_apollo_selection`. Apollo enrichment is now driven
 * by `enrichSelectedCandidatesWithApollo`, called from
 * `/api/owner-resolver/run-apollo` after the user picks which candidates
 * to look up.
 *
 * Phase 1 inserts the extractor candidates as `extractor` rows (Apollo
 * fields NULL). Phase 2 inserts new `apollo` rows linked back to the
 * originating extractor via `derived_from_candidate_id`, or stamps the
 * extractor row's `apollo_search_attempted_at` when no Apollo hits were
 * found (so the UI can show "we tried Apollo and got nothing" without
 * losing the original extractor candidate).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { searchUsptoTrademarks } from "./uspto";
import { searchWebForOwners } from "./web-search";
import { scoreCandidates } from "./heuristic-scoring";
import {
  extractOwnerCandidates,
  buildExtractorHitsFromCandidates,
  buildUsptoEvidence,
  type ExtractedCandidate,
} from "./extractor-openai";
import {
  createApolloClient,
  type ApolloAuditEntry,
  type ApolloClient,
  type ApolloOrganization,
  type ApolloSearchTier,
} from "./apollo-client";
import type {
  BrandContext,
  OwnerResolutionTrigger,
  RawOwnerCandidate,
} from "./types";
import type { PerQueryAnswer } from "./web-search-types";

export interface ResolveBrandOwnerOptions {
  triggered_by: OwnerResolutionTrigger;
  /** Override adapters — used by tests. */
  usptoFn?: typeof searchUsptoTrademarks;
  webSearchFn?: typeof searchWebForOwners;
  /** Override the extractor — used by tests. */
  extractorFn?: typeof extractOwnerCandidates;
  /** Bypass CAS guard — used by tests. */
  skipCasGuard?: boolean;
}

export interface ResolveBrandOwnerResult {
  ok: boolean;
  run_id: string | null;
  candidates_count: number;
  top_score: number | null;
  state:
    | "awaiting_apollo_selection"
    | "candidates_ready"
    | "failed"
    | "skipped";
  error?: string;
  /** Extractor candidate count (Phase 1). Apollo counts come later. */
  extractor_candidate_count?: number;
}

const TOP_PRODUCT_TITLE_LIMIT = 20;

interface ClaimedBrand {
  brand_id: string;
  brand_name: string;
  category: string | null;
}

async function claimBrand(
  admin: SupabaseClient,
  brandId: string,
): Promise<ClaimedBrand | null> {
  const { data, error } = await admin.rpc("claim_owner_resolution_run", {
    p_brand_id: brandId,
  });
  if (error) {
    console.warn("[owner-resolver] claim RPC failed", error.message);
    return null;
  }
  const rows = (data ?? []) as Array<{
    claimed: boolean;
    brand_id: string | null;
    brand_name: string | null;
    category: string | null;
  }>;
  const row = rows[0];
  if (!row || !row.claimed || !row.brand_id) return null;
  return {
    brand_id: row.brand_id,
    brand_name: row.brand_name ?? "",
    category: row.category ?? null,
  };
}

async function loadProductTitles(
  admin: SupabaseClient,
  brandId: string,
): Promise<string[]> {
  const { data: asins } = await admin
    .from("brand_asins")
    .select("title")
    .eq("brand_id", brandId)
    .limit(TOP_PRODUCT_TITLE_LIMIT);
  const titles: string[] = [];
  for (const row of (asins ?? []) as Array<{ title?: string | null }>) {
    if (row && typeof row.title === "string" && row.title.trim().length > 0) {
      titles.push(row.title.trim());
    }
  }
  return titles;
}

function dedupeRawCandidates(
  candidates: ReadonlyArray<RawOwnerCandidate>,
): RawOwnerCandidate[] {
  const seen = new Map<string, RawOwnerCandidate>();
  for (const c of candidates) {
    const name = (c.candidate_company_name ?? "").trim().toLowerCase();
    const dom = (c.candidate_domain ?? "").trim().toLowerCase();
    if (!name) continue;
    const key = `${name}|${dom}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, c);
      continue;
    }
    if (existing.candidate_source !== "uspto" && c.candidate_source === "uspto") {
      seen.set(key, { ...c, candidate_domain: existing.candidate_domain ?? c.candidate_domain });
    } else if (!existing.candidate_domain && c.candidate_domain) {
      seen.set(key, { ...existing, candidate_domain: c.candidate_domain });
    }
  }
  return Array.from(seen.values());
}

interface PersistedExtractorRow {
  brand_id: string;
  resolution_run_id: string;
  candidate_company_name: string;
  candidate_domain: string | null;
  candidate_source: "extractor";
  evidence_text: string | null;
  evidence_url: string | null;
  match_reason: string | null;
  trademark_serial_number: null;
  trademark_status: null;
  trademark_registration_date: null;
  trademark_owner_address: null;
  goods_services_text: null;
  heuristic_score: number;
  heuristic_label: string;
  needs_manual_review: boolean;
  raw_payload: unknown;
  apollo_organization_id: null;
  apollo_organization_name: null;
  apollo_domain: null;
  apollo_employee_count: null;
  apollo_total_contacts: null;
  apollo_hq_city: null;
  apollo_hq_country: null;
  apollo_industry: null;
  extractor_confidence: number | null;
  extractor_reasoning: string | null;
  evidence_urls: string[] | null;
}

function buildExtractorRow(
  brandId: string,
  runId: string,
  extracted: ExtractedCandidate,
): PersistedExtractorRow {
  return {
    brand_id: brandId,
    resolution_run_id: runId,
    candidate_company_name: extracted.canonical_company_name,
    candidate_domain: extracted.domain,
    candidate_source: "extractor",
    evidence_text: extracted.reasoning || null,
    evidence_url: extracted.evidence_urls[0] ?? null,
    match_reason: "Extractor candidate (awaiting Apollo lookup)",
    trademark_serial_number: null,
    trademark_status: null,
    trademark_registration_date: null,
    trademark_owner_address: null,
    goods_services_text: null,
    heuristic_score: 0,
    heuristic_label: "unscored",
    needs_manual_review: false,
    raw_payload: { extracted },
    apollo_organization_id: null,
    apollo_organization_name: null,
    apollo_domain: null,
    apollo_employee_count: null,
    apollo_total_contacts: null,
    apollo_hq_city: null,
    apollo_hq_country: null,
    apollo_industry: null,
    extractor_confidence: extracted.confidence,
    extractor_reasoning: extracted.reasoning || null,
    evidence_urls: extracted.evidence_urls,
  };
}

interface PersistedApolloMatchRow {
  brand_id: string;
  resolution_run_id: string;
  candidate_company_name: string;
  candidate_domain: string | null;
  candidate_source: "apollo" | "apollo_crm";
  evidence_text: string | null;
  evidence_url: string | null;
  match_reason: string | null;
  trademark_serial_number: null;
  trademark_status: null;
  trademark_registration_date: null;
  trademark_owner_address: null;
  goods_services_text: null;
  heuristic_score: number;
  heuristic_label: string;
  needs_manual_review: boolean;
  raw_payload: unknown;
  apollo_organization_id: string | null;
  apollo_organization_name: string | null;
  apollo_domain: string | null;
  apollo_employee_count: number | null;
  apollo_total_contacts: number | null;
  apollo_hq_city: string | null;
  apollo_hq_country: string | null;
  apollo_industry: string | null;
  extractor_confidence: number | null;
  extractor_reasoning: string | null;
  evidence_urls: string[] | null;
  derived_from_candidate_id: string | null;
}

function buildApolloRow(
  brandId: string,
  runId: string,
  extractorRow: ExtractorCandidateRow,
  org: ApolloOrganization,
  totalContacts: number | null,
  tierUsed: ApolloSearchTier | null,
): PersistedApolloMatchRow {
  const tierSuffix = tierUsed ? ` (tier=${tierUsed})` : "";
  const sourceSuffix =
    org.apollo_source === "crm" ? " [Your Apollo CRM]" : "";
  // Phase 34.4 — Distinct `candidate_source` for CRM hits so the
  // (run_id, name, domain, source) unique index doesn't reject the
  // second insert when the same org surfaces from both
  // `mixed_companies/search` (public) and `accounts/search` (CRM).
  const candidateSource: "apollo" | "apollo_crm" =
    org.apollo_source === "crm" ? "apollo_crm" : "apollo";
  return {
    brand_id: brandId,
    resolution_run_id: runId,
    candidate_company_name: org.name,
    candidate_domain: org.primary_domain,
    candidate_source: candidateSource,
    evidence_text: extractorRow.extractor_reasoning,
    evidence_url:
      Array.isArray(extractorRow.evidence_urls) &&
      extractorRow.evidence_urls.length > 0
        ? extractorRow.evidence_urls[0] ?? null
        : null,
    match_reason: `Apollo match for "${extractorRow.candidate_company_name}"${tierSuffix}${sourceSuffix}`,
    trademark_serial_number: null,
    trademark_status: null,
    trademark_registration_date: null,
    trademark_owner_address: null,
    goods_services_text: null,
    heuristic_score: 0,
    heuristic_label: "unscored",
    needs_manual_review: false,
    // Phase 34.3 — `apollo_source` rides in raw_payload (no migration
    // needed). The candidates GET endpoint surfaces raw_payload so the
    // UI can read this and render the right "Your Apollo CRM" /
    // "Apollo Public" badge.
    raw_payload: {
      source_candidate_id: extractorRow.id,
      apollo: org,
      apollo_source: org.apollo_source,
      tier_used: tierUsed,
    },
    apollo_organization_id: org.id,
    apollo_organization_name: org.name,
    apollo_domain: org.primary_domain,
    apollo_employee_count: org.estimated_num_employees,
    apollo_total_contacts: totalContacts,
    apollo_hq_city: org.organization_city,
    apollo_hq_country: org.organization_country,
    apollo_industry: org.industry,
    extractor_confidence: extractorRow.extractor_confidence,
    extractor_reasoning: extractorRow.extractor_reasoning,
    evidence_urls: extractorRow.evidence_urls ?? null,
    derived_from_candidate_id: extractorRow.id,
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

export async function resolveBrandOwner(
  admin: SupabaseClient,
  brandId: string,
  opts: ResolveBrandOwnerOptions,
): Promise<ResolveBrandOwnerResult> {
  const usptoFn = opts.usptoFn ?? searchUsptoTrademarks;
  const webSearchFn = opts.webSearchFn ?? searchWebForOwners;
  const extractorFn = opts.extractorFn ?? extractOwnerCandidates;

  // 1. Atomic CAS claim — bail out if another runner already owns the brand.
  let claimed: ClaimedBrand | null;
  if (opts.skipCasGuard) {
    const { data } = await admin
      .from("brands")
      .select("id, name, category")
      .eq("id", brandId)
      .maybeSingle();
    if (!data) {
      return {
        ok: false,
        run_id: null,
        candidates_count: 0,
        top_score: null,
        state: "failed",
        error: "brand not found",
      };
    }
    claimed = {
      brand_id: (data as { id: string }).id,
      brand_name: String((data as { name: string }).name ?? ""),
      category: ((data as { category?: string | null }).category ?? null),
    };
  } else {
    claimed = await claimBrand(admin, brandId);
    if (!claimed) {
      return {
        ok: false,
        run_id: null,
        candidates_count: 0,
        top_score: null,
        state: "skipped",
        error: "owner-resolution already running or brand missing",
      };
    }
  }

  // 2. Insert run row.
  const { data: runRow, error: runErr } = await admin
    .from("owner_resolution_runs")
    .insert({
      brand_id: brandId,
      triggered_by: opts.triggered_by,
      status: "running",
    })
    .select("id")
    .single();
  if (runErr || !runRow) {
    await admin
      .from("brands")
      .update({
        owner_resolution_state: "failed",
        owner_resolution_error: runErr?.message ?? "failed to create resolution run",
      })
      .eq("id", brandId);
    return {
      ok: false,
      run_id: null,
      candidates_count: 0,
      top_score: null,
      state: "failed",
      error: runErr?.message ?? "failed to create resolution run",
    };
  }
  const runId = (runRow as { id: string }).id;

  // 3. Load product titles and run adapters.
  const productTitles = await loadProductTitles(admin, brandId);
  const brandContext: BrandContext = {
    brand_id: claimed.brand_id,
    brand_name: claimed.brand_name,
    category: claimed.category,
    product_titles: productTitles,
  };

  const [usptoResult, webResult] = await Promise.all([
    safeUspto(brandContext.brand_name, usptoFn),
    safeWebSearch(brandContext.brand_name, webSearchFn),
  ]);

  // 4. Heuristic scoring on raw hits — kept for logs / debugging only.
  const merged = dedupeRawCandidates([
    ...usptoResult.candidates,
    ...webResult.candidates,
  ]);
  const scored = scoreCandidates(merged, brandContext);
  if (scored.length > 0) {
    const heuristicTopScore = scored.reduce(
      (m, c) => (c.heuristic_score > m ? c.heuristic_score : m),
      scored[0]!.heuristic_score,
    );
    console.log(
      `[owner-resolver] brand=${brandId} run=${runId} heuristic sanity check: ${scored.length} raw candidates, top score=${heuristicTopScore}`,
    );
  }

  // 5. Run extractor over the merged raw hits + USPTO TSDR evidence +
  // per-query answer prose.
  const extractorHits = buildExtractorHitsFromCandidates(merged);
  const usptoEvidence = buildUsptoEvidence(usptoResult.candidates);
  const extractorResult = await safeExtractor(
    brandContext.brand_name,
    brandContext.category,
    extractorHits,
    extractorFn,
    usptoEvidence,
    webResult.per_query_answers ?? [],
  );

  // 6. Persist extractor candidates as `extractor` rows (Apollo fields
  // remain NULL). Phase 34.2 stops here and waits for the user to choose.
  const extractorRows: PersistedExtractorRow[] = extractorResult.candidates.map(
    (c) => buildExtractorRow(brandId, runId, c),
  );

  let insertedCount = 0;
  let persistError: string | null = null;
  if (extractorRows.length > 0) {
    try {
      const { error: insErr, count } = await admin
        .from("owner_candidates")
        .insert(extractorRows, { count: "exact" });
      if (insErr) {
        persistError = `Failed to persist extractor candidates: ${insErr.message}`;
      } else {
        insertedCount = count ?? extractorRows.length;
        if (insertedCount < extractorRows.length) {
          persistError = `Persisted ${insertedCount}/${extractorRows.length} extractor candidates`;
        }
      }
    } catch (e) {
      persistError = `Failed to persist extractor candidates: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // 7. Determine final state.
  const bothFailed = usptoResult.error != null && webResult.error != null;
  const noExtractedCandidates = extractorResult.candidates.length === 0;
  let finalState: "awaiting_apollo_selection" | "failed";
  let errorMessage: string | null = null;
  if (persistError) {
    finalState = "failed";
    errorMessage = truncate(persistError, 1000);
  } else if (bothFailed && noExtractedCandidates) {
    finalState = "failed";
    errorMessage = [usptoResult.error, webResult.error]
      .filter(Boolean)
      .join("; ");
  } else if (noExtractedCandidates) {
    finalState = "failed";
    errorMessage =
      extractorResult.error != null
        ? `extractor failed: ${extractorResult.error}`
        : "extractor produced no candidates above confidence threshold";
  } else {
    finalState = "awaiting_apollo_selection";
    errorMessage = null;
  }

  // 8. Persist run row.
  await admin
    .from("owner_resolution_runs")
    .update({
      // Phase 34.2: Phase 1 success leaves the run as `running` (Apollo
      // step still pending). The run is only marked `succeeded` after
      // Apollo enrichment lands. Failed-at-extractor still marks failed.
      status: finalState === "failed" ? "failed" : "running",
      completed_at: finalState === "failed" ? new Date().toISOString() : null,
      error_message: errorMessage,
      uspto_query: usptoResult.query,
      uspto_results_count: usptoResult.results_count,
      web_search_queries: webResult.queries,
      web_search_results_count: webResult.results_count,
      raw_uspto_payload: usptoResult.raw,
      raw_web_search_payload: webResult.raw,
      candidates_inserted: insertedCount,
    })
    .eq("id", runId);

  await admin
    .from("brands")
    .update({
      owner_resolution_state: finalState,
      owner_resolution_error: persistError
        ? `Candidate persist failed (run ${runId}) — check run row for details`
        : errorMessage,
    })
    .eq("id", brandId);

  if (persistError) {
    throw new Error(persistError);
  }

  return {
    ok: finalState === "awaiting_apollo_selection",
    run_id: runId,
    candidates_count: insertedCount,
    top_score: null,
    state: finalState,
    error: errorMessage ?? undefined,
    extractor_candidate_count: extractorResult.candidates.length,
  };
}

// ---------------------------------------------------------------------------
// Phase 34.2 — Apollo enrichment phase, called from
// /api/owner-resolver/run-apollo after the user selects which extractor
// candidates to look up.

export interface ExtractorCandidateRow {
  id: string;
  brand_id: string;
  resolution_run_id: string;
  candidate_company_name: string;
  candidate_domain: string | null;
  extractor_confidence: number | null;
  extractor_reasoning: string | null;
  evidence_urls: string[] | null;
}

export interface EnrichApolloOptions {
  apolloClient?: ApolloClient | null;
}

export interface EnrichApolloResult {
  ok: boolean;
  inserted_apollo_count: number;
  no_match_count: number;
  audit_entries: ApolloAuditEntry[];
  error?: string;
}

/**
 * Run Apollo's 3-tier search for each selected extractor candidate, INSERT
 * matching organizations as `apollo` rows, and stamp
 * `apollo_search_attempted_at` on the source extractor row when no hits.
 */
export async function enrichSelectedCandidatesWithApollo(
  admin: SupabaseClient,
  brandId: string,
  runId: string,
  candidates: ReadonlyArray<ExtractorCandidateRow>,
  opts: EnrichApolloOptions = {},
): Promise<EnrichApolloResult> {
  const apollo =
    opts.apolloClient !== undefined ? opts.apolloClient : createApolloClient();
  const auditEntries: ApolloAuditEntry[] = [];

  if (!apollo) {
    const nowIso = new Date().toISOString();
    for (const c of candidates) {
      await admin
        .from("owner_candidates")
        .update({ apollo_search_attempted_at: nowIso })
        .eq("id", c.id);
    }
    return {
      ok: true,
      inserted_apollo_count: 0,
      no_match_count: candidates.length,
      audit_entries: auditEntries,
      error: "APOLLO_API_KEY not configured",
    };
  }

  const apolloRowsToInsert: PersistedApolloMatchRow[] = [];
  // Phase 34.3 — Dedupe key combines id+source so the same company
  // surfacing in BOTH `accounts/search` (CRM) and `mixed_companies/search`
  // (public) yields TWO rows. The user picks which one is the right
  // owner.
  const seenApolloIds = new Set<string>();
  let inserted = 0;
  let noMatch = 0;

  for (const c of candidates) {
    const tiered = await apollo.searchOrganizationsTiered(
      c.candidate_company_name,
      c.candidate_domain ?? null,
    );
    const orgs = tiered.orgs;
    if (orgs.length === 0) {
      // Stamp attempted_at on the extractor row so the UI can show
      // "we tried Apollo and got nothing" — but keep the source row.
      await admin
        .from("owner_candidates")
        .update({ apollo_search_attempted_at: new Date().toISOString() })
        .eq("id", c.id);
      noMatch += 1;
      continue;
    }
    let appendedAnyForExt = false;
    for (const org of orgs) {
      const dedupeKey = `${org.id}|${org.apollo_source}`;
      if (seenApolloIds.has(dedupeKey)) continue;
      seenApolloIds.add(dedupeKey);
      const total = await apollo.countContacts(org.id);
      apolloRowsToInsert.push(
        buildApolloRow(brandId, runId, c, org, total, tiered.tier_used),
      );
      inserted += 1;
      appendedAnyForExt = true;
    }
    // Stamp attempted_at regardless so we can show "Apollo tried" badge.
    await admin
      .from("owner_candidates")
      .update({ apollo_search_attempted_at: new Date().toISOString() })
      .eq("id", c.id);
    if (!appendedAnyForExt) {
      noMatch += 1;
    }
  }

  if (apolloRowsToInsert.length > 0) {
    // Phase 34.4 — Defensive: even with the relaxed unique index that
    // includes `candidate_source`, a single tier can return the same
    // org twice (or two tiers can). Use upsert with ignoreDuplicates so
    // surplus rows are silently dropped instead of crashing the run.
    const { error: insErr } = await admin
      .from("owner_candidates")
      .upsert(apolloRowsToInsert, {
        onConflict:
          "resolution_run_id,candidate_company_name,candidate_domain,candidate_source",
        ignoreDuplicates: true,
      });
    if (insErr) {
      auditEntries.push(...apollo.rawAuditEntries());
      return {
        ok: false,
        inserted_apollo_count: 0,
        no_match_count: noMatch,
        audit_entries: auditEntries,
        error: `Failed to insert apollo rows: ${insErr.message}`,
      };
    }
  }

  auditEntries.push(...apollo.rawAuditEntries());
  return {
    ok: true,
    inserted_apollo_count: inserted,
    no_match_count: noMatch,
    audit_entries: auditEntries,
  };
}

interface UsptoSafeResult {
  candidates: RawOwnerCandidate[];
  raw: unknown;
  query: string | null;
  results_count: number;
  error: string | null;
}

interface WebSafeResult {
  candidates: RawOwnerCandidate[];
  raw: unknown;
  queries: string[];
  results_count: number;
  error: string | null;
  per_query_answers: PerQueryAnswer[];
}

interface ExtractorSafeResult {
  candidates: ExtractedCandidate[];
  raw: unknown;
  error: string | null;
}

async function safeUspto(
  brandName: string,
  fn: typeof searchUsptoTrademarks,
): Promise<UsptoSafeResult> {
  try {
    const r = await fn(brandName);
    return {
      candidates: r.candidates,
      raw: r.raw,
      query: r.query,
      results_count: r.results_count,
      error: r.error,
    };
  } catch (e) {
    return {
      candidates: [],
      raw: null,
      query: null,
      results_count: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function safeWebSearch(
  brandName: string,
  fn: typeof searchWebForOwners,
): Promise<WebSafeResult> {
  try {
    const r = await fn(brandName);
    return {
      candidates: r.candidates,
      raw: r.raw,
      queries: r.queries,
      results_count: r.results_count,
      error: r.error,
      per_query_answers: r.per_query_answers ?? [],
    };
  } catch (e) {
    return {
      candidates: [],
      raw: null,
      queries: [],
      results_count: 0,
      error: e instanceof Error ? e.message : String(e),
      per_query_answers: [],
    };
  }
}

async function safeExtractor(
  brandName: string,
  category: string | null,
  hits: Parameters<typeof extractOwnerCandidates>[2],
  fn: typeof extractOwnerCandidates,
  usptoEvidence: Parameters<typeof extractOwnerCandidates>[4],
  perQueryAnswers: Parameters<typeof extractOwnerCandidates>[5],
): Promise<ExtractorSafeResult> {
  try {
    const r = await fn(brandName, category, hits, {}, usptoEvidence, perQueryAnswers);
    return {
      candidates: r.candidates,
      raw: r.raw,
      error: r.error,
    };
  } catch (e) {
    return {
      candidates: [],
      raw: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
