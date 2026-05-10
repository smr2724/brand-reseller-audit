/**
 * Phase 56 — Shearwater Research re-qualification smoke test.
 *
 * Standalone verification that the deterministic segmentation function
 * routes Shearwater's known channel pattern to Segment 1
 * (reseller_controlled) → opportunity mode → qualified verdict, which
 * is the inverse of the pre-Phase-56 LLM behavior ("skip this one").
 *
 * Real DB re-qualification requires SUPABASE + OPENAI keys; this script
 * proves the routing logic in isolation. Steve runs the live
 * re-qualification post-merge via the existing /api/brands/[id]/qualify
 * endpoint or the orchestrator triggers.
 *
 * Run:
 *   npx tsx scripts/phase56-shearwater-verify.ts
 */
import {
  computeSegment,
  SEGMENT_LABEL,
} from "../src/lib/qualification/segments";

const SHEARWATER = {
  brand_id: "e1cdf4a6-71c9-4637-9d1f-8e3c4db6356f",
  // Per the Phase 56 brief: 0% brand-controlled buy box, 9 independent
  // resellers, no Amazon retail presence, $1.27M TTM.
  brand_owned_pct: 0,
  authorized_pct: 0,
  unauthorized_pct: 100,
  amazon_pct: 0,
  ttm_revenue_usd: 1_270_000,
  has_trademark: true,
  is_anti_amazon: false,
  is_enterprise_pe_public: false,
};

const result = computeSegment(SHEARWATER);

console.log(`Brand: Shearwater Research (${SHEARWATER.brand_id})`);
console.log(`TTM revenue: $${SHEARWATER.ttm_revenue_usd.toLocaleString()}`);
console.log(
  `Channel shares: brand_owned ${SHEARWATER.brand_owned_pct}% | authorized ${SHEARWATER.authorized_pct}% | unauthorized ${SHEARWATER.unauthorized_pct}% | amazon ${SHEARWATER.amazon_pct}%`,
);
console.log(`\nSegment: ${result.segment} (${SEGMENT_LABEL[result.segment]})`);
console.log(`Qualified: ${result.qualified}`);
console.log(`Report mode: ${result.report_mode}`);
console.log(`Reason: ${result.reason}`);

if (result.segment !== "reseller_controlled") {
  console.error("\nFAIL: expected reseller_controlled");
  process.exit(1);
}
if (!result.qualified) {
  console.error("\nFAIL: expected qualified=true");
  process.exit(1);
}
if (result.report_mode !== "opportunity") {
  console.error("\nFAIL: expected report_mode='opportunity'");
  process.exit(1);
}

console.log("\nPASS — Shearwater routes to Segment 1 (opportunity mode).");
console.log(
  "Pre-Phase-56 LLM said \"skip this one\". Post-Phase-56 deterministic segmentation says: IDEAL CUSTOMER.",
);
