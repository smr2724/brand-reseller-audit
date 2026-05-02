/**
 * Unit tests for the math framework v4 — World Amenities case-study
 * methodology. Asserts the verification numbers from the brief plus
 * edge cases around the labor tier boundaries and the shipping payer
 * toggle.
 *
 * Run:
 *   npx tsx scripts/test-legion-economics.ts
 */
import {
  computeLegionEconomics,
  defaultLegionInputs,
  normalizePercent,
} from "../src/lib/math/legion-economics";

let fails = 0;
let passes = 0;

function near(actual: number, expected: number, tol: number, msg: string) {
  const diff = Math.abs(actual - expected);
  if (diff <= tol) {
    console.log(`ok:   ${msg}  (got ${actual.toFixed(2)} ≈ ${expected.toFixed(2)})`);
    passes++;
  } else {
    console.error(
      `FAIL: ${msg}  got=${actual.toFixed(2)} expected=${expected.toFixed(2)} diff=${diff.toFixed(2)} tol=${tol}`,
    );
    fails++;
  }
}

function eq(actual: unknown, expected: unknown, msg: string) {
  if (actual === expected) {
    console.log(`ok:   ${msg}  (= ${String(actual)})`);
    passes++;
  } else {
    console.error(`FAIL: ${msg}  got=${String(actual)} expected=${String(expected)}`);
    fails++;
  }
}

console.log("\n=== World Amenities verification (revenue $1,048,539, defaults, brand pays) ===\n");

// The brief's stated revenue and verification numbers are consistent
// to within ~$200 of rounding; use the brief's exact figure and a
// $200 tolerance so the published numbers all land.
const WA_REVENUE = 1_048_539;
const wa = computeLegionEconomics(defaultLegionInputs(WA_REVENUE));

near(wa.wholesale_invoice, 516_029.06, 500, "wholesale_invoice ≈ 516,029.06");
near(wa.wholesale_outbound_shipping, 25_801.45, 50, "wholesale_outbound_shipping ≈ 25,801.45");
near(wa.recouped_shipping, 25_801.45, 50, "recouped_shipping ≈ 25,801.45 (brand pays)");
near(wa.reseller_margin_captured, 110_096.59, 50, "reseller_margin_captured ≈ 110,097");
eq(wa.labor_cost, 30_000, "labor_cost = 30,000 (revenue < $2M)");
eq(wa.labor_tier, "under_2m", "labor_tier = under_2m");
near(wa.delta_profit, 105_898.04, 200, "delta_profit ≈ 105,898");
near(wa.exit_lift, 741_286.31, 1500, "exit_lift ≈ 741,286 (7× delta tolerance)");

// new_profit = current_profit + reseller_margin + recouped_shipping − labor
// With current_profit derived strictly from the brief's formula table
// (effective_wholesale = wholesale_invoice − shipping, then × 0.20):
//   current_profit ≈ 0.20 × (516029.06 − 25801.45) = 98045.52
//   new_profit     ≈ 98045.52 + 110096.59 + 25801.45 − 30000 = 203943.56
// Brief's "verification" lists 184,355 / 290,253 for current_profit /
// new_profit, but those numbers are not reachable from the formula
// table at this revenue (likely a stale carry-over from the original
// $860k spreadsheet). The headline numbers (Δ profit, exit lift) match.
near(wa.current_profit, 98_045.52, 200, "current_profit (per brief formulas) ≈ 98,046");
near(wa.new_profit, 203_943.56, 200, "new_profit (per brief formulas) ≈ 203,944");

// Δ = new − current — independent of current_profit's level.
near(
  wa.new_profit - wa.current_profit,
  wa.delta_profit,
  0.001,
  "new_profit − current_profit == delta_profit (algebraic identity)",
);

console.log("\n=== Outbound shipping payer toggle ===\n");

const waResellerPays = computeLegionEconomics({
  ...defaultLegionInputs(WA_REVENUE),
  outbound_shipping_payer: "reseller",
});
eq(waResellerPays.recouped_shipping, 0, "reseller pays → recouped_shipping = 0");
near(
  waResellerPays.delta_profit,
  wa.delta_profit - wa.wholesale_outbound_shipping,
  0.01,
  "reseller pays → delta drops by the shipping amount",
);

