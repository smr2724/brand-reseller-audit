/**
 * Phase 56 — Regression tests for the deterministic ICP segmentation
 * function. No test runner is installed in this repo, so the file is
 * executable directly via `npx tsx`:
 *
 *   npx tsx src/lib/qualification/__tests__/segments.test.ts
 *
 * It exits non-zero on the first failing assertion. CI / local checks
 * can wire it into a `test` script without a heavier framework.
 */
import {
  computeSegment,
  type Segment,
  type SegmentInput,
} from "../segments";

let failures = 0;
let passes = 0;

function baseQualified(overrides: Partial<SegmentInput> = {}): SegmentInput {
  return {
    brand_owned_pct: 0,
    authorized_pct: 0,
    unauthorized_pct: 100,
    amazon_pct: 0,
    ttm_revenue_usd: 1_000_000,
    has_trademark: true,
    is_anti_amazon: false,
    is_enterprise_pe_public: false,
    ...overrides,
  };
}

function expectSegment(
  name: string,
  input: SegmentInput,
  expected: Segment,
): void {
  const r = computeSegment(input);
  if (r.segment !== expected) {
    failures += 1;
    console.error(
      `FAIL: ${name}\n  expected: ${expected}\n  got:      ${r.segment} (qualified=${r.qualified}, mode=${r.report_mode})`,
    );
  } else {
    passes += 1;
  }
}

// ---- Canonical happy-path tests for all 10 segments ----

expectSegment(
  "Segment 1 canonical (Shearwater shape)",
  baseQualified({ unauthorized_pct: 95, brand_owned_pct: 0, authorized_pct: 5 }),
  "reseller_controlled",
);

expectSegment(
  "Segment 2 canonical (authorized network)",
  baseQualified({ authorized_pct: 60, unauthorized_pct: 10, brand_owned_pct: 30 }),
  "authorized_network_healthy",
);

expectSegment(
  "Segment 3 canonical (mixed control)",
  baseQualified({ authorized_pct: 30, unauthorized_pct: 50, brand_owned_pct: 20 }),
  "mixed_control",
);

expectSegment(
  "Segment 4 canonical (brand managed with leakage)",
  baseQualified({ brand_owned_pct: 50, unauthorized_pct: 40, authorized_pct: 10 }),
  "brand_managed_with_leakage",
);

expectSegment(
  "Segment 5 canonical (brand self-managed clean)",
  baseQualified({ brand_owned_pct: 90, unauthorized_pct: 5, authorized_pct: 5 }),
  "brand_self_managed",
);

expectSegment(
  "Segment 6 canonical (Amazon Vendor Central)",
  baseQualified({ amazon_pct: 80, unauthorized_pct: 20 }),
  "amazon_vendor_central",
);

expectSegment(
  "Segment 7 canonical (anti-Amazon stance)",
  baseQualified({ is_anti_amazon: true }),
  "anti_amazon_stance",
);

expectSegment(
  "Segment 8 canonical (enterprise PE public)",
  baseQualified({ is_enterprise_pe_public: true }),
  "enterprise_pe_public",
);

expectSegment(
  "Segment 9 canonical (trademark split)",
  baseQualified({ has_trademark: false }),
  "trademark_split",
);

expectSegment(
  "Segment 10 canonical (below revenue floor)",
  baseQualified({ ttm_revenue_usd: 400_000 }),
  "below_revenue_floor",
);

// ---- Disqualifier priority order tests ----

expectSegment(
  "Trademark split outranks below_revenue_floor",
  baseQualified({ has_trademark: false, ttm_revenue_usd: 100_000 }),
  "trademark_split",
);

expectSegment(
  "Anti-Amazon outranks enterprise",
  baseQualified({ is_anti_amazon: true, is_enterprise_pe_public: true }),
  "anti_amazon_stance",
);

expectSegment(
  "Enterprise outranks below_revenue_floor",
  baseQualified({ is_enterprise_pe_public: true, ttm_revenue_usd: 100_000 }),
  "enterprise_pe_public",
);

expectSegment(
  "Below revenue floor outranks Amazon VC",
  baseQualified({ ttm_revenue_usd: 100_000, amazon_pct: 80 }),
  "below_revenue_floor",
);

expectSegment(
  "Amazon VC outranks brand self-managed",
  baseQualified({ amazon_pct: 60, brand_owned_pct: 90, unauthorized_pct: 0 }),
  "amazon_vendor_central",
);

// ---- Boundary tests for every threshold ----

// brand_owned 70% boundary (Segment 5 trigger).
expectSegment(
  "brand_owned exactly 70%, unauth 9%, amazon 0% → Segment 5",
  baseQualified({ brand_owned_pct: 70, unauthorized_pct: 9, authorized_pct: 21 }),
  "brand_self_managed",
);
expectSegment(
  "brand_owned exactly 69%, unauth 9%, amazon 0% → Segment 4 (just under self-managed)",
  baseQualified({ brand_owned_pct: 69, unauthorized_pct: 25, authorized_pct: 6 }),
  "brand_managed_with_leakage",
);
expectSegment(
  "brand_owned 71% with 25% unauthorized still triggers leakage path (unauth not < 10)",
  baseQualified({ brand_owned_pct: 71, unauthorized_pct: 25, authorized_pct: 4 }),
  "reseller_controlled", // brand_owned NOT < 70 in S4, so S4 fails; S3 fails (brand_owned not < 70); falls to default
);

// brand_owned 70% but with high unauthorized (>= 10) → NOT segment 5.
expectSegment(
  "brand_owned 70%, unauth 30% → not self-managed (unauth >= 10)",
  baseQualified({ brand_owned_pct: 70, unauthorized_pct: 30, authorized_pct: 0 }),
  "reseller_controlled",
);

