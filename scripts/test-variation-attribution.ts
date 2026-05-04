/**
 * Phase 31 — Unit + integration smoke tests for variation-aware sales
 * attribution.
 *
 * Run:
 *   npx tsx scripts/test-variation-attribution.ts
 *
 * Covers:
 *   • Singletons pass through unchanged (regression guard for pre-Phase-31
 *     behavior — equal raw_monthly_units = attributed_monthly_units).
 *   • Group of 2: max(monthlySold) selection rule.
 *   • Group of 4 with one dominant child: weight=1, siblings=0.
 *   • Zero recent reviews across the group → equal weighting fallback.
 *   • Pallet-style fixture: high price, near-zero reviews → ~$0
 *     attributed revenue (the H2O Therapy bug).
 *   • estimateBrandTtmRevenue honors attributed_monthly_units override.
 */
import {
  attributeVariationSales,
  hasAnyVariationGroup,
  indexAttributionByAsin,
} from "../src/lib/enrichment/variation-attribution";
import {
  estimateBrandTtmRevenue,
} from "../src/lib/enrichment/revenue-estimator";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures += 1;
  } else {
    console.log("ok:", msg);
  }
}
function assertNear(actual: number, expected: number, tol: number, msg: string) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) {
    console.error(`FAIL: ${msg} — actual=${actual} expected≈${expected} (±${tol})`);
    failures += 1;
  } else {
    console.log(`ok: ${msg} — actual=${actual} ≈ ${expected}`);
  }
}

// --------------------------------------------------------------------
// Test 1 — singletons pass through unchanged.
// --------------------------------------------------------------------
{
  const out = attributeVariationSales([
    {
      asin: "AAAAAAAAAA",
      parent_asin: null,
      raw_monthly_units: 100,
      recent_review_count: 50,
    },
    {
      asin: "BBBBBBBBBB",
      parent_asin: null,
      raw_monthly_units: 30,
      recent_review_count: 10,
    },
  ]);
  assert(out.length === 2, "singletons: 2 results in/out");
  for (const r of out) {
    assert(r.variation_group_size === 1, `${r.asin} group_size=1`);
    assert(r.variation_weight === 1, `${r.asin} weight=1`);
    assert(
      r.attributed_monthly_units === r.raw_monthly_units,
      `${r.asin} attributed === raw (regression guard)`,
    );
  }
}

// --------------------------------------------------------------------
// Test 2 — group of 2, max selection rule.
// --------------------------------------------------------------------
{
  // Keepa returned monthlySold=120 on ASIN-A and 100 on ASIN-B (siblings
  // sharing rank). Group volume must be 120 (max), not 220 (sum).
  const out = attributeVariationSales([
    {
      asin: "PPPPPPPPPP",
      parent_asin: "PARENT0001",
      raw_monthly_units: 120,
      recent_review_count: 80,
    },
    {
      asin: "QQQQQQQQQQ",
      parent_asin: "PARENT0001",
      raw_monthly_units: 100,
      recent_review_count: 20,
    },
  ]);
  assert(out.length === 2, "pair: 2 results");
  const total = out.reduce(
    (a, r) => a + (r.attributed_monthly_units ?? 0),
    0,
  );
  // total attributed = group_max (120) since weights sum to 1.
  assertNear(total, 120, 0.001, "pair: sum of attributed = max(120,100)");
  const a = out.find((r) => r.asin === "PPPPPPPPPP")!;
  const b = out.find((r) => r.asin === "QQQQQQQQQQ")!;
  assertNear(a.variation_weight, 80 / 100, 0.001, "PPP weight = 80/100");
  assertNear(b.variation_weight, 20 / 100, 0.001, "QQQ weight = 20/100");
  assertNear(
    a.attributed_monthly_units!,
    120 * 0.8,
    0.01,
    "PPP attributed = 96",
  );
  assertNear(
    b.attributed_monthly_units!,
    120 * 0.2,
    0.01,
    "QQQ attributed = 24",
  );
  assert(hasAnyVariationGroup(out), "pair: hasAnyVariationGroup → true");
}

// --------------------------------------------------------------------
// Test 3 — single dominant child takes everything, siblings get 0.
// --------------------------------------------------------------------
{
  const out = attributeVariationSales([
    {
      asin: "DOM0000001",
      parent_asin: "PARENTDOM0",
      raw_monthly_units: 200,
      recent_review_count: 500,
    },
    {
      asin: "ZER0000002",
      parent_asin: "PARENTDOM0",
      raw_monthly_units: 200,
      recent_review_count: 0,
    },
    {
      asin: "ZER0000003",
      parent_asin: "PARENTDOM0",
      raw_monthly_units: 200,
      recent_review_count: 0,
    },
  ]);
  const dom = out.find((r) => r.asin === "DOM0000001")!;
  const z2 = out.find((r) => r.asin === "ZER0000002")!;
  const z3 = out.find((r) => r.asin === "ZER0000003")!;
  assertNear(dom.variation_weight, 1, 0.001, "dominant weight=1");
  assertNear(z2.variation_weight, 0, 0.001, "sibling weight=0");
  assertNear(z3.variation_weight, 0, 0.001, "sibling weight=0");
  assertNear(dom.attributed_monthly_units!, 200, 0.01, "dominant gets full 200");
  assertNear(z2.attributed_monthly_units!, 0, 0.01, "sibling gets 0");
  assertNear(z3.attributed_monthly_units!, 0, 0.01, "sibling gets 0");
}

