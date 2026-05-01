/**
 * Legion Score Engine
 *
 * The scoring model encodes Steve's Legion Chemicals thesis: find categories
 * where real demand meets weak Amazon execution with a genuine product-advantage path.
 *
 * Total: 100 points
 *   Demand:             20
 *   Competition Weak:   20  (higher = weaker competition = better)
 *   Product Advantage:  20  (AI-assisted, manually editable)
 *   Visual Demo:        15
 *   Economics:          15
 *   Partner Availability:10
 */

export type RecommendedPath = "partner" | "launch" | "acquire" | "avoid";

export interface ProductRow {
  asin?: string | null;
  title?: string | null;
  brand?: string | null;
  price?: number | null;
  rating?: number | null;
  review_count?: number | null;
  image_url?: string | null;
  is_sponsored?: boolean | null;
  position?: number | null;
}

export interface KeywordRow {
  keyword: string;
  search_volume?: number | null;
  intent_type?: string | null;
}

export interface ScoringInput {
  seedKeyword: string;
  keywords: KeywordRow[];
  products: ProductRow[];
  /** Optional human/AI override for product-advantage score 0..20 */
  productAdvantageOverride?: number;
  /** Optional human/AI override for visual-demo score 0..15 */
  visualDemoOverride?: number;
  /** Optional human/AI override for partner score 0..10 */
  partnerOverride?: number;
}

export interface ScoringResult {
  legion_score: number;
  demand_score: number;
  competition_weakness_score: number;
  product_advantage_score: number;
  visual_demo_score: number;
  economics_score: number;
  partner_score: number;
  recommended_path: RecommendedPath;
  metrics: {
    monthly_search_volume: number;
    total_cluster_search_volume: number;
    top_10_avg_reviews: number;
    top_10_avg_rating: number;
    avg_price: number;
    weak_review_count_products: number;
    mediocre_rating_products: number;
    high_intent_keyword_count: number;
  };
}

// -----------------------------------------------------------------------------
// Heuristics: category/content signals
// -----------------------------------------------------------------------------

const VISUAL_DEMO_KEYWORDS = [
  "remover", "stain", "cleaner", "clean", "rust", "concrete", "graffiti",
  "mold", "mildew", "degreaser", "grease", "oil", "adhesive", "glue",
  "paint", "stripper", "descaler", "scale", "hard water", "odor", "smell",
  "deodorizer", "polish", "wax", "restore", "restoration",
];

const INDUSTRIAL_PARTNER_KEYWORDS = [
  "commercial", "industrial", "contractor", "construction", "chemical",
  "concrete", "asphalt", "floor", "janitorial", "facility", "restoration",
  "kitchen", "hvac", "boiler", "descaler", "marine", "rv", "fleet",
  "equipment", "manufacturing",
];

const HIGH_INTENT_KEYWORDS = [
  "remover", "cleaner", "stripper", "degreaser", "descaler", "deodorizer",
  "eliminator", "treatment", "solution", "best", "for", "how to",
];

// Category signals that hint at commodity / emotional-brand territory (lower partner score)
const COMMODITY_SOFT_SIGNALS = [
  "laundry", "dish soap", "hand soap", "body wash", "shampoo", "perfume",
  "cologne", "makeup", "skincare", "toothpaste", "cereal",
];