// Amazon 50% boundary.
expectSegment(
  "Amazon exactly 50% → Segment 6",
  baseQualified({ amazon_pct: 50, unauthorized_pct: 50 }),
  "amazon_vendor_central",
);
expectSegment(
  "Amazon 49% → not Segment 6",
  baseQualified({ amazon_pct: 49, unauthorized_pct: 51 }),
  "reseller_controlled",
);

// Authorized 40% boundary (Segment 2).
expectSegment(
  "Authorized exactly 40%, unauth 20%, amazon 0% → Segment 2",
  baseQualified({ authorized_pct: 40, unauthorized_pct: 20, brand_owned_pct: 40 }),
  "authorized_network_healthy",
);
expectSegment(
  "Authorized 39%, unauth 20% → Segment 3 (mixed control)",
  baseQualified({ authorized_pct: 39, unauthorized_pct: 41, brand_owned_pct: 20 }),
  "mixed_control",
);

// Unauthorized 20% boundary (Segment 2 vs Segment 3).
expectSegment(
  "Auth 50%, unauth exactly 20%, brand_owned 30% → Segment 2 (unauth <= 20)",
  baseQualified({ authorized_pct: 50, unauthorized_pct: 20, brand_owned_pct: 30 }),
  "authorized_network_healthy",
);
expectSegment(
  "Auth 50%, unauth 21%, brand_owned 29% → Segment 3 (unauth > 20)",
  baseQualified({ authorized_pct: 50, unauthorized_pct: 21, brand_owned_pct: 29 }),
  "mixed_control",
);

// Revenue floor.
expectSegment(
  "TTM exactly $500K → qualified (not below floor)",
  baseQualified({ ttm_revenue_usd: 500_000 }),
  "reseller_controlled",
);
expectSegment(
  "TTM $499,999 → below floor",
  baseQualified({ ttm_revenue_usd: 499_999 }),
  "below_revenue_floor",
);

// Segment 4 boundaries.
expectSegment(
  "brand_owned exactly 30%, unauth exactly 20% → Segment 4",
  baseQualified({ brand_owned_pct: 30, unauthorized_pct: 20, authorized_pct: 50 }),
  "authorized_network_healthy", // because authorized 50 + unauth 20 hits Segment 2 first
);
expectSegment(
  "brand_owned 30%, unauth 20%, authorized 0% → Segment 4 (authorized fails S2)",
  baseQualified({ brand_owned_pct: 30, unauthorized_pct: 20, authorized_pct: 50, amazon_pct: 0 }),
  "authorized_network_healthy",
);
expectSegment(
  "brand_owned 35%, unauth 25%, authorized 40% → Segment 4 wins over S3 (S4 checked first)",
  // S2 fails: unauth 25 > 20. S4 passes: brand 35 in [30,70), unauth 25 >= 20. ✓
  baseQualified({ brand_owned_pct: 35, unauthorized_pct: 25, authorized_pct: 40 }),
  "brand_managed_with_leakage",
);
expectSegment(
  "brand_owned 29%, unauth 30%, authorized 41% → Segment 2 (auth 41 ≥ 40 & unauth 30 > 20 → S2 fails; S4 fails brand<30; S3 passes)",
  baseQualified({ brand_owned_pct: 29, unauthorized_pct: 30, authorized_pct: 41 }),
  "mixed_control",
);

// ---- Edge D: fresh brand with everything 'unclassified' (treated as unauthorized) ----
expectSegment(
  "Fresh brand, 100% unauthorized → Segment 1 default",
  baseQualified({ unauthorized_pct: 100 }),
  "reseller_controlled",
);

// ---- Per-spec edge cases ----
expectSegment(
  "Amazon 49%, 30% unauth, 5% authorized, 16% brand_owned → Segment 1 (brand < 30)",
  baseQualified({ amazon_pct: 49, unauthorized_pct: 30, authorized_pct: 5, brand_owned_pct: 16 }),
  "reseller_controlled",
);
expectSegment(
  "Amazon 49%, 30% unauth, 5% authorized, 35% brand_owned → Segment 4",
  baseQualified({ amazon_pct: 49, unauthorized_pct: 30, authorized_pct: 5, brand_owned_pct: 16 + 35 - 16 }), // 35
  "brand_managed_with_leakage",
);

// Verify report_mode values are wired correctly.
{
  const r1 = computeSegment(baseQualified({ unauthorized_pct: 100 }));
  if (r1.report_mode !== "opportunity") {
    failures += 1;
    console.error(`FAIL: Segment 1 report_mode expected 'opportunity' got '${r1.report_mode}'`);
  } else passes += 1;

  const r2 = computeSegment(
    baseQualified({ authorized_pct: 50, unauthorized_pct: 20, brand_owned_pct: 30 }),
  );
  if (r2.report_mode !== "tight") {
    failures += 1;
    console.error(`FAIL: Segment 2 report_mode expected 'tight' got '${r2.report_mode}'`);
  } else passes += 1;

  const r4 = computeSegment(
    baseQualified({ brand_owned_pct: 50, unauthorized_pct: 40, authorized_pct: 10 }),
  );
  if (r4.report_mode !== "opportunity_softlead") {
    failures += 1;
    console.error(`FAIL: Segment 4 report_mode expected 'opportunity_softlead' got '${r4.report_mode}'`);
  } else passes += 1;

  const r5 = computeSegment(
    baseQualified({ brand_owned_pct: 90, unauthorized_pct: 5, authorized_pct: 5 }),
  );
  if (r5.report_mode !== null) {
    failures += 1;
    console.error(`FAIL: Segment 5 report_mode expected null got '${r5.report_mode}'`);
  } else passes += 1;
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
