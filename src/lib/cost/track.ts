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

  // Roll up onto bulk_run_brands (per-brand) and bulk_runs (run total)
  // via SECURITY DEFINER RPCs (migration 0063) — single atomic UPDATE,
  // no lost-update race.
  if (bulkRunBrandId && cost > 0) {
    try {
      const { error: rpcErr } = await admin.rpc("add_brand_cost", {
        p_brand_run_id: bulkRunBrandId,
        p_provider: args.provider,
        p_delta: cost,
      });
      if (rpcErr) {
        console.warn(`[cost] add_brand_cost rpc failed:`, rpcErr.message);
      }
    } catch (e) {
      console.warn(`[cost] add_brand_cost rpc threw:`, e);
    }
  }

  if (bulkRunId && cost > 0) {
    try {
      const { error: rpcErr } = await admin.rpc("add_run_cost", {
        p_run_id: bulkRunId,
        p_delta: cost,
      });
      if (rpcErr) {
        console.warn(`[cost] add_run_cost rpc failed:`, rpcErr.message);
      }
    } catch (e) {
      console.warn(`[cost] add_run_cost rpc threw:`, e);
    }
  }

  return cost;
}
