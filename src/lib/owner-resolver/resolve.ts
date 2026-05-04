/**
 * Phase 33 / 34 — Brand Owner Resolver orchestrator.
 *
 * Phase 33 pipeline:
 *   1. CAS-claim the brand.
 *   2. Insert an owner_resolution_runs row (status=running).
 *   3. Run USPTO + web-search adapters in parallel (soft-fail).
 *   4. Score candidates with the deterministic heuristic (kept for logging /
 *      sanity checks only — not persisted in Phase 34).
 *
 * Phase 34 additions:
 *   5. Feed all raw hits to the OpenAI reasoning extractor (gpt-5-mini) to
 *      get up to 3 canonical owner candidates with confidence + reasoning.
 *   6. For each canonical candidate, look it up in Apollo (org search) and
 *      count contacts. Dedupe Apollo orgs across candidates.
 *   7. Insert one row per Apollo org found. For canonical candidates with
 *      no Apollo match, insert one apollo_no_match row.
 *   8. If extractor returns 0 candidates, mark the run failed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { searchUsptoTrademarks } from "./uspto";
import { searchWebForOwners } from "./web-search";
import { scoreCandidates } from "./heuristic-scoring";
import {
  extractOwnerCandidates,
  buildExtractorHitsFromCandidates,
  type ExtractedCandidate,
} from "./extractor-openai";
import {
  createApolloClient,
  type ApolloClient,
  type ApolloOrganization,
} from "./apollo-client";
import type {
  BrandContext,
  OwnerResolutionTrigger,
  RawOwnerCandidate,
} from "./types";

export interface ResolveBrandOwnerOptions {
  triggered_by: OwnerResolutionTrigger;
  /** Override adapters — used by tests. */
  usptoFn?: typeof searchUsptoTrademarks;
  webSearchFn?: typeof searchWebForOwners;
  /** Override the extractor — used by tests. */
  extractorFn?: typeof extractOwnerCandidates;
  /** Override the Apollo client factory — used by tests. */
  apolloClient?: ApolloClient | null;
  /** Bypass CAS guard — used by tests. */
  skipCasGuard?: boolean;
}

