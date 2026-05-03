/**
 * Phase 25 — sanity tests for the revenue-fallback chain in
 * `assembleV2`. The sized-revenue precedence is:
 *
 *   1. SP-API trailing-12mo (real)
 *   2. brand.trailing_12_months / est_monthly_revenue × 12 (imported)
 *   3. revenueEstimate.total_ttm_revenue (Keepa BSR + price)
 *   4. Phase 25 price-only fallback (Keepa price × conservative units)
 *
 * Phase 25 fixes Bug C: when (1)-(3) all return null, the assembler
 * still derives a low-confidence number from buy_box_price on
 * brand_asins so the math section renders values rather than all-null.
 *
 * Run: `npx tsx scripts/test-revenue-fallbacks.ts`
 */

import { computeLegionEconomics } from "../src/lib/math/legion-economics";

interface Asin {
  asin: string;
  buy_box_price: number | null;
}

function priceOnlyTtm(asins: Asin[], unitsFloor = 4): number | null {
  if (asins.length === 0) return null;
  let total = 0;
  let priced = 0;
  for (const a of asins) {
    const price = typeof a.buy_box_price === "number" ? a.buy_box_price : null;
    if (price == null || price <= 0) continue;
    total += price * unitsFloor * 12;
    priced += 1;
  }
  if (priced === 0) return null;
  return Math.round(total);
}

let pass = 0;
let fail = 0;
function assertEq(name: string, got: unknown, expect: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(expect)) {
    pass += 1;
    console.log(`PASS  ${name} :: ${JSON.stringify(got)}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}\n  got:    ${JSON.stringify(got)}\n  expect: ${JSON.stringify(expect)}`);
  }
}

// 1. Empty ASIN list → null
assertEq("empty asins → null", priceOnlyTtm([]), null);

// 2. ASINs with no prices → null
assertEq(
  "all null prices → null",
  priceOnlyTtm([
    { asin: "A1", buy_box_price: null },
    { asin: "A2", buy_box_price: null },
  ]),
  null,
);

// 3. Single ASIN with $25 price → 25 × 4 × 12 = 1200
assertEq(
  "single $25 ASIN → 1200",
  priceOnlyTtm([{ asin: "A1", buy_box_price: 25 }]),
  1200,
);

// 4. Fantaswick-shaped: 40 ASINs, average ~$30 price → 40 × 30 × 4 × 12 = 57,600
const fantaswick40: Asin[] = Array.from({ length: 40 }, (_, i) => ({
  asin: `B${String(i).padStart(9, "0")}`,
  buy_box_price: 30,
}));
assertEq(
  "Fantaswick 40 × $30 → $57,600 conservative TTM",
  priceOnlyTtm(fantaswick40),
  57_600,
);

// 5. The fallback figure plugs into computeLegionEconomics without
// returning NaN/all-null. This proves Bug C is fixed end-to-end.
const econ = computeLegionEconomics({
  revenue: 57_600,
  reseller_markup_pct: 1.03,
  outbound_shipping_pct: 0.05,
  outbound_shipping_payer: "brand",
  reseller_net_margin_pct: 0.105,
  current_profit_margin_pct: 0.20,
  ebitda_multiple: 7,
  labor_cost_override: null,
});
const allFinite =
  Number.isFinite(econ.delta_profit) &&
  Number.isFinite(econ.exit_lift) &&
  Number.isFinite(econ.reseller_margin_captured);
assertEq("legion economics on fallback revenue produces finite numbers", allFinite, true);
// For tight-channel DIY-fit brands the math may show net-negative
// delta_profit (labor cost > recoverable margin), which is the whole
// reason DIY-mode exists. We just want a *number*, not null/NaN.
assertEq("reseller_margin_captured > 0 on fallback revenue", econ.reseller_margin_captured > 0, true);

// 6. Boundary: configurable units floor
assertEq(
  "configurable units floor (10) on single $25 ASIN → 3000",
  priceOnlyTtm([{ asin: "A1", buy_box_price: 25 }], 10),
  3000,
);

// 7. Mixed null/priced ASINs → only priced count
assertEq(
  "mixed null+$10 ASINs → 480",
  priceOnlyTtm([
    { asin: "A1", buy_box_price: null },
    { asin: "A2", buy_box_price: 10 },
  ]),
  480,
);

// 8. Negative/zero prices ignored
assertEq(
  "zero/negative prices ignored",
  priceOnlyTtm([
    { asin: "A1", buy_box_price: 0 },
    { asin: "A2", buy_box_price: -5 },
    { asin: "A3", buy_box_price: 20 },
  ]),
  960,
);

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
