/**
 * Phase 33.2 — Persisted-revenue-path tests.
 *
 * Verifies the new revenue path that reads from `brand_asins` directly
 * (skipping the Keepa /product re-fetch).
 *
 *   1. `getBrandAsinsForRevenue` returns ALL rows for a brand (no .limit,
 *      no order-by-offers_count). Pre-fix the bundle helper capped at 50.
 *   2. `estimateBrandTtmRevenueFromPersisted` sums Σ(units × price) × 12
 *      across the full set within tolerance.
 *   3. ALL non-zero rows contribute (especially the long tail with low
 *      offers_count, which the old bundle path silently dropped).
 *   4. No Keepa /product fetch is invoked anywhere on this path — fetch
 *      is mocked and the test asserts zero `/product` calls.
 *   5. Source string drops the "365-day avg" claim and adds the
 *      "summed across full brand catalog" framing.
 *
 * Run:
 *   npx tsx scripts/test-persisted-revenue-path.ts
 */
export {};

const ORIGINAL_FETCH = globalThis.fetch;
const counts = { pass: 0, fail: 0 };

function assertEq(name: string, got: unknown, expect: unknown) {
  if (JSON.stringify(got) === JSON.stringify(expect)) {
    counts.pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    counts.fail += 1;
    console.log(
      `FAIL  ${name}\n  got:    ${JSON.stringify(got)}\n  expect: ${JSON.stringify(expect)}`,
    );
  }
}

function assert(name: string, cond: unknown) {
  if (cond) {
    counts.pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    counts.fail += 1;
    console.log(`FAIL  ${name}`);
  }
}

function approxEq(name: string, got: number, expect: number, tolerance: number) {
  const diff = Math.abs(got - expect);
  if (diff <= tolerance) {
    counts.pass += 1;
    console.log(`PASS  ${name} (got=${got}, expect≈${expect}, diff=${diff})`);
  } else {
    counts.fail += 1;
    console.log(
      `FAIL  ${name}\n  got:    ${got}\n  expect: ≈${expect} (tolerance ${tolerance})`,
    );
  }
}

interface FakeRow {
  asin: string;
  title: string | null;
  buy_box_seller: string | null;
  buy_box_price: number | null;
  offers_count: number | null;
  fba_offers_count: number | null;
  is_brand_controlled: boolean | null;
  attributed_monthly_units: number | null;
  raw_monthly_units: number | null;
  parent_asin: string | null;
  variation_group_size: number | null;
  buy_box_change_count_90d: number | null;
}

/**
 * Build a fake brand_asins set: 80 rows, mixed offers_count, mixed
 * attributed_monthly_units / buy_box_price. The first 50 (by offers_count
 * desc) are the rows that the old bundle path would have surfaced; the
 * remaining 30 are the long-tail rows with offers_count ≤ 3 and
 * deliberately *higher* per-row revenue (this mirrors Terra Pure where
 * the brand's own deep catalog has low offers_count and high BSR-driven
 * units).
 */
function buildSeed(): FakeRow[] {
  const rows: FakeRow[] = [];
  // 50 "in-window" rows: high offers_count, modest units × price.
  for (let i = 0; i < 50; i++) {
    const offers = 30 - Math.floor(i / 4); // 30 → 18-ish
    rows.push({
      asin: `BWIN${String(i).padStart(6, "0")}`,
      title: `In-window ${i}`,
      buy_box_seller: "ResellerCo",
      buy_box_price: 19.99,
      offers_count: offers,
      fba_offers_count: offers - 2,
      is_brand_controlled: false,
      attributed_monthly_units: 30,
      raw_monthly_units: 30,
      parent_asin: null,
      variation_group_size: 1,
      buy_box_change_count_90d: 12,
    });
  }
  // 30 "long-tail" rows: low offers_count (1-3), high attributed units
  // (these are exactly the rows the .limit(50) ordered by offers_count
  // desc was silently dropping).
  for (let i = 0; i < 30; i++) {
    rows.push({
      asin: `BTAIL${String(i).padStart(6, "0")}`,
      title: `Long-tail ${i}`,
      buy_box_seller: "Brand Direct",
      buy_box_price: 99.99,
      offers_count: (i % 3) + 1,
      fba_offers_count: 1,
      is_brand_controlled: true,
      attributed_monthly_units: 80,
      raw_monthly_units: 80,
      parent_asin: null,
      variation_group_size: 1,
      buy_box_change_count_90d: 4,
    });
  }
  return rows;
}

/**
 * In-memory Supabase stub with just enough surface for
 * getBrandAsinsForRevenue: `.from("brand_asins").select(...).eq(...)`.
 */
function makeSupabaseStub(rows: FakeRow[]) {
  const callLog: { kind: string; args: unknown[] }[] = [];
  const builder: any = {
    select(_cols: string) {
      callLog.push({ kind: "select", args: [_cols] });
      return this;
    },
    eq(_col: string, _val: unknown) {
      callLog.push({ kind: "eq", args: [_col, _val] });
      // Terminal — return promise-like with data/error.
      return Promise.resolve({ data: rows, error: null });
    },
    order() {
      callLog.push({ kind: "order", args: Array.from(arguments) });
      return this;
    },
    limit() {
      callLog.push({ kind: "limit", args: Array.from(arguments) });
      return this;
    },
  };
  const supabase: any = {
    from(_table: string) {
      callLog.push({ kind: "from", args: [_table] });
      return builder;
    },
  };
  return { supabase, callLog };
}