export interface ResolveBrandOwnerResult {
  ok: boolean;
  run_id: string | null;
  candidates_count: number;
  top_score: number | null;
  state: "candidates_ready" | "failed" | "skipped";
  error?: string;
  apollo_match_count?: number;
  apollo_no_match_count?: number;
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

interface PersistedApolloMatchRow {
  brand_id: string;
  resolution_run_id: string;
  candidate_company_name: string;
  candidate_domain: string | null;
  candidate_source: "apollo" | "apollo_no_match";
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
}

function buildApolloRow(
  brandId: string,
  runId: string,
  extracted: ExtractedCandidate,
  org: ApolloOrganization,
  totalContacts: number | null,
): PersistedApolloMatchRow {
  return {
    brand_id: brandId,
    resolution_run_id: runId,
    candidate_company_name: org.name,
    candidate_domain: org.primary_domain,
    candidate_source: "apollo",
    evidence_text: extracted.reasoning || null,
    evidence_url: extracted.evidence_urls[0] ?? null,
    match_reason: `Apollo match for "${extracted.canonical_company_name}"`,
    trademark_serial_number: null,
    trademark_status: null,
    trademark_registration_date: null,
    trademark_owner_address: null,
    goods_services_text: null,
    heuristic_score: 0,
    heuristic_label: "unscored",
    needs_manual_review: false,
    raw_payload: { extracted, apollo: org },
    apollo_organization_id: org.id,
    apollo_organization_name: org.name,
    apollo_domain: org.primary_domain,
    apollo_employee_count: org.estimated_num_employees,
    apollo_total_contacts: totalContacts,
    apollo_hq_city: org.organization_city,
    apollo_hq_country: org.organization_country,
    apollo_industry: org.industry,
    extractor_confidence: extracted.confidence,
    extractor_reasoning: extracted.reasoning || null,
    evidence_urls: extracted.evidence_urls,
  };
}

function buildNoMatchRow(
  brandId: string,
  runId: string,
  extracted: ExtractedCandidate,
): PersistedApolloMatchRow {
  return {
    brand_id: brandId,
    resolution_run_id: runId,
    candidate_company_name: extracted.canonical_company_name,
    candidate_domain: extracted.domain,
    candidate_source: "apollo_no_match",
    evidence_text: extracted.reasoning || null,
    evidence_url: extracted.evidence_urls[0] ?? null,
    match_reason: "No Apollo match — extracted from raw hits",
    trademark_serial_number: null,
    trademark_status: null,
    trademark_registration_date: null,
    trademark_owner_address: null,
    goods_services_text: null,
    heuristic_score: 0,
    heuristic_label: "unscored",
    needs_manual_review: true,
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

interface ApolloPipelineResult {
  rows: PersistedApolloMatchRow[];
  matchCount: number;
  noMatchCount: number;
  apolloRaw: Record<string, unknown>;
}

/**
 * Run extractor + Apollo enrichment pipeline. Returns the rows to persist
 * (Apollo-matched + apollo_no_match) and a raw payload for the run row.
 */
export async function runApolloPipeline(
  brandId: string,
  runId: string,
  extracted: ReadonlyArray<ExtractedCandidate>,
  apollo: ApolloClient | null,
): Promise<ApolloPipelineResult> {
  const rows: PersistedApolloMatchRow[] = [];
  const seenApolloIds = new Set<string>();
  let matchCount = 0;
  let noMatchCount = 0;

  if (!apollo) {
    // No Apollo key — every extracted candidate becomes a no-match row.
    for (const ext of extracted) {
      rows.push(buildNoMatchRow(brandId, runId, ext));
      noMatchCount += 1;
    }
    return {
      rows,
      matchCount,
      noMatchCount,
      apolloRaw: { error: "APOLLO_API_KEY not configured" },
    };
  }

  for (const ext of extracted) {
    const orgs = await apollo.searchOrganizations(
      ext.canonical_company_name,
      ext.domain,
    );
    if (orgs.length === 0) {
      rows.push(buildNoMatchRow(brandId, runId, ext));
      noMatchCount += 1;
      continue;
    }
    let appendedAnyForExt = false;
    for (const org of orgs) {
      if (seenApolloIds.has(org.id)) continue;
      seenApolloIds.add(org.id);
      const total = await apollo.countContacts(org.id);
      rows.push(buildApolloRow(brandId, runId, ext, org, total));
      matchCount += 1;
      appendedAnyForExt = true;
    }
    if (!appendedAnyForExt) {
      // All Apollo hits already deduped against another extracted candidate;
      // record the extracted name as no_match so the user still sees it.
      rows.push(buildNoMatchRow(brandId, runId, ext));
      noMatchCount += 1;
    }
  }

  return {
    rows,
    matchCount,
    noMatchCount,
    apolloRaw: apollo.rawSearches(),
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
  // Phase 34: we do NOT persist these heuristic rows; the rows we insert
  // are produced by the extractor + Apollo pipeline below.
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

  // 5. Run extractor over the merged raw hits.
  const extractorHits = buildExtractorHitsFromCandidates(merged);
  const extractorResult = await safeExtractor(
    brandContext.brand_name,
    brandContext.category,
    extractorHits,
    extractorFn,
  );

  // 6. Apollo pipeline: org search + people-count for each extracted name.
  const apollo =
    opts.apolloClient !== undefined
      ? opts.apolloClient
      : createApolloClient();
  const pipeline = await runApolloPipeline(
    brandId,
    runId,
    extractorResult.candidates,
    apollo,
  );

  // 7. Bulk insert candidates. Surface PG errors to brand state (B7).
  let insertedCount = 0;
  let persistError: string | null = null;
  if (pipeline.rows.length > 0) {
    try {
      const { error: insErr, count } = await admin
        .from("owner_candidates")
        .insert(pipeline.rows, { count: "exact" });
      if (insErr) {
        persistError = `Failed to persist candidates: ${insErr.message}`;
      } else {
        insertedCount = count ?? pipeline.rows.length;
        if (insertedCount < pipeline.rows.length) {
          persistError = `Persisted ${insertedCount}/${pipeline.rows.length} candidates — ${pipeline.rows.length - insertedCount} failed`;
        }
      }
    } catch (e) {
      persistError = `Failed to persist candidates: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // 8. Determine final state.
  const bothFailed = usptoResult.error != null && webResult.error != null;
  const noExtractedCandidates =
    extractorResult.candidates.length === 0 && pipeline.rows.length === 0;
  let finalState: "candidates_ready" | "failed";
  let errorMessage: string | null = null;
  if (persistError) {
    finalState = "failed";
    errorMessage = truncate(persistError, 1000);
  } else if (bothFailed && insertedCount === 0 && noExtractedCandidates) {
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
    finalState = "candidates_ready";
    errorMessage = null;
  }

  // 9. Persist run row.
  await admin
    .from("owner_resolution_runs")
    .update({
      status: finalState === "failed" ? "failed" : "succeeded",
      completed_at: new Date().toISOString(),
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
    ok: finalState === "candidates_ready",
    run_id: runId,
    candidates_count: insertedCount,
    top_score: null,
    state: finalState,
    error: errorMessage ?? undefined,
    apollo_match_count: pipeline.matchCount,
    apollo_no_match_count: pipeline.noMatchCount,
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
    };
  } catch (e) {
    return {
      candidates: [],
      raw: null,
      queries: [],
      results_count: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function safeExtractor(
  brandName: string,
  category: string | null,
  hits: Parameters<typeof extractOwnerCandidates>[2],
  fn: typeof extractOwnerCandidates,
): Promise<ExtractorSafeResult> {
  try {
    const r = await fn(brandName, category, hits);
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
