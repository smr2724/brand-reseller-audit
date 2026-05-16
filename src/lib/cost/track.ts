/**
 * Phase 81 — Best-effort, fail-soft cost tracking.
 *
 * Every call site logs to `api_costs` and updates the run/brand
 * rollups. Errors are swallowed — cost tracking is observability,
 * never on the critical path.
 */
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { computeCost } from "./compute";
import type { CostProvider } from "./constants";
import { getBulkCtx } from "./context";

export type { CostProvider } from "./constants";
export { withBulkCtx, getBulkCtx, setBulkCtxBrandId, type BulkCtx } from "./context";

export interface TrackCostArgs {
  bulkRunId?: string | null;
  bulkRunBrandId?: string | null;
  brandId?: string | null;
  provider: CostProvider;
  operation: string;
  units?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export async function trackCost(args: TrackCostArgs): Promise<number> {
  let cost = 0;
  try {
    cost = computeCost(args);
  } catch (e) {
    console.warn(`[cost] computeCost threw — provider=${args.provider} op=${args.operation}:`, e);
    return 0;
  }

  // Pull defaults from AsyncLocalStorage when caller didn't pass them.
  const ambient = getBulkCtx();
  const bulkRunId = args.bulkRunId ?? ambient.bulkRunId ?? null;
  const bulkRunBrandId = args.bulkRunBrandId ?? ambient.bulkRunBrandId ?? null;
  const brandId = args.brandId ?? ambient.brandId ?? null;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return cost;
  }

  const units =
    args.provider === "openai"
      ? (args.inputTokens ?? 0) + (args.outputTokens ?? 0)
      : args.units ?? 0;

  try {
    const { error: insErr } = await admin.from("api_costs").insert({
      bulk_run_id: bulkRunId,
      bulk_run_brand_id: bulkRunBrandId,
      brand_id: brandId,
      provider: args.provider,
      operation: args.operation,
      units,
      cost_usd: cost,
    });
    if (insErr) {
      console.warn(`[cost] api_costs insert failed (${args.provider}/${args.operation}):`, insErr.message);
    }
  } catch (e) {
    console.warn(`[cost] api_costs insert threw:`, e);
  }

  // Roll up onto bulk_run_brands (per-brand) and bulk_runs (run total).
  // Use read-modify-write since PostgREST doesn't expose atomic add and
  // the pipeline is sequential per-brand. Race risk is negligible.
  if (bulkRunBrandId) {
    try {
      const { data: row } = await admin
        .from("bulk_run_brands")
        .select("cost_total_usd, cost_breakdown")
        .eq("id", bulkRunBrandId)
        .maybeSingle<{
          cost_total_usd: number | string | null;
          cost_breakdown: Record<string, number> | null;
        }>();
      const prevTotal = Number(row?.cost_total_usd ?? 0) || 0;
      const prevBreakdown: Record<string, number> = { ...(row?.cost_breakdown ?? {}) };
      const prevProvider = Number(prevBreakdown[args.provider] ?? 0) || 0;
      prevBreakdown[args.provider] = Math.round((prevProvider + cost) * 10_000) / 10_000;
      const newTotal = Math.round((prevTotal + cost) * 10_000) / 10_000;
      const { error: updErr } = await admin
        .from("bulk_run_brands")
        .update({
          cost_total_usd: newTotal,
          cost_breakdown: prevBreakdown,
          updated_at: new Date().toISOString(),
        })
        .eq("id", bulkRunBrandId);
      if (updErr) {
        console.warn(`[cost] bulk_run_brands rollup failed:`, updErr.message);
      }
    } catch (e) {
      console.warn(`[cost] bulk_run_brands rollup threw:`, e);
    }
  }

  if (bulkRunId) {
    try {
      const { data: runRow } = await admin
        .from("bulk_runs")
        .select("cost_total_usd")
        .eq("id", bulkRunId)
        .maybeSingle<{ cost_total_usd: number | string | null }>();
      const prevTotal = Number(runRow?.cost_total_usd ?? 0) || 0;
      const newTotal = Math.round((prevTotal + cost) * 10_000) / 10_000;
      const { error: updErr } = await admin
        .from("bulk_runs")
        .update({
          cost_total_usd: newTotal,
          updated_at: new Date().toISOString(),
        })
        .eq("id", bulkRunId);
      if (updErr) {
        console.warn(`[cost] bulk_runs rollup failed:`, updErr.message);
      }
    } catch (e) {
      console.warn(`[cost] bulk_runs rollup threw:`, e);
    }
  }

  return cost;
}