// --------------------------------------------------------------------
// Test 4 — zero reviews across the group → equal weighting fallback.
// --------------------------------------------------------------------
{
  const out = attributeVariationSales([
    {
      asin: "EQ00000001",
      parent_asin: "PARENTEQ00",
      raw_monthly_units: 80,
      recent_review_count: null,
    },
    {
      asin: "EQ00000002",
      parent_asin: "PARENTEQ00",
      raw_monthly_units: 80,
      recent_review_count: 0,
    },
    {
      asin: "EQ00000003",
      parent_asin: "PARENTEQ00",
      raw_monthly_units: 80,
      recent_review_count: 0,
    },
    {
      asin: "EQ00000004",
      parent_asin: "PARENTEQ00",
      raw_monthly_units: 80,
      recent_review_count: 0,
    },
  ]);
  for (const r of out) {
    assertNear(r.variation_weight, 0.25, 0.001, `${r.asin} equal weight 1/4`);
    assertNear(
      r.attributed_monthly_units!,
      20,
      0.01,
      `${r.asin} attributed = 80*0.25`,
    );
  }
}

// --------------------------------------------------------------------
// Test 5 — H2O Therapy pallet fixture. The pallet child has high price
// and near-zero recent reviews; the active 4-pack child sells. After
// attribution the pallet must produce ~$0 of revenue.
// --------------------------------------------------------------------
{
  const out = attributeVariationSales([
    {
      asin: "ACTIVE4PCK", // 4-pack, $30, lots of reviews
      parent_asin: "H2OPARENT0",
      raw_monthly_units: 150,
      recent_review_count: 450,
    },
    {
      asin: "PALLETSTUF", // pallet, $1500, near-zero reviews
      parent_asin: "H2OPARENT0",
      raw_monthly_units: 150,
      recent_review_count: 1,
    },
  ]);
  const active = out.find((r) => r.asin === "ACTIVE4PCK")!;
  const pallet = out.find((r) => r.asin === "PALLETSTUF")!;
  assertNear(active.variation_weight, 450 / 451, 0.001, "active weight ≈ 1");
  assertNear(pallet.variation_weight, 1 / 451, 0.001, "pallet weight ≈ 0");
  // Group volume = max(150,150) = 150. Pallet TTM = 150 × (1/451) × 12 × 1500
  // ≈ $5,985 — vs the pre-Phase-31 figure of 150 × 12 × 1500 = $2.7M. The
  // attribution kills hundreds of thousands of phantom pallet revenue.
  const palletTtm =
    pallet.attributed_monthly_units! * 12 * 1500;
  assert(
    palletTtm < 10_000,
    `pallet TTM after attribution < $10k (got $${palletTtm.toFixed(0)})`,
  );
}

// --------------------------------------------------------------------
// Test 6 — estimateBrandTtmRevenue honors attributed_monthly_units.
// --------------------------------------------------------------------
{
  const result = estimateBrandTtmRevenue([
    // Active variation: rank+price normal. Attribution forces 100/mo.
    {
      asin: "ACT0000001",
      sales_rank_avg365: 8000,
      sales_rank_current: 8000,
      buy_box_avg365: 30,
      buy_box_current: 30,
      buy_box_now: 30,
      product_group: "Health",
      root_category: 0,
      category_path: "Health",
      attributed_monthly_units: 100,
      variation_group_size: 2,
    },
    // Pallet sibling: same rank+price-bearing, but attribution forces 0.
    {
      asin: "PAL0000001",
      sales_rank_avg365: 8000,
      sales_rank_current: 8000,
      buy_box_avg365: 1500,
      buy_box_current: 1500,
      buy_box_now: 1500,
      product_group: "Health",
      root_category: 0,
      category_path: "Health",
      attributed_monthly_units: 0,
      variation_group_size: 2,
    },
  ]);
  assert(result.has_variation_attribution === true, "estimate flags variation attribution");
  // Active: 100 × 12 × $30 = $36,000. Pallet: $0. Total = $36,000.
  assertNear(
    result.total_ttm_revenue ?? 0,
    36_000,
    100,
    "estimator total = $36k (pallet contributes $0)",
  );
  const pallet = result.per_asin.find((p) => p.asin === "PAL0000001")!;
  assert(pallet.ttm_revenue === 0, "pallet TTM revenue = $0");
  assert(pallet.variation_attributed === true, "pallet flagged as variation");
}

// --------------------------------------------------------------------
// Test 7 — group with all-zero raw monthlySold ⇒ all zeros out.
// --------------------------------------------------------------------
{
  const out = attributeVariationSales([
    {
      asin: "ZX00000001",
      parent_asin: "ZXPARENT00",
      raw_monthly_units: 0,
      recent_review_count: 10,
    },
    {
      asin: "ZX00000002",
      parent_asin: "ZXPARENT00",
      raw_monthly_units: 0,
      recent_review_count: 5,
    },
  ]);
  for (const r of out) {
    assert(
      r.attributed_monthly_units === 0,
      `${r.asin} attributed = 0 when group_max=0`,
    );
  }
}

// --------------------------------------------------------------------
// Test 8 — null parent_asin children are NOT grouped together.
// --------------------------------------------------------------------
{
  const out = attributeVariationSales([
    { asin: "NU00000001", parent_asin: null, raw_monthly_units: 50, recent_review_count: 10 },
    { asin: "NU00000002", parent_asin: null, raw_monthly_units: 80, recent_review_count: 10 },
  ]);
  // Each lands in its own singleton group; passthrough.
  for (const r of out) {
    assert(r.variation_group_size === 1, `${r.asin} singleton`);
    assert(
      r.attributed_monthly_units === r.raw_monthly_units,
      `${r.asin} passthrough`,
    );
  }
  assert(!hasAnyVariationGroup(out), "nulls: hasAnyVariationGroup → false");
}

// --------------------------------------------------------------------
// Done.
// --------------------------------------------------------------------
if (failures === 0) {
  console.log("\nALL OK");
  process.exit(0);
} else {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
