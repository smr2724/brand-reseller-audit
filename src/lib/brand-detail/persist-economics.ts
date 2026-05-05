/**
 * Phase 38 — Persist computed economics back to the `brands` row.
 *
 * Single source of truth: `computeBrandDetailFinancials`, which itself
 * delegates all math to `computeLegionEconomics`. Whenever the inputs
 * change (Keepa enrichment, report generation, manual revenue override)
 * we recompute and write the dollar columns on `brands` so the brand
 * page server component can READ persisted values instead of re-deriving
 * them every render.
 *
 * IMPORTANT: `rcg_fees` is intentionally left untouched — the user's
 * directive is "don't compute anything for RCG fees at all just yet".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeBrandDetailFinancials,
  type BrandFinancialAsin,
} from "./financial-model";

export interface PersistEconomicsResult {
  ok: boolean;
  reason?: "brand_missing" | "not_ready" | "no_revenue" | "update_failed";
  error?: string;
  wrote?: boolean;
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
 * Recompute the financial-model dollar columns on a brand row. Reads
 * the same inputs the brand-detail page server component reads, runs
 * `computeBrandDetailFinancials`, and writes the resulting numbers
 * back to the row. Skips `rcg_fees` entirely (per session memory) and
 * does NOT overwrite import-side fields it didn't compute.
 */
export async function persistBrandEconomics(
  admin: SupabaseClient<any, any, any>,
  brandId: string,
): Promise<PersistEconomicsResult> {
  const { data: brand, error: brandErr } = await admin
    .from("brands")
    .select(
      "id, keepa_last_enriched_at, trailing_12_months, est_monthly_revenue, keepa_brand_controlled_pct, confirmed_ttm_revenue_dollars, confirmed_ttm_source",
    )
    .eq("id", brandId)
    .maybeSingle();
  if (brandErr) {
    return { ok: false, reason: "brand_missing", error: brandErr.message };
  }
  if (!brand) return { ok: false, reason: "brand_missing" };

  const { data: asins, error: asinsErr } = await admin
    .from("brand_asins")
    .select("buy_box_price")
    .eq("brand_id", brandId)
    .order("offers_count", { ascending: false })
    .limit(50);
  if (asinsErr) {
    return { ok: false, error: asinsErr.message };
  }
  const asinRows: BrandFinancialAsin[] = (asins ?? []).map((a) => ({
    buy_box_price: a.buy_box_price ?? null,
  }));

  const result = computeBrandDetailFinancials(
    {
      keepa_last_enriched_at: brand.keepa_last_enriched_at,
      trailing_12_months: brand.trailing_12_months,
      est_monthly_revenue: brand.est_monthly_revenue,
      brand_controlled_pct: brand.keepa_brand_controlled_pct,
      confirmed_ttm_revenue_dollars: brand.confirmed_ttm_revenue_dollars,
      confirmed_ttm_source: brand.confirmed_ttm_source,
    },
    asinRows,
  );

  if (!result.ready) {
    return { ok: false, reason: "not_ready" };
  }

  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (result.revenue == null || result.outputs == null) {
    Object.assign(update, ECONOMICS_NULLS);
    // Preserve trailing_12_months / est_monthly_revenue as-is when
    // revenue couldn't be sized — don't clobber user-imported fields.
    if (brand.trailing_12_months != null) {
      update.trailing_12_months = brand.trailing_12_months;
    }
    if (brand.est_monthly_revenue != null) {
      update.est_monthly_revenue = brand.est_monthly_revenue;
    }
  } else {
    const out = result.outputs;
    update.trailing_12_months = result.revenue;
    update.est_monthly_revenue =
      brand.est_monthly_revenue != null
        ? brand.est_monthly_revenue
        : Math.round((result.revenue / 12) * 100) / 100;
    update.current_profit = out.current_profit;
    update.resellers_margin = out.reseller_margin_captured;
    update.recouped_shipping = out.recouped_shipping;
    update.labor_cost = out.labor_cost;
    update.additional_profit = out.delta_profit;
    update.new_profit = out.new_profit;
    update.seven_x_multiple_value = out.exit_lift;
  }

  const { error: updErr } = await admin
    .from("brands")
    .update(update)
    .eq("id", brandId);
  if (updErr) {
    return { ok: false, reason: "update_failed", error: updErr.message };
  }
  return { ok: true, wrote: true };
}