(async () => {
  // Mock global fetch — any call to a Keepa endpoint should fail the test.
  let productFetches = 0;
  let totalFetches = 0;
  globalThis.fetch = (async (url: string) => {
    totalFetches += 1;
    const u = String(url);
    if (u.includes("/product") || u.includes("keepa")) {
      productFetches += 1;
    }
    return new Response("blocked", { status: 500 });
  }) as any;

  const rev = await import("../src/lib/enrichment/revenue-estimator");
  const enr = await import("../src/lib/enrichment");

  const rows = buildSeed();

  // --- Test 1: getBrandAsinsForRevenue returns ALL rows ---
  const { supabase, callLog } = makeSupabaseStub(rows);
  const got = await enr.getBrandAsinsForRevenue(supabase, "brand-id-1");
  assertEq("getBrandAsinsForRevenue returns full set (80 rows)", got.length, 80);
  // Verify NO order/limit was applied.
  const orderCalls = callLog.filter((c) => c.kind === "order");
  const limitCalls = callLog.filter((c) => c.kind === "limit");
  assertEq("no .order(...) on revenue path", orderCalls.length, 0);
  assertEq("no .limit(...) on revenue path", limitCalls.length, 0);

  // --- Test 2: TTM ≈ Σ(units × price) × 12 ---
  const expectedMonthlyGmv = rows.reduce(
    (s, r) => s + (r.attributed_monthly_units ?? 0) * (r.buy_box_price ?? 0),
    0,
  );
  const expectedTtm = expectedMonthlyGmv * 12;
  // 50 × 30 × 19.99 = $29,985 + 30 × 80 × 99.99 = $239,976 → monthly $269,961
  // ttm $3,239,532
  approxEq("expected monthly GMV", expectedMonthlyGmv, 269961, 50);

  const estimate = rev.estimateBrandTtmRevenueFromPersisted(
    got.map((r) => ({
      asin: r.asin,
      attributed_monthly_units: r.attributed_monthly_units,
      buy_box_price: r.buy_box_price,
      variation_group_size: r.variation_group_size,
      is_brand_controlled: r.is_brand_controlled,
    })),
  );
  approxEq(
    "TTM revenue ≈ Σ(units × price) × 12",
    estimate.total_ttm_revenue ?? 0,
    expectedTtm,
    // Per-asin Math.round in the estimator can introduce ±N rounding
    // (one per asin) — 80 ASINs → up to ±40.
    100,
  );

  // --- Test 3: ALL rows contribute (no truncation) ---
  assertEq("asins_in_sum equals row count", estimate.asins_in_sum, 80);
  assertEq("asins_excluded is zero", estimate.asins_excluded, 0);
  // And specifically: every long-tail BTAIL row is in per_asin with revenue.
  const tailWithRevenue = estimate.per_asin.filter(
    (r) => r.asin.startsWith("BTAIL") && (r.ttm_revenue ?? 0) > 0,
  );
  assertEq("all 30 long-tail rows contribute revenue", tailWithRevenue.length, 30);

  // --- Test 4: No Keepa /product fetch happened ---
  assertEq("zero Keepa /product fetches", productFetches, 0);
  assertEq("zero outbound fetches at all on revenue path", totalFetches, 0);

  // --- Test 5: Source string updated ---
  assert(
    "source_note drops '365-day avg'",
    !estimate.source_note.includes("365-day avg"),
  );
  assert(
    "source_note adds 'full brand catalog' framing",
    estimate.source_note.includes("full brand catalog"),
  );
  assert(
    "source_note still credits Keepa (monthlySold or BSR fallback)",
    estimate.source_note.includes("Keepa") &&
      (estimate.source_note.includes("BSR") || estimate.source_note.includes("monthlySold")),
  );

  // --- Test 6: zero/null rows handled gracefully ---
  const mixed = rev.estimateBrandTtmRevenueFromPersisted([
    { asin: "A1", attributed_monthly_units: 100, buy_box_price: 10 },
    { asin: "A2", attributed_monthly_units: 0, buy_box_price: 20 }, // pallet
    { asin: "A3", attributed_monthly_units: 50, buy_box_price: null }, // no price
    { asin: "A4", attributed_monthly_units: null, buy_box_price: 30 }, // no units
  ]);
  // A1: 100 * 10 * 12 = 12000
  // A2: 0 (pallet, intentionally)
  // A3: excluded (no price)
  // A4: excluded (no units → no rank → no override)
  approxEq("mixed: TTM equals only-A1 contribution", mixed.total_ttm_revenue ?? -1, 12000, 1);
  assertEq("mixed: A1 + A2 in sum (A2 contributes $0)", mixed.asins_in_sum, 2);

  // Restore fetch
  globalThis.fetch = ORIGINAL_FETCH;

  console.log(`\n${counts.pass} passed, ${counts.fail} failed`);
  if (counts.fail > 0) process.exit(1);
})();
