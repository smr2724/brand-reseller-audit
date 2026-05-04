/**
 * Keepa-derived TTM revenue estimator.
 *
 * Methodology (deliberately simple, defensible to a customer):
 *
 *   units_per_month = lookup(category_velocity, sales_rank)   // see RANK_TABLE_*
 *   asin_revenue    = units_per_month × 12 × buy_box_avg365
 *   brand_revenue   = sum(asin_revenue across enriched ASINs that had data)
 *
 * The rank → units lookup is a heuristic. Keepa does not expose a units-
 * sold field (only sales rank and price), and the public BSR curves vary
 * wildly by category. We use *category-aware* curves benchmarked against
 * publicly published estimator tables (Jungle Scout 2024 sales-rank-to-
 * units, Helium 10 Cerebro/Magnet calibration, AMZScout BSR curves).
 *
 * If Keepa returns no salesRank for an ASIN we exclude it from the sum
 * and log it. If fewer than 2 ASINs have rank+price data, we return
 * `null` so the report keeps the "— not measured" state rather than
 * extrapolating from a single noisy data point.
 *
 * The output is labeled as an estimate everywhere it is rendered, with
 * the source string "Keepa BSR + price · 365-day avg".
 */

export interface RevenueEstimateInput {
  asin: string;
  sales_rank_avg365: number | null;
  sales_rank_current: number | null;
  buy_box_avg365: number | null;
  buy_box_current: number | null;
  buy_box_now: number | null;
  product_group: string | null;
  root_category: number | null;
  category_path: string | null;
  /**
   * Phase 31 — variation-aware override. When provided, the estimator
   * uses this number directly as the per-ASIN monthly units (post the
   * group-max + review-velocity attribution) instead of re-deriving
   * from sales rank. This is how the report stops double-counting
   * variation siblings: a pallet ASIN whose sibling 4-pack drives all
   * the sales now lands at ~0 attributed units regardless of the
   * shared sales rank Keepa returns. Null means "fall through to the
   * legacy rank → units lookup". Zero is honored (intentional: a
   * variation that's been attributed nothing must produce $0 revenue).
   */
  attributed_monthly_units?: number | null;
  /**
   * Phase 31 — group size from variation attribution. Surfaced on the
   * per-ASIN result so the renderer can show a "Variation (1 of N)"
   * badge and the methodology disclosure subsection.
   */
  variation_group_size?: number | null;
}

export interface RevenueEstimatePerAsin {
  asin: string;
  sales_rank: number | null;
  buy_box_price: number | null;
  category_bucket: string;
  velocity_tier: VelocityTier | null;
  monthly_units: number | null;
  ttm_revenue: number | null;
  excluded_reason: string | null;
  /** Phase 31 — true when this ASIN belongs to a variation group of
   * size ≥ 2 and the monthly_units number reflects the post-attribution
   * value (group-max × review-velocity weight) rather than the raw
   * rank-derived estimate. Renderer uses this to surface the badge. */
  variation_attributed?: boolean;
  /** Phase 31 — number of siblings in the parent group, including self.
   * 1 for singletons. */
  variation_group_size?: number | null;
}

export interface RevenueEstimate {
  total_ttm_revenue: number | null;
  asins_in_sum: number;
  asins_excluded: number;
  per_asin: RevenueEstimatePerAsin[];
  excluded: { asin: string; reason: string }[];
  source_note: string;
  methodology_footnote: string;
  /** Phase 31 — true when at least one ASIN belongs to a variation
   * group of size ≥ 2 and the brand-level revenue therefore reflects
   * variation-aware attribution. Drives the methodology disclosure
   * subsection in the report renderer. */
  has_variation_attribution?: boolean;
}

// =============================================================
// Rank-bracket → monthly-units curves (category-aware)
// =============================================================
//
// Each tier is the *upper bound* of sales rank; the first bracket whose
// upper bound is > rank is selected. Numbers represent *monthly* units
// for an ASIN at that rank.
//
// Calibration sources (cross-checked across at least two of these for
// every bracket — none match exactly, so we picked the median band):
//   • Jungle Scout 2024 "BSR-to-units" public charts (Beauty, Health,
//     Grocery, Home & Kitchen, Tools, Industrial)
//   • Helium 10 Cerebro estimator (mid-tail Beauty/Health benchmarks)
//   • AMZScout BSR curve (used for slow-velocity Books/Industrial tail)
//   • Public seller forum discussions (Reddit r/FulfillmentByAmazon
//     2023-24 anecdotes for low-volume Tools/Auto SKUs)
//
// We deliberately bias toward the *lower* end of the public ranges in
// every category — better to under- than over-state a prospect's revenue
// in a sales doc.
//
// The previous (v1) table was effectively the SLOW table applied to all
// categories and consistently undercounted Beauty/Health by 4-8×.

