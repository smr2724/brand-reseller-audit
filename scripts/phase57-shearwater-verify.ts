/**
 * Phase 57 — Shearwater Research pitch-math smoke test.
 *
 * Standalone verification that the server-side `computePitchMath` for
 * Shearwater (Segment 1, $1.27M TTM, 100% reseller-controlled) emits
 * the 100% recapture story — no legacy `recoverable_share`, no
 * "industry-standard reclaim" framing, no hedged dollars.
 *
 * Real DB re-qualification of brand_id e1cdf4a6-71c9-4637-9d1f-8e3c4db6356f
 * is triggered post-merge via /api/brands/[id]/qualify with force=true,
 * or by re-running scripts/phase57-backfill-pitch-math.ts --apply for
 * the no-narrative-touch path.
 *
 * Run:
 *   npx tsx scripts/phase57-shearwater-verify.ts
 */
import { computePitchMath } from "../src/lib/qualification/pitch-math";
import {
  narrativeTripsSanitizer,
  sanitizeNarrativeMarkdown,
} from "../src/lib/qualification/narrative-sanitizer";

const SHEARWATER = {
  brand_id: "e1cdf4a6-71c9-4637-9d1f-8e3c4db6356f",
  ttm_revenue_usd: 1_271_393,
  reseller_controlled_share: 1.0,
  segment: "reseller_controlled" as const,
};

const pm = computePitchMath(SHEARWATER);
if (!pm) {
  console.error("FAIL: computePitchMath returned null for Shearwater");
  process.exit(1);
}

console.log(`Brand: Shearwater Research (${SHEARWATER.brand_id})`);
console.log("Server-computed pitch_math:");
console.log(JSON.stringify(pm, null, 2));
console.log();

const failures: string[] = [];
if (pm.source !== "computeLegionEconomics") {
  failures.push(`source should be computeLegionEconomics, got ${pm.source}`);
}
if (pm.recoverable_revenue_usd !== pm.reseller_controlled_revenue_usd) {
  failures.push("recoverable_revenue_usd must equal reseller_controlled_revenue_usd (100% recapture)");
}
if ((pm as unknown as Record<string, unknown>)["recoverable_share"] != null) {
  failures.push("recoverable_share key must NOT be present");
}
if (pm.current_profit_margin !== 0.105) {
  failures.push(`current_profit_margin must be 0.105, got ${pm.current_profit_margin}`);
}
if (pm.post_capture_profit_margin !== 0.20) {
  failures.push(`post_capture_profit_margin must be 0.20, got ${pm.post_capture_profit_margin}`);
}
if (
  pm.post_capture_annual_profit_usd <= pm.current_annual_profit_usd * 1.8 ||
  pm.post_capture_annual_profit_usd >= pm.current_annual_profit_usd * 2.1
) {
  failures.push("post profit should ≈ 2× current profit (doubled)");
}

// Sanitizer dry-run on the hedged language we want to make impossible.
const badNarrative = `## Pitch math

The industry-standard reclaim is 60-70% in this category. Using 65% of $1,271,393 yields $826,406 recoverable. Recoverable share: 65%. Blended margin range 18-25%.`;

const sanitized = sanitizeNarrativeMarkdown(badNarrative);
console.log("Sanitizer dry-run on the legacy hedged narrative:");
console.log("  removed sentences:", sanitized.removed.length);
console.log("  cleaned still trips?", narrativeTripsSanitizer(sanitized.cleaned));
console.log("  cleaned:");
console.log(sanitized.cleaned);
console.log();
if (sanitized.removed.length === 0) {
  failures.push("sanitizer did not catch any of the legacy hedged sentences");
}
if (narrativeTripsSanitizer(sanitized.cleaned)) {
  failures.push("sanitizer output still trips its own forbidden-phrase list");
}

if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll Phase 57 Shearwater verification checks passed.");
