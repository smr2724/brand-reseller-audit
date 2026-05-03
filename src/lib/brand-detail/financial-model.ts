/**
 * Phase 26 — Brand-detail Financial Model panel.
 *
 * Pure helper that turns the cached enrichment state on a `brands` row
 * (plus the brand's cached `brand_asins` buy-box prices) into the
 * dollar values the panel renders. Single source of truth: every line
 * goes through `computeLegionEconomics`.
 *
 * Auto-populates as soon as Keepa enrichment lands — no report
 * generation required. Returns `{ ready: false }` when
 * `keepa_last_enriched_at` is null so the panel keeps em-dash
 * placeholders.
 *
 * Revenue precedence (matches `assembleV2`'s, minus the report-only
 * SP-API + Keepa /product paths which would burn API tokens here):
 *   1. brand.trailing_12_months           (real / imported)
 *   2. brand.est_monthly_revenue × 12     (legacy import field)
 *   3. price-only TTM fallback            (Phase 24 / 25 — buy_box_price
 *                                          × conservative monthly-units
 *                                          floor, low-confidence)
 */
import {
  computeLegionEconomics,
  defaultLegionInputs,
  type LegionOutputs,
} from "@/lib/math/legion-economics";

export type BrandFinancialRevenueKind =
  | "imported"
  | "price_only"
  | "missing";

export interface BrandFinancialInputs {
  keepa_last_enriched_at: string | null | undefined;
  trailing_12_months: number | null | undefined;
  est_monthly_revenue: number | null | undefined;
}

export interface BrandFinancialAsin {
  buy_box_price: number | null;
}

export interface BrandFinancialModel {
  ready: true;
  revenue: number | null;
  revenueKind: BrandFinancialRevenueKind;
  lowConfidence: boolean;
  outputs: LegionOutputs | null;
}

export interface BrandFinancialNotReady {
  ready: false;
}

export type BrandFinancialResult = BrandFinancialModel | BrandFinancialNotReady;

function priceOnlyMonthlyUnitsFloor(): number {
  const raw =
    typeof process !== "undefined"
      ? process.env?.RCG_PRICE_ONLY_MONTHLY_UNITS
      : undefined;
  if (!raw) return 4;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

function priceOnlyTtmFallback(asins: BrandFinancialAsin[]): number | null {
  if (!asins.length) return null;
  const units = priceOnlyMonthlyUnitsFloor();
  let total = 0;
  let priced = 0;
  for (const a of asins) {
    const price = typeof a.buy_box_price === "number" ? a.buy_box_price : null;
    if (price == null || price <= 0) continue;
    total += price * units * 12;
    priced += 1;
  }
  if (priced === 0) return null;
  return Math.round(total);
}

export function computeBrandDetailFinancials(
  brand: BrandFinancialInputs,
  asins: BrandFinancialAsin[],
): BrandFinancialResult {
  if (!brand.keepa_last_enriched_at) {
    return { ready: false };
  }

  const importedTrailing12 =
    brand.trailing_12_months ??
    (brand.est_monthly_revenue != null
      ? Number(brand.est_monthly_revenue) * 12
      : null);

  let revenue: number | null = null;
  let revenueKind: BrandFinancialRevenueKind = "missing";

  if (importedTrailing12 != null && Number.isFinite(importedTrailing12)) {
    revenue = importedTrailing12;
    revenueKind = "imported";
  } else {
    const fallback = priceOnlyTtmFallback(asins);
    if (fallback != null) {
      revenue = fallback;
      revenueKind = "price_only";
    }
  }

  if (revenue == null) {
    return {
      ready: true,
      revenue: null,
      revenueKind: "missing",
      lowConfidence: false,
      outputs: null,
    };
  }

  const outputs = computeLegionEconomics(defaultLegionInputs(revenue));
  return {
    ready: true,
    revenue,
    revenueKind,
    lowConfidence: revenueKind === "price_only",
    outputs,
  };
}
