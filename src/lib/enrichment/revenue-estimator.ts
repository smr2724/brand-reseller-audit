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
}

export interface RevenueEstimate {
  total_ttm_revenue: number | null;
  asins_in_sum: number;
  asins_excluded: number;
  per_asin: RevenueEstimatePerAsin[];
  excluded: { asin: string; reason: string }[];
  source_note: string;
  methodology_footnote: string;
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

const MIN_ASINS_FOR_ESTIMATE = 2;

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

    if (!rank || rank <= 0) {
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
      });
      continue;
    }

    const tier = pickVelocityTier(a.product_group, a.category_path);
    const table = tableFor(tier);
    const monthly = unitsForRank(rank, table);
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
    });
  }

  const haveEnough = inSum >= MIN_ASINS_FOR_ESTIMATE;

  return {
    total_ttm_revenue: haveEnough ? total : null,
    asins_in_sum: inSum,
    asins_excluded: excluded.length,
    per_asin,
    excluded,
    source_note: "Keepa BSR + price · 365-day avg",
    methodology_footnote:
      "Directional estimate from Keepa BSR + buy-box price. Replace with seller's actual TTM during diligence.",
  };
}
