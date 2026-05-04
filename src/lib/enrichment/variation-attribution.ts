/**
 * Phase 31/32 — Variation-aware sales attribution.
 *
 * Amazon shares sales rank across child variations of a parent listing
 * (e.g. a 4-pack, a 12-pack, a "case", and a pallet sharing one parent).
 * Third-party rank-to-units estimators (Keepa included) return roughly
 * the same monthly-units estimate for every child — so summing across
 * siblings double-counts. The pallet child ASIN ends up reporting the
 * same hundreds of monthly units as the 4-pack, even though zero
 * pallets actually sold.
 *
 * Phase 31 weighted siblings purely by recent review activity. Real-
 * world pallets accumulate legacy reviews comparable to the active
 * small-pack siblings (Amazon often shows reviews at the parent level),
 * so review-only weighting still over-attributed sales to dormant
 * pallets. Phase 32 combines two signals:
 *
 *   review_share_i = recent_reviews_i / Σ recent_reviews
 *   buybox_share_i = buy_box_changes_i / Σ buy_box_changes
 *   weight_i       = REVIEW_WEIGHT × review_share_i
 *                    + BUYBOX_WEIGHT × buybox_share_i
 *
 * Default weights tilt toward Buy Box because Buy Box winner churn
 * directly reflects recent purchase activity, while reviews can be
 * legacy or amplified by parent-level review sharing:
 *
 *   VARIATION_REVIEW_WEIGHT = 0.4
 *   VARIATION_BUYBOX_WEIGHT = 0.6
 *
 * Both are env-overridable. The two constants do not have to sum to 1
 * — we re-normalize internally so the configured ratio still applies
 * even if a deployment overrides one.
 *
 * Methodology (deliberately simple, easy to defend):
 *   1. Group children by parentAsin within the brand. A "variation group"
 *      is the set of ASINs sharing one parentAsin. Singletons (no
 *      siblings) are degenerate groups of size 1 — no attribution math.
 *   2. group_monthly_units = max(monthly_units across siblings). We use
 *      MAX, not SUM, because Keepa is duplicating the parent-level
 *      estimate across siblings; the parent's true volume is approximately
 *      that one shared number.
 *   3. weight_i = combined review + Buy Box share (formula above).
 *      Fallbacks (in order):
 *        a. Σ buy_box_changes = 0 across the group → review-only weighting
 *           (Phase 31 behavior). Reviews are still better than nothing.
 *        b. Σ recent_reviews = 0 across the group → Buy Box-only
 *           weighting.
 *        c. Both zero → equal weighting (1/N each).
 *      Null per-child values are treated as 0 contribution to that
 *      signal's share.
 *   4. attributed_monthly_units = group_monthly_units × weight_i.
 *
 * The output replaces the raw `monthly_units` input to the revenue
 * estimator (and to the per-ASIN report cards) so the brand-level
 * trailing-12mo sum no longer over-counts variation siblings.
 */

const DEFAULT_REVIEW_WEIGHT = 0.4;
const DEFAULT_BUYBOX_WEIGHT = 0.6;

function clampNonNegative(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return n;
}

function readEnvWeight(name: string, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * Resolve the two blend weights from env once per call. Re-reads each
 * invocation so test harnesses can override `process.env.VARIATION_*`
 * before importing the report.
 */
function resolveBlendWeights(): { review: number; buybox: number } {
  const review = readEnvWeight("VARIATION_REVIEW_WEIGHT", DEFAULT_REVIEW_WEIGHT);
  const buybox = readEnvWeight("VARIATION_BUYBOX_WEIGHT", DEFAULT_BUYBOX_WEIGHT);
  // If a deployment zeroes both (degenerate config), fall back to defaults.
  if (review === 0 && buybox === 0) {
    return { review: DEFAULT_REVIEW_WEIGHT, buybox: DEFAULT_BUYBOX_WEIGHT };
  }
  return { review, buybox };
}

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
   * derive each child's review-share inside the group. Null/zero is
   * tolerated; treated as 0 contribution. */
  recent_review_count: number | null;
  /** Phase 32 — count of distinct Buy Box winner changes in the last 90
   * days. Null/zero treated as 0 contribution to the Buy Box share. */
  buy_box_change_count_90d?: number | null;
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
  const blend = resolveBlendWeights();
  const blendSum = blend.review + blend.buybox;

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

  for (const members of Array.from(groups.values())) {
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
      (acc, m) => Math.max(acc, clampNonNegative(m.raw_monthly_units)),
      0,
    );

    const reviewSum = members.reduce(
      (acc, m) => acc + clampNonNegative(m.recent_review_count),
      0,
    );
    const buyboxSum = members.reduce(
      (acc, m) => acc + clampNonNegative(m.buy_box_change_count_90d),
      0,
    );
    const equalWeight = 1 / size;

    // Decide which signal(s) drive the weights for this group.
    //   Both > 0 → blended (default 0.4 review + 0.6 Buy Box).
    //   Only reviews > 0 → review-only (Phase 31 behavior, the brief's
    //                       "no Buy Box data anywhere in the group" fallback).
    //   Only Buy Box > 0 → Buy Box-only.
    //   Both 0 → equal weighting.
    const useReviews = reviewSum > 0;
    const useBuybox = buyboxSum > 0;

    if (!useReviews && !useBuybox) {
      // Edge case (c): both signals empty across the group.
      for (const m of members) {
        const w = equalWeight;
        out.push({
          asin: m.asin,
          parent_asin: m.parent_asin ?? null,
          variation_group_size: size,
          variation_weight: w,
          raw_monthly_units: m.raw_monthly_units ?? null,
          attributed_monthly_units: groupMax > 0 ? groupMax * w : 0,
        });
      }
      continue;
    }

    // When only one signal is available, log a warning so ops can spot
    // brands stuck in the fallback. The actual math is just review_share
    // or buybox_share by itself.
    if (useReviews && !useBuybox) {
      const parentKey = members[0].parent_asin ?? "(null)";
      console.warn(
        `[variation-attribution] group ${parentKey}: no Buy Box data across ${size} siblings — falling back to review-only weighting.`,
      );
    }
    if (!useReviews && useBuybox) {
      const parentKey = members[0].parent_asin ?? "(null)";
      console.warn(
        `[variation-attribution] group ${parentKey}: no reviews across ${size} siblings — falling back to Buy Box-only weighting.`,
      );
    }

    for (const m of members) {
      const r = clampNonNegative(m.recent_review_count);
      const b = clampNonNegative(m.buy_box_change_count_90d);
      const reviewShare = useReviews ? r / reviewSum : 0;
      const buyboxShare = useBuybox ? b / buyboxSum : 0;

      let weight: number;
      if (useReviews && useBuybox) {
        // Blended. Re-normalize by (review+buybox) so the configured
        // 0.4/0.6 ratio is preserved even if a deployment passes weights
        // that don't sum to 1.
        weight =
          (blend.review * reviewShare + blend.buybox * buyboxShare) / blendSum;
      } else if (useReviews) {
        weight = reviewShare;
      } else {
        weight = buyboxShare;
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