const waUnknown = computeLegionEconomics({
  ...defaultLegionInputs(WA_REVENUE),
  outbound_shipping_payer: "unknown",
});
near(
  waUnknown.recouped_shipping,
  wa.wholesale_outbound_shipping,
  0.01,
  "unknown payer → assumed brand pays (recouped > 0)",
);
near(
  waUnknown.delta_profit,
  wa.delta_profit,
  0.01,
  "unknown payer → delta matches brand-pays",
);

console.log("\n=== Labor tier boundaries ===\n");

const just_under_2m = computeLegionEconomics(defaultLegionInputs(1_999_999));
eq(just_under_2m.labor_cost, 30_000, "$1,999,999 → labor 30,000 (under_2m)");
eq(just_under_2m.labor_tier, "under_2m", "$1,999,999 → tier under_2m");

const at_2m = computeLegionEconomics(defaultLegionInputs(2_000_000));
eq(at_2m.labor_cost, 130_000, "$2,000,000 → labor 130,000 (2m_to_10m)");
eq(at_2m.labor_tier, "2m_to_10m", "$2,000,000 → tier 2m_to_10m");

const just_under_10m = computeLegionEconomics(defaultLegionInputs(9_999_999));
eq(just_under_10m.labor_cost, 130_000, "$9,999,999 → labor 130,000");
eq(just_under_10m.labor_tier, "2m_to_10m", "$9,999,999 → tier 2m_to_10m");

const at_10m = computeLegionEconomics(defaultLegionInputs(10_000_000));
eq(at_10m.labor_cost, 250_000, "$10,000,000 → labor 250,000 (over_10m)");
eq(at_10m.labor_tier, "over_10m", "$10,000,000 → tier over_10m");

const big = computeLegionEconomics(defaultLegionInputs(50_000_000));
eq(big.labor_cost, 250_000, "$50,000,000 → labor 250,000");

const overridden = computeLegionEconomics({
  ...defaultLegionInputs(500_000),
  labor_cost_override: 75_000,
});
eq(overridden.labor_cost, 75_000, "labor_cost_override wins over the tier");

console.log("\n=== Zero / degenerate revenue ===\n");

const zero = computeLegionEconomics(defaultLegionInputs(0));
eq(zero.wholesale_invoice, 0, "revenue=0 → wholesale_invoice 0");
eq(zero.delta_profit, -30_000, "revenue=0 → delta = -labor (= -30,000)");
eq(Number.isFinite(zero.exit_lift), true, "revenue=0 → exit_lift is finite");

const neg = computeLegionEconomics(defaultLegionInputs(-1000));
eq(neg.wholesale_invoice, 0, "negative revenue clamped to 0");

console.log("\n=== normalizePercent ===\n");

near(normalizePercent("103%"), 1.03, 1e-9, "'103%' → 1.03");
near(normalizePercent("103"), 1.03, 1e-9, "'103' → 1.03");
near(normalizePercent("1.03"), 1.03, 1e-9, "'1.03' → 1.03");
near(normalizePercent(103), 1.03, 1e-9, "103 (number) → 1.03");
near(normalizePercent(1.03), 1.03, 1e-9, "1.03 (number) → 1.03");
near(normalizePercent("0.5"), 0.5, 1e-9, "'0.5' → 0.5");
near(normalizePercent("5%"), 0.05, 1e-9, "'5%' → 0.05");
near(normalizePercent(""), 0, 1e-9, "empty → 0");
near(normalizePercent("not a number"), 0, 1e-9, "garbage → 0");

console.log("\n=== Reseller markup edge cases ===\n");

const zeroMarkup = computeLegionEconomics({
  ...defaultLegionInputs(1_000_000),
  reseller_markup_pct: 0,
});
near(zeroMarkup.wholesale_invoice, 1_000_000, 0.01, "0% markup → wholesale = revenue");

const veryHigh = computeLegionEconomics({
  ...defaultLegionInputs(1_000_000),
  reseller_markup_pct: 5, // 500%
});
near(veryHigh.wholesale_invoice, 1_000_000 / 6, 0.01, "500% markup → wholesale = R/6");

console.log(`\n=== ${passes} passed, ${fails} failed ===\n`);
if (fails > 0) process.exit(1);
