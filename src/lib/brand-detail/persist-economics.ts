/**
 * Phase 38 — Persist computed economics back to the `brands` row.
 *
 * Phase 38.1 — Bug 1 fix. The report's revenue calculator
 * (`estimateBrandTtmRevenueFromPersisted`) is the single source of
 * truth for `brands.trailing_12_months` and `brands.est_monthly_revenue`.
 * The previous version of this function read `brand.trailing_12_months`
 * back as an "imported" revenue and passed it through
 * `computeBrandDetailFinancials`, which meant whatever wrong value the
 * Keepa writer had previously persisted got fed back in unchanged.
 *
 * New flow:
 *   1. Sum revenue across the full `brand_asins` catalog using the same
 *      function the report uses (Keepa monthlySold + BSR fallback,
 *      variation-aware, post-attribution).
 *   2. If `confirmed_ttm_revenue_dollars` is set on the brand row, that
 *      manual override wins.
 *   3. Persist `trailing_12_months` = canonical, `est_monthly_revenue`
 *      = trailing_12_months / 12.
 *   4. Feed the canonical revenue into `computeLegionEconomics` for the
 *      downstream dollar columns.
 *
 * IMPORTANT: `rcg_fees` is intentionally left untouched — the user's
 * directive is "don't compute anything for RCG fees at all just yet".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeLegionEconomics,
  defaultLegionInputs,
} from "@/lib/math/legion-economics";
import {
  estimateBrandTtmRevenueFromPersisted,
  type RevenueEstimate,
} from "@/lib/enrichment/revenue-estimator";
import { resolveBrandRevenue } from "@/lib/math/resolve-brand-revenue";

export interface PersistEconomicsResult {
  ok: boolean;
  reason?: "brand_missing" | "not_ready" | "no_revenue" | "update_failed";
  error?: string;
  wrote?: boolean;
  /** Phase 38.1 — surfaces the canonical revenue we just wrote so
   * callers (admin recompute route, refresh route) can log a per-brand
   * before/after line for diagnostics. */
  revenue?: number | null;
  revenueSource?: "confirmed" | "keepa_persisted" | "none";
}

const ECONOMICS_NULLS = {
  trailing_12_months: null as number | null,
  est_monthly_revenue: null as number | null,
  current_profit: null as number | null,
  resellers_margin: null as number | null,
  recouped_shipping: null as number | null,
  labor_cost: null as number | null,
  additional_profit: null as number | null,
  new_profit: null as number | null,
  seven_x_multiple_value: null as number | null,
};

/**
 * Recompute the financial-model dollar columns on a brand row using the
 * report's canonical revenue calculator. Reads from `brand_asins`
 * (post-attribution) rather than the stale column on `brands`, so the
 * brand page and the report can no longer disagree.
 */
export async function persistBrandEconomics(
  admin: SupabaseClient<any, any, any>,
  brandId: string,
): Promise<PersistEconomicsResult> {
  const { data: brand, error: brandErr } = await admin
    .from("brands")
    .select(
      "id, keepa_last_enriched_at, est_monthly_revenue, keepa_brand_controlled_pct, confirmed_ttm_revenue_dollars, confirmed_ttm_source",
    )
    .eq("id", brandId)
    .maybeSingle();
  if (brandErr) {
    return { ok: false, reason: "brand_missing", error: brandErr.message };
  }
  if (!brand) return { ok: false, reason: "brand_missing" };

  if (!brand.keepa_last_enriched_at) {
    return { ok: false, reason: "not_ready" };
  }

  const { data: asinRows, error: asinsErr } = await admin
    .from("brand_asins")
    .select(
      "asin, buy_box_price, attributed_monthly_units, variation_group_size, is_brand_controlled",
    )
    .eq("brand_id", brandId);
  if (asinsErr) {
    return { ok: false, error: asinsErr.message };
  }

  let estimate: RevenueEstimate | null = null;
  if (asinRows && asinRows.length) {
    estimate = estimateBrandTtmRevenueFromPersisted(
      asinRows.map((r: any) => ({
        asin: r.asin,
        attributed_monthly_units: r.attributed_monthly_units ?? null,
        buy_box_price: r.buy_box_price ?? null,
        variation_group_size: r.variation_group_size ?? null,
        is_brand_controlled: r.is_brand_controlled ?? null,
      })),
    );
  }

  const computed = estimate?.total_ttm_revenue ?? null;

  // Manual override wins. resolveBrandRevenue returns the confirmed
  // value (rounded) when set, else falls through to the estimator.
  const resolved = resolveBrandRevenue(
    {
      confirmed_ttm_revenue_dollars: brand.confirmed_ttm_revenue_dollars ?? null,
      confirmed_ttm_source: brand.confirmed_ttm_source ?? null,
    },
    computed,
  );
  const revenue = resolved.value;
  const revenueSource: PersistEconomicsResult["revenueSource"] =
    resolved.source === "confirmed"
      ? "confirmed"
      : revenue != null
      ? "keepa_persisted"
      : "none";

  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (revenue == null) {
    Object.assign(update, ECONOMICS_NULLS);
    const { error: updErr } = await admin
      .from("brands")
      .update(update)
      .eq("id", brandId);
    if (updErr) {
      return { ok: false, reason: "update_failed", error: updErr.message };
    }
    return {
      ok: true,
      wrote: true,
      revenue: null,
      revenueSource,
      reason: "no_revenue",
    };
  }

  const bcRaw = brand.keepa_brand_controlled_pct;
  const brandControlledPct =
    bcRaw == null || !Number.isFinite(Number(bcRaw))
      ? null
      : Math.max(0, Math.min(1, Number(bcRaw)));
  const out = computeLegionEconomics({
    ...defaultLegionInputs(revenue),
    brand_controlled_pct: brandControlledPct,
  });

  update.trailing_12_months = revenue;
  update.est_monthly_revenue = Math.round((revenue / 12) * 100) / 100;
  update.current_profit = out.current_profit;
  update.resellers_margin = out.reseller_margin_captured;
  update.recouped_shipping = out.recouped_shipping;
  update.labor_cost = out.labor_cost;
  update.additional_profit = out.delta_profit;
  update.new_profit = out.new_profit;
  update.seven_x_multiple_value = out.exit_lift;

  const { error: updErr } = await admin
    .from("brands")
    .update(update)
    .eq("id", brandId);
  if (updErr) {
    return { ok: false, reason: "update_failed", error: updErr.message };
  }
  console.log(
    `[persist-economics] brand=${brandId} revenue=${revenue} source=${revenueSource} bc_pct=${brandControlledPct ?? "null"}`,
  );
  return { ok: true, wrote: true, revenue, revenueSource };
}