export type VelocityTier = "high" | "medium" | "low";

type Bucket = { rank_lt: number; units: number };

/**
 * High-velocity categories: Beauty, Health & Personal Care, Grocery,
 * Baby. These are fast-moving CPG-style purchases with the steepest
 * BSR-to-units curves. World Amenities (makeup remover wipes) lives
 * here — and the user-confirmed >$1M/yr revenue against the previous
 * $205k estimate is the headline calibration data point.
 */
const TABLE_HIGH: Bucket[] = [
  { rank_lt: 100,        units: 8000 },
  { rank_lt: 500,        units: 5000 },
  { rank_lt: 1_000,      units: 3000 },
  { rank_lt: 5_000,      units: 1500 },
  { rank_lt: 10_000,     units: 800 },
  { rank_lt: 50_000,     units: 200 },
  { rank_lt: 100_000,    units: 60 },
  { rank_lt: 500_000,    units: 15 },
  { rank_lt: 1_000_000,  units: 4 },
  { rank_lt: 5_000_000,  units: 1 },
];

/**
 * Medium-velocity categories: Home & Kitchen, Pet, Office, Sports &
 * Outdoors, Toys, Apparel. Roughly 60% of the high-velocity curve at
 * the same rank — Jungle Scout's Home & Kitchen and Sports curves
 * consistently land in this band.
 */
const TABLE_MEDIUM: Bucket[] = [
  { rank_lt: 100,        units: 3600 },
  { rank_lt: 500,        units: 2100 },
  { rank_lt: 1_000,      units: 1200 },
  { rank_lt: 5_000,      units: 480 },
  { rank_lt: 10_000,     units: 240 },
  { rank_lt: 50_000,     units: 60 },
  { rank_lt: 100_000,    units: 21 },
  { rank_lt: 500_000,    units: 5 },
  { rank_lt: 1_000_000,  units: 1 },
];

/**
 * Low-velocity categories: Tools & Home Improvement, Industrial,
 * Automotive, Patio/Lawn, Books/Media. ~25% of the high-velocity
 * curve. Long-purchase-cycle items where a "decent" BSR rank still
 * implies modest unit throughput.
 */
const TABLE_LOW: Bucket[] = [
  { rank_lt: 100,        units: 1500 },
  { rank_lt: 500,        units: 875 },
  { rank_lt: 1_000,      units: 500 },
  { rank_lt: 5_000,      units: 200 },
  { rank_lt: 10_000,     units: 100 },
  { rank_lt: 50_000,     units: 25 },
  { rank_lt: 100_000,    units: 8 },
  { rank_lt: 500_000,    units: 2 },
  { rank_lt: 1_000_000,  units: 1 },
];

// Routing maps. Keepa's `productGroup` is the most reliable signal we
// get back; `categoryTree[0].name` (the root browse node name) is the
// fallback. We match on lowercase substring so "Beauty & Personal Care"
// and "Beauty" both route the same way.
const HIGH_KEYWORDS = [
  "beauty",
  "personal care",
  "health",
  "grocery",
  "gourmet",
  "baby",
];

const MEDIUM_KEYWORDS = [
  "home",
  "kitchen",
  "pet",
  "office",
  "sport",
  "outdoor",
  "toy",
  "apparel",
  "clothing",
  "shoe",
];

const LOW_KEYWORDS = [
  "tool",
  "industrial",
  "scientific",
  "automotive",
  "patio",
  "lawn",
  "garden",
  "book",
  "music",
  "dvd",
  "video game",
];

/**
 * Pick a velocity tier from a Keepa productGroup or root-category name.
 * Defaults to "medium" when nothing matches — better to land in the
 * middle of the distribution than to silently apply the slow curve.
 */
export function pickVelocityTier(
  productGroup: string | null | undefined,
  categoryPath: string | null | undefined,
): VelocityTier {
  const haystacks = [productGroup ?? "", categoryPath ?? ""]
    .map((s) => s.toLowerCase())
    .filter(Boolean);
  if (!haystacks.length) return "medium";

  const matchesAny = (kws: string[]) =>
    haystacks.some((h) => kws.some((kw) => h.includes(kw)));

  if (matchesAny(HIGH_KEYWORDS)) return "high";
  if (matchesAny(LOW_KEYWORDS)) return "low";
  if (matchesAny(MEDIUM_KEYWORDS)) return "medium";
  return "medium";
}