// -----------------------------------------------------------------------------
// Demand Score (0..20)
// -----------------------------------------------------------------------------
export function calcDemandScore(keywords: KeywordRow[], seedKeyword: string) {
  const seedVol = keywords.find(k => k.keyword.toLowerCase() === seedKeyword.toLowerCase())?.search_volume ?? 0;
  const clusterVol = keywords.reduce((s, k) => s + (k.search_volume ?? 0), 0);
  const highIntent = keywords.filter(k => {
    const kw = k.keyword.toLowerCase();
    return HIGH_INTENT_KEYWORDS.some(h => kw.includes(h));
  });
  const highIntentCount = highIntent.length;

  // Volume buckets
  let volScore = 0;
  if (clusterVol >= 80_000) volScore = 12;
  else if (clusterVol >= 30_000) volScore = 10;
  else if (clusterVol >= 10_000) volScore = 8;
  else if (clusterVol >= 3_000) volScore = 6;
  else if (clusterVol >= 1_000) volScore = 3;
  else volScore = 1;

  // Seed keyword bonus
  let seedScore = 0;
  if (seedVol >= 20_000) seedScore = 4;
  else if (seedVol >= 5_000) seedScore = 3;
  else if (seedVol >= 1_000) seedScore = 2;
  else if (seedVol >= 200) seedScore = 1;

  // High-intent keyword bonus
  let intentScore = 0;
  if (highIntentCount >= 25) intentScore = 4;
  else if (highIntentCount >= 15) intentScore = 3;
  else if (highIntentCount >= 8) intentScore = 2;
  else if (highIntentCount >= 3) intentScore = 1;

  return { score: clamp(volScore + seedScore + intentScore, 0, 20), seedVol, clusterVol, highIntentCount };
}

// -----------------------------------------------------------------------------
// Competition Weakness Score (0..20) — HIGHER = WEAKER = BETTER
// -----------------------------------------------------------------------------
export function calcCompetitionWeaknessScore(products: ProductRow[]) {
  const top10 = products.slice(0, 10);
  if (top10.length === 0) return { score: 10, avgReviews: 0, avgRating: 0, weakReviewCount: 0, mediocreRatingCount: 0 };

  const avgReviews = avg(top10.map(p => p.review_count ?? 0));
  const avgRating = avg(top10.map(p => p.rating ?? 0).filter(r => r > 0));
  // Steve's rule: <300 reviews = immediate opportunity
  const weakReviewCount = top10.filter(p => (p.review_count ?? 0) < 300).length;
  const mediocreRatingCount = top10.filter(p => (p.rating ?? 5) < 4.3).length;

  // Reviews component (0..10): fewer avg reviews = more opportunity
  // Steve's rule: <300 avg reviews = the sweet spot
  let reviewsComp = 0;
  if (avgReviews <= 100) reviewsComp = 10;
  else if (avgReviews <= 300) reviewsComp = 8;
  else if (avgReviews <= 750) reviewsComp = 5;
  else if (avgReviews <= 2_000) reviewsComp = 2;
  else reviewsComp = 0;

  // Rating component (0..5): lower avg rating = more opportunity (but not too low — indicates bad category)
  let ratingComp = 0;
  if (avgRating === 0) ratingComp = 3;
  else if (avgRating < 4.0) ratingComp = 5;
  else if (avgRating < 4.3) ratingComp = 4;
  else if (avgRating < 4.5) ratingComp = 2;
  else ratingComp = 0;

  // Fragmentation (0..4): count of weak-review products in top 10
  let fragComp = 0;
  if (weakReviewCount >= 6) fragComp = 4;
  else if (weakReviewCount >= 4) fragComp = 3;
  else if (weakReviewCount >= 2) fragComp = 2;
  else if (weakReviewCount >= 1) fragComp = 1;

  // Brand-dominance penalty: if any single product has >5k reviews AND rating >=4.5, page one has an entrenched winner
  const hasKing = top10.some(p => (p.review_count ?? 0) >= 5_000 && (p.rating ?? 0) >= 4.5);
  const kingPenalty = hasKing ? -6 : 0;

  // Mediocre-rating bonus (0..3)
  let mediocreBonus = 0;
  if (mediocreRatingCount >= 4) mediocreBonus = 3;
  else if (mediocreRatingCount >= 2) mediocreBonus = 2;
  else if (mediocreRatingCount >= 1) mediocreBonus = 1;

  // Hard cap: if avg reviews >= 1000, this is no longer a Legion-shape category — score capped at 6
  const tooManyReviewsCap = avgReviews >= 1_000 ? 6 : 20;

  const raw = reviewsComp + ratingComp + fragComp + mediocreBonus + kingPenalty;
  return {
    score: clamp(Math.min(raw, tooManyReviewsCap), 0, 20),
    avgReviews,
    avgRating,
    weakReviewCount,
    mediocreRatingCount,
  };
}

