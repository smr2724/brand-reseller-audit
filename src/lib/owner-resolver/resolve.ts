/**
 * Phase 33 — Brand Owner Resolver orchestrator.
 *
 * Pipeline:
 *   1. CAS-claim the brand: UPDATE brands SET state='running' WHERE
 *      state IN ('pending','candidates_ready','failed','selected'). If 0
 *      rows hit, another runner won — bail out (B5).
 *   2. Insert an `owner_resolution_runs` row (status=running).
 *   3. Run USPTO + web-search adapters in parallel; both soft-fail.
 *   4. Score candidates with the deterministic heuristic.
 *   5. Bulk insert `owner_candidates` — surface failure to caller (B7).
 *   6. Update brand.owner_resolution_state to `candidates_ready` (or
 *      `failed`).
 *   7. Update the run row with final counts and status.
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

  // 4. Dedupe + score.
  const merged = dedupeCandidates([
    ...usptoResult.candidates,
    ...webResult.candidates,
  ]);
  const scored = scoreCandidates(merged, brandContext);

  // 5. Bulk insert candidates. Surface PG errors to brand state (B7).
  let insertedCount = 0;
  let persistError: string | null = null;
  if (scored.length > 0) {
    const rows = scored.map((c) => toPersisted(c, brandId, runId));
    try {
      const { error: insErr, count } = await admin
        .from("owner_candidates")
        .insert(rows, { count: "exact" });
      if (insErr) {
        persistError = `Failed to persist candidates: ${insErr.message}`;
      } else {
        insertedCount = count ?? rows.length;
        // If the count came back smaller than expected, that's still a partial failure.
        if (insertedCount < rows.length) {
          persistError = `Persisted ${insertedCount}/${rows.length} candidates — ${rows.length - insertedCount} failed`;
        }
      }
    } catch (e) {
      persistError = `Failed to persist candidates: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // 6. Determine final state.
  const bothFailed = usptoResult.error != null && webResult.error != null;
  let finalState: "candidates_ready" | "failed";
  let errorMessage: string | null = null;
  if (persistError) {
    finalState = "failed";
    errorMessage = truncate(persistError, 1000);
  } else if (bothFailed && insertedCount === 0) {
    finalState = "failed";
    errorMessage = [usptoResult.error, webResult.error].filter(Boolean).join("; ");
  } else {
    finalState = "candidates_ready";
    errorMessage = null;
  }

  // 7. Persist run row.
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

  const topScore = scored.length > 0
    ? scored.reduce((m, c) => (c.heuristic_score > m ? c.heuristic_score : m), scored[0]!.heuristic_score)
    : null;

  if (persistError) {
    // Re-throw the persist error so callers (cron / admin endpoint) see it.
    throw new Error(persistError);
  }

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
