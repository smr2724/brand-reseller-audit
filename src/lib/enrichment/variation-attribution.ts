/**
 * Phase 31 — Variation-aware sales attribution.
 *
 * Amazon shares sales rank across child variations of a parent listing
 * (e.g. a 4-pack, a 12-pack, a "case", and a pallet sharing one parent).
 * Third-party rank-to-units estimators (Keepa included) return roughly
 * the same monthly-units estimate for every child — so summing across
 * siblings double-counts. The pallet child ASIN ends up reporting the
 * same hundreds of monthly units as the 4-pack, even though zero
 * pallets actually sold.
 *
 * Methodology (deliberately simple, easy to defend):
 *   1. Group children by parentAsin within the brand. A "variation group"
 *      is the set of ASINs sharing one parentAsin. Singletons (no
 *      siblings) are degenerate groups of size 1 — no attribution math.
 *   2. group_monthly_units = max(monthly_units across siblings). We use
 *      MAX, not SUM, because Keepa is duplicating the parent-level
 *      estimate across siblings; the parent's true volume is approximately
 *      that one shared number.
 *   3. weight_i = recent_reviews_i / sum(recent_reviews_j across group).
 *      Falls back to equal weighting (1/N) when no child has reviews.
 *      The intuition: a 90-day review delta is a noisy but free proxy
 *      for which child is actually selling. Inactive variations (pallets,
 *      old stale SKUs) get near-zero weight and therefore near-zero
 *      attributed sales, which is the user-confirmed ground truth.
 *   4. attributed_monthly_units = group_monthly_units × weight_i.
 *
 * The output replaces the raw `monthly_units` input to the revenue
 * estimator (and to the per-ASIN report cards) so the brand-level
 * trailing-12mo sum no longer over-counts variation siblings.
 */

export interface VariationAttributionInput {
  asin: string;
  /** Keepa parentAsin (uppercased) when this child belongs to a variation
   * family. Null/undefined for singletons or when Keepa didn't return a
   * parent. */
  parent_asin: string | null;
  /** Pre-attribution monthly-units estimate (rank-derived). Null/zero is
   * tolerated; siblings with reviews still get a weighted slice when the
   * group's max is positive. */
  raw_monthly_units: number | null;
  /** 90-day review delta (or total review count when no history). Used to
   * derive each child's weight inside the group. Null/zero is tolerated;
   * if every sibling is null the group falls back to equal weighting. */
  recent_review_count: number | null;
}

export interface VariationAttributionResult {
  asin: string;
  parent_asin: string | null;
  /** Number of siblings sharing the same parent_asin, including self.
   * 1 for singletons. */
  variation_group_size: number;
  /** Weight applied to the group volume (0..1). 1.0 for singletons. */
  variation_weight: number;
  /** Pre-attribution Keepa monthly-units (echoed for persistence). */
  raw_monthly_units: number | null;
  /** Post-attribution monthly-units. For singletons this equals
   * raw_monthly_units; for variation siblings it equals
   * group_max × variation_weight. */
  attributed_monthly_units: number | null;
}

/**
 * Apply variation-aware attribution across a set of brand ASINs. The
 * grouping is local to the input list (callers should pass all of a
 * brand's ASINs at once so siblings co-occur).
 */
export function attributeVariationSales(
  inputs: VariationAttributionInput[],
): VariationAttributionResult[] {
  // Group by parent_asin. Singletons (parent_asin === null) each form a
  // group of 1 — keyed by their own ASIN to avoid colliding.
  const groups = new Map<string, VariationAttributionInput[]>();
  for (const inp of inputs) {
    const key = inp.parent_asin && inp.parent_asin.length === 10
      ? inp.parent_asin.toUpperCase()
      : `__singleton__${inp.asin}`;
    const arr = groups.get(key);
    if (arr) arr.push(inp);
    else groups.set(key, [inp]);
  }

  const out: VariationAttributionResult[] = [];

  for (const [, members] of groups) {
    const size = members.length;

    // Singleton: identity transform — passthrough so callers can persist
    // the same shape for every ASIN regardless of group size.
    if (size === 1) {
      const m = members[0];
      out.push({
        asin: m.asin,
        parent_asin: m.parent_asin ?? null,
        variation_group_size: 1,
        variation_weight: 1,
        raw_monthly_units: m.raw_monthly_units ?? null,
        attributed_monthly_units: m.raw_monthly_units ?? null,
      });
      continue;
    }

    // Group volume = max across siblings (NOT sum — Keepa duplicates the
    // parent-level rank-derived estimate across children, so the
    // parent's true monthly volume is approximately the single shared
    // number).
    const groupMax = members.reduce(
      (acc, m) =>
        Math.max(
          acc,
          Number.isFinite(m.raw_monthly_units as number)
            ? Math.max(0, (m.raw_monthly_units as number) ?? 0)
            : 0,
        ),
      0,
    );

    // Weights: review-velocity. Sum across siblings; fall back to equal
    // weighting when every sibling reports null/zero (rare — usually a
    // dead listing or a fresh launch with no reviews on any variation).
    const reviewSum = members.reduce(
      (acc, m) => acc + Math.max(0, m.recent_review_count ?? 0),
      0,
    );
    const equalWeight = 1 / size;

    for (const m of members) {
      let weight: number;
      if (reviewSum <= 0) {
        weight = equalWeight;
      } else {
        const r = Math.max(0, m.recent_review_count ?? 0);
        weight = r / reviewSum;
      }
      // Bound to [0, 1] in case of bad inputs.
      if (!Number.isFinite(weight) || weight < 0) weight = 0;
      if (weight > 1) weight = 1;

      const attributed = groupMax > 0 ? groupMax * weight : 0;

      out.push({
        asin: m.asin,
        parent_asin: m.parent_asin ?? null,
        variation_group_size: size,
        variation_weight: weight,
        raw_monthly_units: m.raw_monthly_units ?? null,
        attributed_monthly_units: attributed,
      });
    }
  }

  return out;
}

/**
 * Convenience: turn the result list into a map keyed by ASIN so callers
 * (revenue estimator, per-ASIN cards) can look up attributed numbers in
 * one pass.
 */
export function indexAttributionByAsin(
  results: VariationAttributionResult[],
): Map<string, VariationAttributionResult> {
  const m = new Map<string, VariationAttributionResult>();
  for (const r of results) m.set(r.asin, r);
  return m;
}

/**
 * Whether at least one ASIN in the brand belongs to a variation group
 * (size ≥ 2). Used by the report renderer to decide whether to surface
 * the methodology disclosure subsection.
 */
export function hasAnyVariationGroup(
  results: VariationAttributionResult[],
): boolean {
  return results.some((r) => r.variation_group_size >= 2);
}