// -----------------------------------------------------------------------------
// Product Advantage Score (0..20) — AI-assisted, overridable
// Heuristic baseline: boost for "problem-solving" keywords, penalize commodity
// -----------------------------------------------------------------------------
export function calcProductAdvantageBaseline(seedKeyword: string, products: ProductRow[]) {
  const kw = seedKeyword.toLowerCase();
  let score = 10; // neutral baseline

  const problemSolvers = ["remover", "stripper", "cleaner", "degreaser", "descaler", "eliminator", "treatment"];
  if (problemSolvers.some(p => kw.includes(p))) score += 5;
  if (INDUSTRIAL_PARTNER_KEYWORDS.some(p => kw.includes(p))) score += 3;
  if (COMMODITY_SOFT_SIGNALS.some(c => kw.includes(c))) score -= 6;

  // If top-10 avg rating is mediocre, product-advantage upside is real
  const top10 = products.slice(0, 10);
  const avgRating = avg(top10.map(p => p.rating ?? 0).filter(r => r > 0));
  if (avgRating > 0 && avgRating < 4.2) score += 3;
  if (avgRating >= 4.6) score -= 3;

  return clamp(score, 0, 20);
}

// -----------------------------------------------------------------------------
// Visual Demo Score (0..15)
// -----------------------------------------------------------------------------
export function calcVisualDemoBaseline(seedKeyword: string) {
  const kw = seedKeyword.toLowerCase();
  let score = 6; // neutral baseline
  const matches = VISUAL_DEMO_KEYWORDS.filter(v => kw.includes(v)).length;
  if (matches >= 2) score = 14;
  else if (matches === 1) score = 11;
  // Penalize obvious non-visual categories
  if (["insurance", "service", "software", "consulting", "subscription"].some(c => kw.includes(c))) score -= 6;
  return clamp(score, 0, 15);
}

// -----------------------------------------------------------------------------
// Economics Score (0..15)
// -----------------------------------------------------------------------------
export function calcEconomicsScore(products: ProductRow[], seedKeyword: string) {
  const top10 = products.slice(0, 10);
  const prices = top10.map(p => p.price ?? 0).filter(p => p > 0);
  const avgPrice = avg(prices);
  const kw = seedKeyword.toLowerCase();

  let score = 0;
  // Price point (0..6)
  if (avgPrice >= 25 && avgPrice <= 150) score += 6;
  else if (avgPrice >= 15 && avgPrice < 25) score += 4;
  else if (avgPrice > 150 && avgPrice <= 400) score += 4;
  else if (avgPrice >= 8 && avgPrice < 15) score += 2;
  else score += 1;

  // Consumable / repeat-purchase potential (0..5)
  const consumableSignals = ["remover", "cleaner", "degreaser", "stripper", "descaler", "deodorizer", "treatment", "chemical", "solution"];
  if (consumableSignals.some(c => kw.includes(c))) score += 5;

  // Multi-size potential (0..2)
  const sizeSignals = ["commercial", "industrial", "gallon", "bucket", "bulk"];
  if (sizeSignals.some(s => kw.includes(s)) || consumableSignals.some(c => kw.includes(c))) score += 2;

  // Hazmat / heavy-shipping penalty (0..-4)
  const hazmatSignals = ["acid", "corrosive", "flammable", "aerosol", "battery", "lithium"];
  if (hazmatSignals.some(h => kw.includes(h))) score -= 3;

  // Ability to support ads — if avg price >= $20 it's fine
  if (avgPrice >= 20) score += 2;

  return { score: clamp(score, 0, 15), avgPrice };
}

// -----------------------------------------------------------------------------
// Partner / Acquisition Availability (0..10)
// -----------------------------------------------------------------------------
export function calcPartnerBaseline(seedKeyword: string, products: ProductRow[]) {
  const kw = seedKeyword.toLowerCase();
  let score = 4; // neutral baseline
  const industrialMatches = INDUSTRIAL_PARTNER_KEYWORDS.filter(i => kw.includes(i)).length;
  if (industrialMatches >= 2) score += 5;
  else if (industrialMatches === 1) score += 3;

  // If top brands look like small/unknown sellers, acquisition path is plausible
  const top10 = products.slice(0, 10);
  const brands = new Set(top10.map(p => (p.brand || "").toLowerCase()).filter(Boolean));
  if (brands.size >= 6) score += 2; // fragmented = many small sellers
  if (COMMODITY_SOFT_SIGNALS.some(c => kw.includes(c))) score -= 4;

  return clamp(score, 0, 10);
}

