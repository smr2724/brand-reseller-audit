/**
 * Quick correctness check on the recalibrated rank-bracket estimator.
 *
 * Asserts:
 *   • pickVelocityTier routes Beauty/Health/Grocery to "high"
 *   • Home/Pet/Office to "medium"
 *   • Tools/Industrial/Auto to "low"
 *   • A representative World Amenities-style ASIN (rank ~8k, $69) lands
 *     near the published Jungle Scout midpoint for Beauty BSR ≈ 8k.
 *
 * Run:
 *   npx tsx scripts/test-revenue-estimator.ts
 */
import {
  estimateBrandTtmRevenue,
  pickVelocityTier,
} from "../src/lib/enrichment/revenue-estimator";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
}

assert(pickVelocityTier("Beauty", null) === "high", "Beauty → high");
assert(pickVelocityTier("Health & Personal Care", null) === "high", "Health → high");
assert(pickVelocityTier("Grocery & Gourmet Food", null) === "high", "Grocery → high");
assert(pickVelocityTier("Baby Product", null) === "high", "Baby → high");
assert(pickVelocityTier("Home & Kitchen", null) === "medium", "Home → medium");
assert(pickVelocityTier("Pet Products", null) === "medium", "Pet → medium");
assert(pickVelocityTier("Office Product", null) === "medium", "Office → medium");
assert(pickVelocityTier("Sports & Outdoors", null) === "medium", "Sports → medium");
assert(pickVelocityTier("Tools & Home Improvement", null) === "low", "Tools → low");
assert(pickVelocityTier("Industrial & Scientific", null) === "low", "Industrial → low");
assert(pickVelocityTier("Automotive", null) === "low", "Auto → low");
assert(pickVelocityTier(null, "Patio, Lawn & Garden") === "low", "Patio path → low");
assert(pickVelocityTier(null, null) === "medium", "default → medium");

// World Amenities-style: rank ~8k, $69 buy-box, Beauty.
const out = estimateBrandTtmRevenue([
  {
    asin: "B0754KC9TP",
    sales_rank_avg365: 8443,
    sales_rank_current: 8443,
    buy_box_avg365: 69.15,
    buy_box_current: 69.15,
    buy_box_now: 69.15,
    product_group: "Beauty",
    root_category: 3760911,
    category_path: "Beauty & Personal Care",
  },
  {
    asin: "B081DJMVVB",
    sales_rank_avg365: 8441,
    sales_rank_current: 8441,
    buy_box_avg365: 12.8,
    buy_box_current: 12.8,
    buy_box_now: 12.8,
    product_group: "Beauty",
    root_category: 3760911,
    category_path: "Beauty & Personal Care",
  },
]);

console.log("Estimate result:", JSON.stringify(out, null, 2));
assert(out.total_ttm_revenue !== null, "produces an estimate");
assert(out.asins_in_sum === 2, "both asins in sum");
const r1 = out.per_asin[0];
assert(r1.velocity_tier === "high", "first asin tier=high");
// rank=8443 lives in "rank<10,000 → 400 units/mo" bracket (high tier)
assert(r1.monthly_units === 400, "rank=8443 → 400 u/mo (high tier)");
// 400 * 12 * 69.15 = 331,920
assert(r1.ttm_revenue === 331_920, "ttm = 331,920");

console.log("\nAll revenue-estimator tests passed.");
