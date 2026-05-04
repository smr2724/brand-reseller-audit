/**
 * Phase 31/32/32.1/36 — Variation-aware sales attribution.
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
 * Phase 32.1 — absent-Buy-Box-as-zero-signal.
 *   When at least one sibling in the group has a non-null Buy Box
 *   history value (`buy_box_change_count_90d` is a number, including
 *   0), any sibling whose value is **null** is interpreted as having
 *   no recent sales activity at all — not as missing data. That
 *   sibling's variation_weight collapses to 0 and the freed weight
 *   redistributes to the siblings that DO have BB data, in proportion
 *   to their combined review + Buy Box shares.
 *   Rationale: real-world failure case (H2O Therapy pallets) had
 *   review counts comparable to the active siblings but no Buy Box
 *   churn at all over 90 days. Treating null-BB-amongst-data-bearing-
 *   siblings as "missing signal" still left the pallets with their
 *   review-only slice (≈10% each). The brand owner confirmed the
 *   correct interpretation: a child with no BB winner changes while
 *   its siblings DO have BB activity has effectively sold nothing.
 *
 * Phase 36 — Trust Keepa monthlySold over variation attribution.
 *   When Keepa publishes a per-ASIN `monthlySold` value (Amazon's
 *   "X+ bought in past month" badge), that IS the per-ASIN truth —
 *   Amazon already attributed sales to that specific child variation.
 *   Running variation re-attribution on top of it inflates some siblings
 *   above their published badge and deflates others below it (Terra
 *   Pure: B0998YB54X published 700/mo, our pipeline produced 443.33).
 *   Phase 36 bypasses re-attribution for badged siblings: when
 *   `keepa_monthly_sold IS NOT NULL`, attributed_monthly_units is set
 *   to keepa_monthly_sold directly, weight=1, and the sibling does NOT
 *   participate in the group's weighted split. Non-badged siblings in
 *   the same group still split the group_max via review + Buy Box
 *   weighting (their pool is unchanged — see "simpler safe alternative"
 *   in the brief: badged ASINs are independent, not subtracted from
 *   the non-badged pool).
 *   Phase 32.1 zero-signal still wins: a sibling with a published
 *   badge but null Buy Box history while siblings have BB data is
 *   treated as zero (parent shells / dead pallets stay at 0).
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
 *        a. No sibling in the group has BB data (all null) → review-only
 *           weighting (Phase 31 behavior). With nothing to compare
 *           against, we have no evidence of zero activity.
 *        b. Σ recent_reviews = 0 across the group → Buy Box-only
 *           weighting.
 *        c. Both zero → equal weighting (1/N each).
 *      Phase 32.1 zero-signal rule: when at least one sibling has BB
 *      data, null-BB siblings receive weight 0 (excluded from the
 *      blended formula entirely).
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
  /** Phase 36 — Amazon's per-ASIN published "X+ bought in past month"
   * badge (Keepa `monthlySold`). When non-null this IS the per-ASIN
   * truth and the variation re-attribution split is bypassed for this
   * sibling (subject to Phase 32.1 zero-signal taking priority). Null
   * means "no badge published — fall through to BSR-curve weighting
   * with the rest of the variation group". */
  keepa_monthly_sold?: number | null;
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
    // Phase 36 — when Keepa published a per-ASIN monthlySold badge,
    // that IS the per-ASIN truth even for singletons; otherwise fall
    // back to the raw rank-derived estimate.
    if (size === 1) {
      const m = members[0];
      const badge = clampNonNegative(m.keepa_monthly_sold);
      const hasBadge =
        m.keepa_monthly_sold != null &&
        Number.isFinite(m.keepa_monthly_sold as number);
      const attributed = hasBadge
        ? badge
        : (m.raw_monthly_units ?? null);
      out.push({
        asin: m.asin,
        parent_asin: m.parent_asin ?? null,
        variation_group_size: 1,
        variation_weight: 1,
        raw_monthly_units: m.raw_monthly_units ?? null,
        attributed_monthly_units: attributed,
      });
      continue;
    }

    // Group volume = max across siblings (NOT sum — Keepa duplicates the
    // parent-level rank-derived estimate across children, so the
    // parent's true monthly volume is approximately the single shared
    // number). Phase 36 narrows the max to non-badged comparison
    // members below; the unconditional max stays here as the fallback
    // for groups where every sibling is badged or every sibling is a
    // zero-signal one.
    const groupMax = members.reduce(
      (acc, m) => Math.max(acc, clampNonNegative(m.raw_monthly_units)),
      0,
    );

    // Phase 32.1 — distinguish "Buy Box value is null/undefined" (no
    // signal recorded) from "Buy Box value is 0" (explicit zero churn,
    // which IS a valid data point). We can only invoke the zero-signal
    // rule when at least one sibling has a non-null BB value to compare
    // against.
    const groupHasAnyBuybox = members.some(
      (m) =>
        m.buy_box_change_count_90d !== null &&
        m.buy_box_change_count_90d !== undefined &&
        Number.isFinite(m.buy_box_change_count_90d as number),
    );

    // Phase 32.1: when the group has at least one BB data point and at
    // least one null-BB sibling, the null-BB siblings are interpreted
    // as "zero recent sales" and excluded from the weighting math
    // entirely (variation_weight = 0). The remaining "data-bearing"
    // siblings carry 100% of the group's attributed volume between
    // them, with shares computed from THEIR review and BB sums (the
    // zero-signal siblings' reviews are not counted in the denominator
    // — they're not part of the comparison set anymore).
    const zeroSignalAsins = new Set<string>();
    if (groupHasAnyBuybox) {
      for (const m of members) {
        const bbIsNull =
          m.buy_box_change_count_90d === null ||
          m.buy_box_change_count_90d === undefined ||
          !Number.isFinite(m.buy_box_change_count_90d as number);
        if (bbIsNull) zeroSignalAsins.add(m.asin);
      }
    }

    // Phase 36 — siblings with a Keepa-published `monthlySold` badge
    // are Amazon's truth: bypass variation re-attribution entirely.
    // They get attributed_monthly_units = keepa_monthly_sold and do
    // NOT participate in the group's weighted split. The "simpler safe
    // alternative" from the brief: badged siblings are independent of
    // the non-badged pool — non-badged siblings still split the full
    // group_max via review+BB weights. This errs toward trusting
    // Amazon's published numbers.
    // Phase 32.1 zero-signal still wins: a badged sibling that is also
    // a null-BB-amongst-data-bearing-siblings sibling stays at 0.
    const badgedAsins = new Set<string>();
    for (const m of members) {
      if (zeroSignalAsins.has(m.asin)) continue; // 32.1 wins
      if (
        m.keepa_monthly_sold != null &&
        Number.isFinite(m.keepa_monthly_sold as number)
      ) {
        badgedAsins.add(m.asin);
      }
    }

    // Sums computed across the comparison set: when the zero-signal
    // rule fires, we exclude null-BB siblings; otherwise this is the
    // full group (Phase 32 behavior). Phase 36 also excludes badged
    // siblings from the comparison set because they don't participate
    // in the weighted split — only non-badged siblings need a share
    // of the rank-derived group_max.
    const comparisonMembers = members.filter(
      (m) => !zeroSignalAsins.has(m.asin) && !badgedAsins.has(m.asin),
    );

    const reviewSum = comparisonMembers.reduce(
      (acc, m) => acc + clampNonNegative(m.recent_review_count),
      0,
    );
    const buyboxSum = comparisonMembers.reduce(
      (acc, m) => acc + clampNonNegative(m.buy_box_change_count_90d),
      0,
    );
    const equalWeight = 1 / size;
    const equalDataBearingWeight = comparisonMembers.length > 0
      ? 1 / comparisonMembers.length
      : 0;

    // Decide which signal(s) drive the weights for this group.
    //   Both > 0 → blended (default 0.4 review + 0.6 Buy Box).
    //   Only reviews > 0 → review-only (Phase 31 behavior, the brief's
    //                       "no Buy Box data anywhere in the group" fallback).
    //   Only Buy Box > 0 → Buy Box-only.
    //   Both 0 → equal weighting (across the comparison set when
    //            zero-signal fired, otherwise across the whole group).
    const useReviews = reviewSum > 0;
    const useBuybox = buyboxSum > 0;

    if (!useReviews && !useBuybox) {
      // Edge case (c): both signals empty across the comparison set.
      // Distribute equal weight across the comparison set; zero-signal
      // and badged siblings are handled separately below.
      const restrictedComparison =
        zeroSignalAsins.size > 0 || badgedAsins.size > 0;
      for (const m of members) {
        if (zeroSignalAsins.has(m.asin)) {
          out.push({
            asin: m.asin,
            parent_asin: m.parent_asin ?? null,
            variation_group_size: size,
            variation_weight: 0,
            raw_monthly_units: m.raw_monthly_units ?? null,
            attributed_monthly_units: 0,
          });
          continue;
        }
        if (badgedAsins.has(m.asin)) {
          out.push({
            asin: m.asin,
            parent_asin: m.parent_asin ?? null,
            variation_group_size: size,
            variation_weight: 1,
            raw_monthly_units: m.raw_monthly_units ?? null,
            attributed_monthly_units: clampNonNegative(m.keepa_monthly_sold),
          });
          continue;
        }
        const w = restrictedComparison ? equalDataBearingWeight : equalWeight;
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
    // brands stuck in the fallback. Note: groupHasAnyBuybox=false is
    // the genuine "no BB anywhere" case worth surfacing; when the
    // zero-signal rule fired we *do* have BB data — useBuybox=false
    // there would mean every data-bearing sibling had BB=0, which is
    // valid data, not a fallback.
    if (useReviews && !useBuybox && !groupHasAnyBuybox) {
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
      if (zeroSignalAsins.has(m.asin)) {
        out.push({
          asin: m.asin,
          parent_asin: m.parent_asin ?? null,
          variation_group_size: size,
          variation_weight: 0,
          raw_monthly_units: m.raw_monthly_units ?? null,
          attributed_monthly_units: 0,
        });
        continue;
      }
      if (badgedAsins.has(m.asin)) {
        // Phase 36 — Amazon's published per-ASIN monthlySold badge wins
        // over the variation re-attribution split. Weight=1 here is a
        // marker that the value is independent of the group's pool;
        // group weights no longer have to sum to 1 when badged
        // siblings are present (each badged sibling carries its own
        // self-contained number).
        out.push({
          asin: m.asin,
          parent_asin: m.parent_asin ?? null,
          variation_group_size: size,
          variation_weight: 1,
          raw_monthly_units: m.raw_monthly_units ?? null,
          attributed_monthly_units: clampNonNegative(m.keepa_monthly_sold),
        });
        continue;
      }

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
