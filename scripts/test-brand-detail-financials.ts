/**
 * Phase 26 — sanity test for the brand-detail FINANCIAL MODEL helper.
 *
 *   npx ts-node --compiler-options '{"module":"commonjs"}' scripts/test-brand-detail-financials.ts
 *
 * Cases:
 *   1. Brand without Keepa enrichment → { ready: false } (panel renders em-dashes)
 *   2. Brand with Keepa enrichment + price-only fallback (no trailing_12_months,
 *      no est_monthly_revenue, but cached buy-box prices) → populated outputs,
 *      lowConfidence=true (mirrors COUPLE'S COFFEE CO. shape).
 *   3. Brand with imported trailing_12_months → populated outputs, lowConfidence=false
 *   4. Brand with no usable revenue source after enrichment → ready=true, outputs=null
 */
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

// Case 1 — not yet enriched
console.log("Case 1: brand not enriched");
{
  const r = computeBrandDetailFinancials(
    {
      keepa_last_enriched_at: null,
      trailing_12_months: null,
      est_monthly_revenue: null,
    },
    [{ buy_box_price: 19.99 }, { buy_box_price: 24.5 }],
  );
  assert(r.ready === false, "ready=false when keepa_last_enriched_at is null");
}

// Case 2 — enriched, price-only fallback (mirrors COUPLE'S COFFEE CO.)
console.log("Case 2: enriched + price-only fallback");
{
  const r = computeBrandDetailFinancials(
    {
      keepa_last_enriched_at: "2026-05-03T20:24:13.691Z",
      trailing_12_months: null,
      est_monthly_revenue: null,
    },
    Array.from({ length: 42 }, (_, i) => ({
      buy_box_price: 18 + (i % 7),
    })),
  );
  assert(r.ready === true, "ready=true when enriched");
  if (r.ready) {
    assert(r.revenueKind === "price_only", "revenueKind === price_only");
    assert(r.lowConfidence === true, "lowConfidence === true");
    assert(r.revenue != null && r.revenue > 0, `revenue > 0 (got ${r.revenue})`);
    assert(r.outputs != null, "outputs populated");
    if (r.outputs) {
      assert(r.outputs.current_profit > 0, "current_profit > 0");
      assert(
        r.outputs.reseller_margin_captured > 0,
        "reseller_margin_captured > 0",
      );
      assert(r.outputs.recouped_shipping > 0, "recouped_shipping > 0");
      assert(r.outputs.labor_cost === 30000, "labor_cost = 30000 (under-2m tier)");
      assert(r.outputs.delta_profit !== 0, "delta_profit non-zero");
      assert(r.outputs.new_profit !== 0, "new_profit non-zero");
      assert(r.outputs.exit_lift !== 0, "exit_lift non-zero");
      console.log(
        `    revenue=${r.revenue} delta=${Math.round(r.outputs.delta_profit)} exit=${Math.round(r.outputs.exit_lift)}`,
      );
    }
  }
}

// Case 3 — enriched + imported trailing_12_months (real number)
console.log("Case 3: enriched + imported trailing_12_months");
{
  const r = computeBrandDetailFinancials(
    {
      keepa_last_enriched_at: "2026-05-03T20:24:13.691Z",
      trailing_12_months: 1_047_538.87,
      est_monthly_revenue: null,
    },
    [],
  );
  assert(r.ready === true, "ready=true");
  if (r.ready) {
    assert(r.revenueKind === "imported", "revenueKind === imported");
    assert(r.lowConfidence === false, "lowConfidence === false");
    assert(r.revenue === 1_047_538.87, "revenue passes through");
    assert(r.outputs != null, "outputs populated");
    if (r.outputs) {
      // World Amenities verification numbers from legion-economics.ts
      // header: delta ≈ 105,898, exit ≈ 741,286
      const delta = Math.round(r.outputs.delta_profit);
      const exit = Math.round(r.outputs.exit_lift);
      // Tolerance accommodates rounding in the verification numbers
      // documented in legion-economics.ts (~$105,898 / ~$741,286).
      assert(
        Math.abs(delta - 105_898) < 500,
        `delta_profit ≈ $105,898 (got $${delta})`,
      );
      assert(
        Math.abs(exit - 741_286) < 2000,
        `exit_lift ≈ $741,286 (got $${exit})`,
      );
    }
  }
}

// Case 4 — enriched but no revenue source at all (no prices, no imports)
console.log("Case 4: enriched but no revenue source");
{
  const r = computeBrandDetailFinancials(
    {
      keepa_last_enriched_at: "2026-05-03T20:24:13.691Z",
      trailing_12_months: null,
      est_monthly_revenue: null,
    },
    [],
  );
  assert(r.ready === true, "ready=true");
  if (r.ready) {
    assert(r.revenue === null, "revenue is null");
    assert(r.outputs === null, "outputs is null");
  }
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll assertions passed.");
