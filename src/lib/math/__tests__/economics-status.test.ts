/**
 * Phase 80 — Tests for the negative-output clamp + economics_status classifier.
 *
 * No test runner is installed; run directly via:
 *   npx tsx src/lib/math/__tests__/economics-status.test.ts
 */
import {
  clampAndClassifyEconomics,
  classifyEconomicsStatus,
  LOW_REVENUE_ANNUAL_FLOOR,
  TIGHT_CHANNEL_PCT,
} from "../economics-status";
import { computeLegionEconomics, defaultLegionInputs } from "../legion-economics";

let failures = 0;
let passes = 0;

function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passes++;
  } else {
    failures++;
    console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// 1. Healthy mid-revenue brand → status='healthy', positive seven_x.
{
  const status = classifyEconomicsStatus({
    delta_profit: 100_000,
    revenue: 600_000,
    brand_controlled_pct: 0.5,
  });
  assert("healthy delta classifies as 'healthy'", status === "healthy");
  const clamped = clampAndClassifyEconomics({
    delta_profit: 100_000,
    revenue: 600_000,
    brand_controlled_pct: 0.5,
    exit_lift: 700_000,
  });
  assert(
    "healthy clamped retains positive numbers",
    clamped.status === "healthy" &&
      clamped.additional_profit === 100_000 &&
      clamped.seven_x_multiple_value === 700_000,
  );
}

// 2. Lemax-ish: ~$34K annual, negative delta → 'low_revenue', clamped to 0.
{
  const status = classifyEconomicsStatus({
    delta_profit: -25_000,
    revenue: 2885 * 12, // ~ $34K annual
    brand_controlled_pct: 0.5,
  });
  assert("low-revenue brand classifies as 'low_revenue'", status === "low_revenue");
  const clamped = clampAndClassifyEconomics({
    delta_profit: -25_000,
    revenue: 34_620,
    brand_controlled_pct: 0.5,
    exit_lift: -175_000,
  });
  assert(
    "low_revenue clamped to 0",
    clamped.status === "low_revenue" &&
      clamped.additional_profit === 0 &&
      clamped.seven_x_multiple_value === 0,
  );
}

// 3. Tight channel: high revenue, brand controls 97% of buy box → 'tight_channel'.
{
  const status = classifyEconomicsStatus({
    delta_profit: -100,
    revenue: 5_000_000,
    brand_controlled_pct: 0.97,
  });
  assert("≥ 0.95 controlled classifies as 'tight_channel'", status === "tight_channel");
  const clamped = clampAndClassifyEconomics({
    delta_profit: -100,
    revenue: 5_000_000,
    brand_controlled_pct: 0.97,
    exit_lift: -700,
  });
  assert(
    "tight_channel clamped to 0",
    clamped.status === "tight_channel" &&
      clamped.additional_profit === 0 &&
      clamped.seven_x_multiple_value === 0,
  );
}

// 4. delta_profit = 0 boundary → not 'healthy', should fall through to a non-healthy status.
{
  const status = classifyEconomicsStatus({
    delta_profit: 0,
    revenue: 50_000,
    brand_controlled_pct: 0.5,
  });
  assert("delta=0 boundary is non-healthy", status !== "healthy");
  assert("delta=0 + low revenue → 'low_revenue'", status === "low_revenue");
  const clamped = clampAndClassifyEconomics({
    delta_profit: 0,
    revenue: 50_000,
    brand_controlled_pct: 0.5,
    exit_lift: 0,
  });
  assert(
    "delta=0 clamped to 0",
    clamped.additional_profit === 0 && clamped.seven_x_multiple_value === 0,
  );
}

// 5. Tight-channel preferred over low-revenue when both apply.
{
  const status = classifyEconomicsStatus({
    delta_profit: -10,
    revenue: 50_000, // would be low_revenue
    brand_controlled_pct: 0.98, // also tight_channel
  });
  assert("both rules apply → tight_channel wins", status === "tight_channel");
}

// 6. Exact threshold: revenue = $200K (not strictly less than floor) → not 'low_revenue' route.
{
  const status = classifyEconomicsStatus({
    delta_profit: -1,
    revenue: LOW_REVENUE_ANNUAL_FLOOR,
    brand_controlled_pct: 0,
  });
  assert(
    "revenue = floor (>= not < floor) falls through to default low_revenue",
    status === "low_revenue",
  );
}

// 7. Exact tight-channel threshold (= 0.95) → tight_channel.
{
  const status = classifyEconomicsStatus({
    delta_profit: -1,
    revenue: 1_000_000,
    brand_controlled_pct: TIGHT_CHANNEL_PCT,
  });
  assert("brand_controlled_pct = 0.95 (boundary) → tight_channel", status === "tight_channel");
}

// 8. End-to-end: CARNA4-ish (~$1.42M business value implies ~$200K delta_profit) stays positive.
//    World Amenities ($1.04M revenue, full inputs) should be unchanged from the math brief.
{
  const out = computeLegionEconomics(defaultLegionInputs(1_047_538.87));
  assert(
    "World Amenities delta_profit ≈ $105,793 (math invariant)",
    Math.abs(out.delta_profit - 105_793) < 200,
    `got ${out.delta_profit.toFixed(2)}`,
  );
  const clamped = clampAndClassifyEconomics({
    delta_profit: out.delta_profit,
    revenue: 1_047_538.87,
    brand_controlled_pct: null,
    exit_lift: out.exit_lift,
  });
  assert(
    "World Amenities classified 'healthy' and unchanged",
    clamped.status === "healthy" &&
      Math.abs(clamped.additional_profit - out.delta_profit) < 0.0001 &&
      Math.abs(clamped.seven_x_multiple_value - out.exit_lift) < 0.0001,
  );
}

// 9. Sport-Tek-ish (~$40K annual): negative delta_profit, classified 'low_revenue'.
{
  const out = computeLegionEconomics(defaultLegionInputs(40_000));
  assert(
    "tiny brand produces non-positive delta_profit",
    out.delta_profit <= 0,
    `got ${out.delta_profit.toFixed(2)}`,
  );
  const clamped = clampAndClassifyEconomics({
    delta_profit: out.delta_profit,
    revenue: 40_000,
    brand_controlled_pct: null,
    exit_lift: out.exit_lift,
  });
  assert(
    "Sport-Tek-ish brand → 'low_revenue', clamped to 0",
    clamped.status === "low_revenue" &&
      clamped.additional_profit === 0 &&
      clamped.seven_x_multiple_value === 0,
  );
}

console.log(`\nPasses: ${passes}, Failures: ${failures}`);
if (failures > 0) {
  process.exit(1);
}
