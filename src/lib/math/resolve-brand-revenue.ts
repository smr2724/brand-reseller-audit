/**
 * Phase 28 — Resolve which TTM revenue number to feed into
 * `computeLegionEconomics()`.
 *
 * The math function is pure and stays unchanged. The CALLER decides
 * which revenue to use:
 *
 *   1. brand.confirmed_ttm_revenue_dollars  — user-confirmed override
 *      (Orion data, seller call, internal warehouse). Wins over
 *      everything else when present and > 0. Source: "confirmed".
 *   2. enrichmentRevenue                    — whatever the report
 *      pipeline / brand-detail panel computed from imports + Keepa
 *      estimator + price-only fallback. Source: "enrichment".
 *
 * The returned `estimator_suggestion` is the enrichment number even
 * when we override it — so the renderer can show "Estimator suggested
 * $X; using confirmed $Y". When source is `enrichment`, suggestion is
 * null (no override happened).
 */
export type RevenueSource = "confirmed" | "enrichment";

export interface BrandRevenueRow {
  confirmed_ttm_revenue_dollars?: number | null;
  confirmed_ttm_source?: string | null;
}

export interface ResolvedRevenue {
  value: number | null;
  source: RevenueSource;
  /** Free-text source label set by the user (only when source=confirmed). */
  confirmed_source_label: string | null;
  /** When source=confirmed, the estimator number we'd otherwise have used.
   *  Surfaces as the "Estimator suggested $X" sub-note. Null when no
   *  estimator value is available, or when source=enrichment. */
  estimator_suggestion: number | null;
}

function toNumber(n: unknown): number | null {
  if (n == null) return null;
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

export function resolveBrandRevenue(
  brand: BrandRevenueRow | null | undefined,
  enrichmentRevenue: number | null | undefined,
): ResolvedRevenue {
  const confirmed = toNumber(brand?.confirmed_ttm_revenue_dollars);
  const enrichment = toNumber(enrichmentRevenue ?? null);

  if (confirmed != null && confirmed > 0) {
    return {
      value: confirmed,
      source: "confirmed",
      confirmed_source_label:
        typeof brand?.confirmed_ttm_source === "string" &&
        brand!.confirmed_ttm_source!.trim().length > 0
          ? brand!.confirmed_ttm_source!.trim()
          : null,
      estimator_suggestion: enrichment,
    };
  }

  return {
    value: enrichment,
    source: "enrichment",
    confirmed_source_label: null,
    estimator_suggestion: null,
  };
}