// -----------------------------------------------------------------------------
// Recommended Path Logic
// -----------------------------------------------------------------------------
export function decidePath(r: {
  legion_score: number;
  demand_score: number;
  competition_weakness_score: number;
  product_advantage_score: number;
  economics_score: number;
  partner_score: number;
}): RecommendedPath {
  const { legion_score, demand_score, competition_weakness_score, product_advantage_score, economics_score, partner_score } = r;

  // AVOID first — cut losses fast
  if (legion_score < 50) return "avoid";
  if (demand_score < 6 && competition_weakness_score < 8) return "avoid";
  if (economics_score < 5) return "avoid";

  // PARTNER: strong demand + weak exec + product matters + industrial
  if (partner_score >= 7 && product_advantage_score >= 13 && demand_score >= 10 && competition_weakness_score >= 10) {
    return "partner";
  }

  // ACQUIRE: weak competition + fragmented, moderate demand, enough partner signal implies small sellers
  if (competition_weakness_score >= 14 && partner_score >= 5 && product_advantage_score < 15) {
    return "acquire";
  }

  // LAUNCH: demand exists, competition weak enough, product advantage plausible, economics work
  if (demand_score >= 10 && competition_weakness_score >= 10 && product_advantage_score >= 10 && economics_score >= 8) {
    return "launch";
  }

  // Default: if legion_score is reasonable but nothing dominant, bias toward partner for industrial cues
  if (partner_score >= 6) return "partner";
  return "launch";
}

// -----------------------------------------------------------------------------
// Orchestrator
// -----------------------------------------------------------------------------
export function scoreOpportunity(input: ScoringInput): ScoringResult {
  const demand = calcDemandScore(input.keywords, input.seedKeyword);
  const comp = calcCompetitionWeaknessScore(input.products);
  const productAdvBase = calcProductAdvantageBaseline(input.seedKeyword, input.products);
  const productAdv = input.productAdvantageOverride ?? productAdvBase;
  const visualBase = calcVisualDemoBaseline(input.seedKeyword);
  const visual = input.visualDemoOverride ?? visualBase;
  const econ = calcEconomicsScore(input.products, input.seedKeyword);
  const partnerBase = calcPartnerBaseline(input.seedKeyword, input.products);
  const partner = input.partnerOverride ?? partnerBase;

  const legion = demand.score + comp.score + productAdv + visual + econ.score + partner;

  const recommended_path = decidePath({
    legion_score: legion,
    demand_score: demand.score,
    competition_weakness_score: comp.score,
    product_advantage_score: productAdv,
    economics_score: econ.score,
    partner_score: partner,
  });

  return {
    legion_score: Math.round(legion),
    demand_score: demand.score,
    competition_weakness_score: comp.score,
    product_advantage_score: productAdv,
    visual_demo_score: visual,
    economics_score: econ.score,
    partner_score: partner,
    recommended_path,
    metrics: {
      monthly_search_volume: demand.seedVol,
      total_cluster_search_volume: demand.clusterVol,
      top_10_avg_reviews: Math.round(comp.avgReviews),
      top_10_avg_rating: round(comp.avgRating, 2),
      avg_price: round(econ.avgPrice, 2),
      weak_review_count_products: comp.weakReviewCount,
      mediocre_rating_products: comp.mediocreRatingCount,
      high_intent_keyword_count: demand.highIntentCount,
    },
  };
}

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------
function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
function avg(nums: number[]) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function round(n: number, d: number) {
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
}

export function scoreToThreshold(legion: number): "deep_dive" | "review" | "watchlist" | "reject" {
  if (legion >= 80) return "deep_dive";
  if (legion >= 65) return "review";
  if (legion >= 50) return "watchlist";
  return "reject";
}