function tableFor(tier: VelocityTier): Bucket[] {
  if (tier === "high") return TABLE_HIGH;
  if (tier === "low") return TABLE_LOW;
  return TABLE_MEDIUM;
}

/**
 * Phase 31 — exposed to the enrichment writer so it can compute the same
 * pre-attribution monthly-units number we'd otherwise re-derive inside
 * `estimateBrandTtmRevenue`. The variation-attribution step then takes
 * `max(raw_monthly_units across siblings)` × per-child review weight to
 * produce the post-attribution number that's persisted on brand_asins
 * and consumed by the report.
 */
export function rankToMonthlyUnits(
  rank: number | null | undefined,
  productGroup: string | null | undefined,
  categoryPath: string | null | undefined,
): number | null {
  if (rank == null || !Number.isFinite(rank) || rank <= 0) return null;
  const tier = pickVelocityTier(productGroup, categoryPath);
  const table = tableFor(tier);
  return unitsForRank(rank, table);
}

function unitsForRank(rank: number, table: Bucket[]): number | null {
  if (!Number.isFinite(rank) || rank <= 0) return null;
  for (const b of table) {
    if (rank < b.rank_lt) return b.units;
  }
  return null; // rank > final bucket → effectively no sales
}

function bucketLabel(rank: number, table: Bucket[]): string {
  for (const b of table) {
    if (rank < b.rank_lt) return `rank<${b.rank_lt.toLocaleString("en-US")}`;
  }
  return "rank>cap";
}

// Phase 25 — relaxed from 2 to 1 so a brand with even a single
// rank+price-bearing ASIN gets a sized estimate (with the standard
// "directional" footnote) instead of falling back to all-null math.
// Two-ASIN floor was over-cautious for very small brands where the
// estimator's per-ASIN noise is dominated by category bias, not sample
// count.
const MIN_ASINS_FOR_ESTIMATE = 1;

export function estimateBrandTtmRevenue(
  asins: RevenueEstimateInput[],
): RevenueEstimate {
  const per_asin: RevenueEstimatePerAsin[] = [];
  const excluded: { asin: string; reason: string }[] = [];
  let total = 0;
  let inSum = 0;

  for (const a of asins) {
    const rank = a.sales_rank_avg365 ?? a.sales_rank_current;
    const price = a.buy_box_avg365 ?? a.buy_box_current ?? a.buy_box_now;
    const groupSize = a.variation_group_size ?? 1;
    const isVariation = (groupSize ?? 1) >= 2;
    const hasAttributionOverride =
      a.attributed_monthly_units != null &&
      Number.isFinite(a.attributed_monthly_units);

    if (!rank || rank <= 0) {
      // For variation siblings with an attribution override, the rank
      // is irrelevant — group volume is already pinned to the active
      // sibling's rank-derived number. We can still produce a per-ASIN
      // revenue line ($0 for inactive variations) instead of excluding.
      if (hasAttributionOverride && price && price > 0) {
        const monthly = a.attributed_monthly_units as number;
        const ttm = Math.round(monthly * 12 * price);
        total += ttm;
        inSum += 1;
        per_asin.push({
          asin: a.asin,
          sales_rank: null,
          buy_box_price: price,
          category_bucket: "variation",
          velocity_tier: null,
          monthly_units: monthly,
          ttm_revenue: ttm,
          excluded_reason: null,
          variation_attributed: isVariation,
          variation_group_size: groupSize,
        });
        continue;
      }
      excluded.push({ asin: a.asin, reason: "missing salesRank" });
      per_asin.push({
        asin: a.asin,
        sales_rank: null,
        buy_box_price: price ?? null,
        category_bucket: "—",
        velocity_tier: null,
        monthly_units: null,
        ttm_revenue: null,
        excluded_reason: "missing salesRank",
        variation_attributed: isVariation,
        variation_group_size: groupSize,
      });
      continue;
    }
    if (!price || price <= 0) {
      excluded.push({ asin: a.asin, reason: "missing buy-box price" });
      per_asin.push({
        asin: a.asin,
        sales_rank: rank,
        buy_box_price: null,
        category_bucket: "—",
        velocity_tier: null,
        monthly_units: null,
        ttm_revenue: null,
        excluded_reason: "missing buy-box price",
        variation_attributed: isVariation,
        variation_group_size: groupSize,
      });
      continue;
    }

    const tier = pickVelocityTier(a.product_group, a.category_path);
    const table = tableFor(tier);
    // Phase 31 — when variation attribution has supplied an override,
    // honor it (including 0 — an inactive pallet variation MUST produce
    // $0 revenue regardless of its shared sales rank). Otherwise fall
    // through to the legacy rank → units lookup.
    const monthly = hasAttributionOverride
      ? (a.attributed_monthly_units as number)
      : unitsForRank(rank, table);
    if (monthly == null) {
      excluded.push({ asin: a.asin, reason: "rank above table cap" });
      per_asin.push({
        asin: a.asin,
        sales_rank: rank,
        buy_box_price: price,
        category_bucket: bucketLabel(rank, table),
        velocity_tier: tier,
        monthly_units: null,
        ttm_revenue: null,
        excluded_reason: "rank above table cap",
        variation_attributed: isVariation,
        variation_group_size: groupSize,
      });
      continue;
    }

    const ttm = Math.round(monthly * 12 * price);
    total += ttm;
    inSum += 1;
    per_asin.push({
      asin: a.asin,
      sales_rank: rank,
      buy_box_price: price,
      category_bucket: bucketLabel(rank, table),
      velocity_tier: tier,
      monthly_units: monthly,
      ttm_revenue: ttm,
      excluded_reason: null,
      variation_attributed: isVariation && hasAttributionOverride,
      variation_group_size: groupSize,
    });
  }

  const haveEnough = inSum >= MIN_ASINS_FOR_ESTIMATE;
  const hasVariation = per_asin.some(
    (r) => (r.variation_group_size ?? 1) >= 2,
  );

  return {
    total_ttm_revenue: haveEnough ? total : null,
    asins_in_sum: inSum,
    asins_excluded: excluded.length,
    per_asin,
    excluded,
    source_note: hasVariation
      ? "Keepa BSR + price · 365-day avg · variation-aware (review-velocity weighted)"
      : "Keepa BSR + price · 365-day avg",
    methodology_footnote: hasVariation
      ? "Directional estimate from Keepa BSR + buy-box price, with variation-aware attribution (review-velocity weighting across parent groups). Replace with seller's actual TTM during diligence."
      : "Directional estimate from Keepa BSR + buy-box price. Replace with seller's actual TTM during diligence.",
    has_variation_attribution: hasVariation,
  };
}

