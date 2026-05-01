/**
 * Keepa-derived TTM revenue estimator.
 *
 * Methodology (deliberately simple, defensible to a customer):
 *
 *   units_per_month = lookup(category, sales_rank)        // see RANK_TABLE
 *   asin_revenue    = units_per_month × 12 × buy_box_avg365
 *   brand_revenue   = sum(asin_revenue across enriched ASINs that had data)
 *
 * The rank → units lookup is intentionally crude. Keepa does not expose
 * a units-sold field (only sales rank and price), and the public BSR
 * curves vary wildly by category. Buying a paid units estimate is the
 * obvious next step; until then we use a published bracket table that
 * is accurate to the right order of magnitude across most categories.
 *
 * If Keepa returns no salesRank for an ASIN we exclude it from the sum
 * and log it. If fewer than 2 ASINs have rank+price data, we return
 * `null` so the report keeps the "— not measured" state rather than
 * extrapolating from a single noisy data point.
 *
 * The output is labeled as an estimate everywhere it is rendered, with
 * the source string "Keepa salesRank+price · 365-day avg".
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

/**
 * Rank-bracket → monthly-units lookup. Numbers are intentionally
 * conservative for everyday consumer-product categories; Books and
 * Industrial are slower-moving so they get tighter brackets. Each
 * bracket is the *upper bound* of sales rank; the first bracket whose
 * upper bound is > rank is selected.
 *
 * Sources crosschecked against publicly available estimator tables:
 * Jungle Scout 2024 BSR-to-sales for "Beauty & Personal Care" and
 * "Health & Household" — the categories World Amenities sells in.
 */
type Bucket = { rank_lt: number; units: number };

const TABLE_DEFAULT: Bucket[] = [
  { rank_lt: 100,        units: 3000 },
  { rank_lt: 500,        units: 1500 },
  { rank_lt: 1_000,      units: 800 },
  { rank_lt: 5_000,      units: 250 },
  { rank_lt: 10_000,     units: 150 },
  { rank_lt: 50_000,     units: 60 },
  { rank_lt: 100_000,    units: 25 },
  { rank_lt: 500_000,    units: 8 },
  { rank_lt: 1_000_000,  units: 4 },
  { rank_lt: 5_000_000,  units: 1 },
];

// Slower-velocity tail categories (Books/CDs/Industrial). Roughly half
// the velocity of the default table at the same rank.
const TABLE_SLOW: Bucket[] = [
  { rank_lt: 100,        units: 1500 },
  { rank_lt: 500,        units: 700 },
  { rank_lt: 1_000,      units: 350 },
  { rank_lt: 5_000,      units: 100 },
  { rank_lt: 10_000,     units: 50 },
  { rank_lt: 50_000,     units: 20 },
  { rank_lt: 100_000,    units: 8 },
  { rank_lt: 500_000,    units: 3 },
  { rank_lt: 1_000_000,  units: 1 },
];

const SLOW_GROUPS = new Set([
  "Book", "Books", "eBooks", "Music", "DVD", "Video Games", "Office Product",
  "Industrial", "Lawn & Patio", "Tools & Home Improvement",
]);

function pickTable(productGroup: string | null): Bucket[] {
  if (!productGroup) return TABLE_DEFAULT;
  return SLOW_GROUPS.has(productGroup) ? TABLE_SLOW : TABLE_DEFAULT;
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
        monthly_units: null,
        ttm_revenue: null,
        excluded_reason: "missing buy-box price",
      });
      continue;
    }

    const table = pickTable(a.product_group);
    const monthly = unitsForRank(rank, table);
    if (monthly == null) {
      excluded.push({ asin: a.asin, reason: "rank above table cap" });
      per_asin.push({
        asin: a.asin,
        sales_rank: rank,
        buy_box_price: price,
        category_bucket: bucketLabel(rank, table),
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
    source_note: "Keepa salesRank+price · 365-day avg",
    methodology_footnote:
      "Estimate from Keepa BSR + buy-box price. Replace with seller's actual TTM in deal terms.",
  };
}
