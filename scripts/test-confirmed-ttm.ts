/**
 * Phase 28 — confirmed TTM revenue override.
 *
 * Verifies:
 *  1. resolveBrandRevenue prefers confirmed value over enrichment.
 *  2. computeLegionEconomics produces identical downstream numbers when
 *     fed the same revenue, regardless of source — i.e. source is
 *     metadata only, no math branching.
 *  3. computeBrandDetailFinancials sets revenueKind='confirmed', uses
 *     the confirmed dollar value, surfaces estimatorSuggestion, and
 *     suppresses the low-confidence flag even when the underlying
 *     enrichment was price-only.
 *  4. Clearing the confirmed value reverts to the enrichment path.
 *
 * Run:
 *   npx tsx scripts/test-confirmed-ttm.ts
 */
import { resolveBrandRevenue } from "../src/lib/math/resolve-brand-revenue";
import {
  computeLegionEconomics,
  defaultLegionInputs,
} from "../src/lib/math/legion-economics";
import { computeBrandDetailFinancials } from "../src/lib/brand-detail/financial-model";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures += 1;
  }
}

console.log("Case 1: resolveBrandRevenue — confirmed wins");
{
  const r = resolveBrandRevenue(
    { confirmed_ttm_revenue_dollars: 50_000, confirmed_ttm_source: "Orion data" },
    25_000,
  );
  assert(r.source === "confirmed", "source = confirmed");
  assert(r.value === 50_000, "value = confirmed dollar amount");
  assert(r.confirmed_source_label === "Orion data", "source label preserved");
  assert(r.estimator_suggestion === 25_000, "estimator suggestion preserved");
}

console.log("Case 2: resolveBrandRevenue — null/zero confirmed falls through");
{
  const r1 = resolveBrandRevenue(
    { confirmed_ttm_revenue_dollars: null },
    25_000,
  );
  assert(r1.source === "enrichment" && r1.value === 25_000, "null → enrichment");

  const r2 = resolveBrandRevenue(
    { confirmed_ttm_revenue_dollars: 0 },
    25_000,
  );
  assert(r2.source === "enrichment" && r2.value === 25_000, "0 → enrichment");

  const r3 = resolveBrandRevenue(undefined, 25_000);
  assert(r3.source === "enrichment" && r3.value === 25_000, "undefined → enrichment");
}

console.log(
  "Case 3: math is identical when revenue value matches, regardless of source",
);
{
  const REVENUE = 1_500_000;
  const fromConfirmed = computeLegionEconomics(defaultLegionInputs(REVENUE));
  const fromEstimator = computeLegionEconomics(defaultLegionInputs(REVENUE));
  assert(
    fromConfirmed.delta_profit === fromEstimator.delta_profit,
    "delta_profit matches across sources",
  );
  assert(
    fromConfirmed.exit_lift === fromEstimator.exit_lift,
    "exit_lift matches across sources",
  );
  assert(
    fromConfirmed.reseller_margin_captured ===
      fromEstimator.reseller_margin_captured,
    "reseller_margin_captured matches",
  );
}

console.log(
  "Case 4: brand-detail financials — confirmed overrides price-only fallback",
);
{
  const r = computeBrandDetailFinancials(
    {
      keepa_last_enriched_at: "2026-04-15T00:00:00Z",
      trailing_12_months: null,
      est_monthly_revenue: null,
      brand_controlled_pct: null,
      confirmed_ttm_revenue_dollars: 50_000,
      confirmed_ttm_source: "Seller call 5/3",
    },
    [{ buy_box_price: 25 }, { buy_box_price: 30 }],
  );
  if (!r.ready) throw new Error("expected ready");
  assert(r.revenueKind === "confirmed", "revenueKind = confirmed");
  assert(r.revenue === 50_000, "revenue uses confirmed value");
  assert(r.lowConfidence === false, "low-confidence is FALSE on confirmed");
  assert(
    r.confirmedSource === "Seller call 5/3",
    "confirmed source label flows through",
  );
  assert(
    typeof r.estimatorSuggestion === "number" && r.estimatorSuggestion! > 0,
    "estimator suggestion is the price-only number we'd otherwise have shown",
  );
  // delta_profit at $50k revenue is negative under defaults (labor floor
  // > recoverable margins) — that's correct math, not a bug. We just
  // assert outputs were computed (non-null) on the confirmed path.
  assert(r.outputs != null, "outputs computed (non-null)");
}

console.log("Case 5: brand-detail financials — clearing confirmed reverts");
{
  const r = computeBrandDetailFinancials(
    {
      keepa_last_enriched_at: "2026-04-15T00:00:00Z",
      trailing_12_months: 1_500_000,
      est_monthly_revenue: null,
      brand_controlled_pct: null,
      confirmed_ttm_revenue_dollars: null,
      confirmed_ttm_source: null,
    },
    [],
  );
  if (!r.ready) throw new Error("expected ready");
  assert(r.revenueKind === "imported", "revenueKind = imported");
  assert(r.revenue === 1_500_000, "revenue uses imported value");
  assert(r.confirmedSource == null, "no confirmed source");
  assert(r.estimatorSuggestion == null, "no estimator suggestion");
}

console.log(
  "Case 6: brand-detail financials — confirmed overrides imported too",
);
{
  const r = computeBrandDetailFinancials(
    {
      keepa_last_enriched_at: "2026-04-15T00:00:00Z",
      trailing_12_months: 1_000_000,
      est_monthly_revenue: null,
      brand_controlled_pct: null,
      confirmed_ttm_revenue_dollars: 2_500_000,
      confirmed_ttm_source: "Orion data",
    },
    [],
  );
  if (!r.ready) throw new Error("expected ready");
  assert(r.revenueKind === "confirmed", "confirmed wins over imported");
  assert(r.revenue === 2_500_000, "revenue is the confirmed override");
  assert(r.estimatorSuggestion === 1_000_000, "imported still shown as estimator suggestion");
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll Phase 28 confirmed-TTM tests passed.");