/**
 * Phase 33.2 — pre-attributed input shape for the persisted-rows path.
 *
 * The writer (`enrichBrandWithKeepa`) already runs the variation-aware
 * attribution and persists the result on `brand_asins`. The report path
 * can sum directly from those columns without a second Keepa /product
 * round-trip. This function re-uses `estimateBrandTtmRevenue` under the
 * hood (so all the per-ASIN bookkeeping, the per_asin array shape, and
 * the `total_ttm_revenue` semantics are identical) — it just translates
 * the persisted-row shape to `RevenueEstimateInput` and overrides the
 * source/methodology strings to reflect the new path.
 *
 * Each input row carries the attributed monthly units and current buy
 * box price as already persisted on `brand_asins`. Sales rank is omitted
 * — when `attributed_monthly_units` is set, the underlying estimator
 * honors the override regardless of rank (the rank-null branch covers
 * this), and we don't want to introduce a second source of truth here.
 */
export interface PersistedRevenueRow {
  asin: string;
  attributed_monthly_units: number | null;
  buy_box_price: number | null;
  variation_group_size?: number | null;
  is_brand_controlled?: boolean | null;
}

export function estimateBrandTtmRevenueFromPersisted(
  rows: PersistedRevenueRow[],
): RevenueEstimate {
  const inputs: RevenueEstimateInput[] = rows.map((r) => ({
    asin: r.asin,
    sales_rank_avg365: null,
    sales_rank_current: null,
    buy_box_avg365: null,
    buy_box_current: null,
    buy_box_now: r.buy_box_price ?? null,
    product_group: null,
    root_category: null,
    category_path: null,
    attributed_monthly_units: r.attributed_monthly_units ?? null,
    variation_group_size: r.variation_group_size ?? 1,
  }));
  const base = estimateBrandTtmRevenue(inputs);
  return {
    ...base,
    source_note:
      "Keepa BSR + buy-box price · variation-aware (review-velocity weighted) · summed across full brand catalog",
    methodology_footnote:
      "Directional estimate from Keepa BSR + buy-box price, with variation-aware attribution (review-velocity weighting across parent groups). Summed across the full brand catalog persisted on brand_asins. Replace with seller's actual TTM during diligence.",
    has_variation_attribution: true,
  };
}
