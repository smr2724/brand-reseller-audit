/**
 * Phase 33 — Brand Owner Resolver orchestrator.
 *
 * Pipeline:
 *   1. Insert an `owner_resolution_runs` row (status=running).
 *   2. Load brand context (name, category, top product titles).
 *   3. Run USPTO + web-search adapters in parallel; both soft-fail.
 *   4. Score candidates with the deterministic heuristic.
 *   5. Bulk insert `owner_candidates`.
 *   6. Update brand.owner_resolution_state to `candidates_ready` (or
 *      `failed` if both adapters errored).
 *   7. Update the run row with final counts and status.
 *
 * Never throws — always returns a structured `ResolveBrandOwnerResult`
 * the caller can serialise to a route response.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { searchUsptoTrademarks } from "./uspto";
import { searchWebForOwners } from "./web-search";
import { scoreCandidates } from "./heuristic-scoring";
import type {
  BrandContext,
  OwnerResolutionTrigger,
  RawOwnerCandidate,
  ScoredOwnerCandidate,
} from "./types";

export interface ResolveBrandOwnerOptions {
  triggered_by: OwnerResolutionTrigger;
  /** Override adapters — used by tests. */
  usptoFn?: typeof searchUsptoTrademarks;
  webSearchFn?: typeof searchWebForOwners;
}

export interface ResolveBrandOwnerResult {
  ok: boolean;
  run_id: string | null;
  candidates_count: number;
  top_score: number | null;
  state: "candidates_ready" | "failed";
  error?: string;
}

const TOP_PRODUCT_TITLE_LIMIT = 20;

async function loadBrandContext(
  admin: SupabaseClient,
  brandId: string,
): Promise<BrandContext | null> {
  const { data: brand, error } = await admin
    .from("brands")
    .select("id, name, category")
    .eq("id", brandId)
    .maybeSingle();
  if (error || !brand) return null;
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
  return {
    brand_id: (brand as { id: string }).id,
    brand_name: String((brand as { name: string }).name),
    category: ((brand as { category?: string | null }).category ?? null),
    product_titles: titles,
  };
}

function dedupeCandidates(
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
    // Prefer the USPTO record over a web hit when keys collide so we
    // keep the trademark metadata, but copy across the domain if missing.
    if (existing.candidate_source !== "uspto" && c.candidate_source === "uspto") {
      seen.set(key, { ...c, candidate_domain: existing.candidate_domain ?? c.candidate_domain });
    } else if (!existing.candidate_domain && c.candidate_domain) {
      seen.set(key, { ...existing, candidate_domain: c.candidate_domain });
    }
  }
  return Array.from(seen.values());
}

interface PersistedCandidate {
  brand_id: string;
  resolution_run_id: string;
  candidate_company_name: string;
  candidate_domain: string | null;
  candidate_source: string;
  evidence_text: string | null;
  evidence_url: string | null;
  match_reason: string | null;
  trademark_serial_number: string | null;
  trademark_status: string | null;
  trademark_registration_date: string | null;
  trademark_owner_address: string | null;
  goods_services_text: string | null;
  heuristic_score: number;
  heuristic_label: string;
  needs_manual_review: boolean;
  raw_payload: unknown;
}

function toPersisted(
  c: ScoredOwnerCandidate,
  brandId: string,
  runId: string,
): PersistedCandidate {
  return {
    brand_id: brandId,
    resolution_run_id: runId,
    candidate_company_name: c.candidate_company_name,
    candidate_domain: c.candidate_domain,
    candidate_source: c.candidate_source,
    evidence_text: c.evidence_text,
    evidence_url: c.evidence_url,
    match_reason: c.match_reason,
    trademark_serial_number: c.trademark_serial_number,
    trademark_status: c.trademark_status,
    trademark_registration_date: c.trademark_registration_date,
    trademark_owner_address: c.trademark_owner_address,
    goods_services_text: c.goods_services_text,
    heuristic_score: c.heuristic_score,
    heuristic_label: c.heuristic_label,
    needs_manual_review: c.needs_manual_review,
    raw_payload: c.raw_payload ?? null,
  };
}

export async function resolveBrandOwner(
  admin: SupabaseClient,
  brandId: string,
  opts: ResolveBrandOwnerOptions,
): Promise<ResolveBrandOwnerResult> {
  const usptoFn = opts.usptoFn ?? searchUsptoTrademarks;
  const webSearchFn = opts.webSearchFn ?? searchWebForOwners;

  // 1. Insert a run row.
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

  await admin
    .from("brands")
    .update({
      owner_resolution_state: "running",
      owner_resolution_error: null,
    })
    .eq("id", brandId);

  // 2. Load brand context.
  const brand = await loadBrandContext(admin, brandId);
  if (!brand) {
    await admin
      .from("owner_resolution_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_message: "brand not found",
      })
      .eq("id", runId);
    await admin
      .from("brands")
      .update({
        owner_resolution_state: "failed",
        owner_resolution_error: "brand not found",
      })
      .eq("id", brandId);
    return {
      ok: false,
      run_id: runId,
      candidates_count: 0,
      top_score: null,
      state: "failed",
      error: "brand not found",
    };
  }

  // 3. Run adapters in parallel (each soft-fails internally).
  const [usptoResult, webResult] = await Promise.all([
    safeUspto(brand.brand_name, usptoFn),
    safeWebSearch(brand.brand_name, webSearchFn),
  ]);

  // 4. Dedupe + score.
  const merged = dedupeCandidates([
    ...usptoResult.candidates,
    ...webResult.candidates,
  ]);
  const scored = scoreCandidates(merged, brand);

  // 5. Bulk insert candidates.
  let insertedCount = 0;
  if (scored.length > 0) {
    const rows = scored.map((c) => toPersisted(c, brandId, runId));
    const { error: insErr, count } = await admin
      .from("owner_candidates")
      .insert(rows, { count: "exact" });
    if (insErr) {
      console.warn("[owner-resolver] candidate insert failed", insErr.message);
    } else {
      insertedCount = count ?? rows.length;
    }
  }

  // 6. Determine final state.
  const bothFailed =
    usptoResult.error != null && webResult.error != null;
  const finalState = bothFailed && insertedCount === 0 ? "failed" : "candidates_ready";
  const errorMessage = bothFailed
    ? [usptoResult.error, webResult.error].filter(Boolean).join("; ")
    : null;

  // 7. Persist run row.
  await admin
    .from("owner_resolution_runs")
    .update({
      status: bothFailed && insertedCount === 0 ? "failed" : "succeeded",
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
      owner_resolution_error: errorMessage,
    })
    .eq("id", brandId);

  const topScore = scored.length > 0
    ? scored.reduce((m, c) => (c.heuristic_score > m ? c.heuristic_score : m), scored[0]!.heuristic_score)
    : null;

  return {
    ok: finalState === "candidates_ready",
    run_id: runId,
    candidates_count: insertedCount,
    top_score: topScore,
    state: finalState,
    error: errorMessage ?? undefined,
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
