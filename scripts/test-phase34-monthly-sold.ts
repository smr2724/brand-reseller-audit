/**
 * Phase 34 — Tests for Keepa `monthlySold` ingestion + preference over
 * the BSR-curve estimate when present.
 *
 * Coverage:
 *  1. monthly_sold = 100, curve = 60          → raw = 100 (badge wins)
 *  2. monthly_sold = 200, curve = 800         → raw = 800 (curve wins via Math.max — defensive)
 *  3. monthly_sold = 0                        → treated as null (curve wins)
 *  4. monthly_sold = null                     → curve used unchanged
 *  5. multi-sibling variation group           → only active sibling has badge;
 *                                                others fall back to curve
 *  6. end-to-end: Keepa /product response with monthlySold parses through to
 *     KeepaProductDetails.monthly_sold and downstream upsert payload carries
 *     keepa_monthly_sold = monthlySold and raw_monthly_units = monthlySold.
 *
 * Run:
 *   npx tsx scripts/test-phase34-monthly-sold.ts
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

/**
 * Mirrors the writer's per-ASIN derivation in
 * `src/lib/enrichment/keepa-brand.ts:330-348` so the unit tests can pin
 * the exact behavior without reaching into a Supabase mock for cases
 * that don't need it. End-to-end plumbing (case 6) still runs the real
 * Keepa parser and the real attribution + writer-shape logic.
 */
function deriveRaw(
  fromKeepa: number | null,
  fromCurve: number | null,
): number | null {
  return fromKeepa != null ? Math.max(fromKeepa, fromCurve ?? 0) : fromCurve;
}

(async () => {
  const { rankToMonthlyUnits } = await import(
    "../src/lib/enrichment/revenue-estimator"
  );

  // --- Test 1: monthly_sold = 100, curve = 60 → 100 ---
  // Beauty/HIGH tier, rank 98208 lands in [50000,100000) bucket = 60.
  {
    const curve = rankToMonthlyUnits(
      98208,
      null,
      "Beauty & Personal Care > Skin Care > Body > Sets & Kits",
    );
    assertEq("HIGH-tier curve at rank 98208 = 60", curve, 60);
    const raw = deriveRaw(100, curve);
    assertEq("monthly_sold=100 + curve=60 → raw=100", raw, 100);
  }

  // --- Test 2: monthly_sold = 200, curve = 800 → 800 (defensive floor) ---
  {
    // HIGH tier, rank in [5000,10000) = 800.
    const curve = rankToMonthlyUnits(
      7000,
      null,
      "Beauty & Personal Care > Skin Care",
    );
    assertEq("HIGH-tier curve at rank 7000 = 800", curve, 800);
    const raw = deriveRaw(200, curve);
    assertEq(
      "monthly_sold=200 + curve=800 → raw=800 (Math.max defensive floor)",
      raw,
      800,
    );
  }

  // --- Test 3: monthly_sold = 0 → treated as null, curve wins ---
  // The Keepa parser is the source of truth for the 0→null mapping.
  // Verify both: (a) the parser flips 0 to null end-to-end (case 6 below),
  // (b) when monthly_sold is null the curve is used unchanged.
  {
    const curve = rankToMonthlyUnits(98208, null, "Beauty & Personal Care");
    const raw = deriveRaw(null, curve); // emulates post-parser
    assertEq("monthly_sold=null (post-0-mapping) → raw = curve = 60", raw, 60);
  }

  // --- Test 4: monthly_sold = null → curve unchanged ---
  {
    const curve = rankToMonthlyUnits(
      750_000,
      null,
      "Beauty & Personal Care > Skin Care",
    );
    // HIGH-tier rank 750k → in [500k,1M) = 4 units.
    assertEq("HIGH-tier curve at rank 750k = 4", curve, 4);
    const raw = deriveRaw(null, curve);
    assertEq("monthly_sold=null + curve=4 → raw=4", raw, 4);
  }

  // --- Test 5: multi-sibling variation group — only active has badge ---
  // Mirrors the H2O Therapy case from the diagnostic doc:
  //   B07PDKG2TL (active 300pc retail): monthly_sold = 100
  //   B0CNS4BJMR / B0CNS67V32 / B0CPTM6MKB (pallet/half/parent): null
  // All four share rank ~98000 → curve = 60 each.
  // Pre-attribution per-child raw should be:
  //   B07PDKG2TL → 100, others → 60.
  {
    type Sibling = {
      asin: string;
      monthly_sold: number | null;
      rank: number;
    };
    const siblings: Sibling[] = [
      { asin: "B07PDKG2TL", monthly_sold: 100, rank: 98208 },
      { asin: "B0CNS4BJMR", monthly_sold: null, rank: 98208 },
      { asin: "B0CNS67V32", monthly_sold: null, rank: 98212 },
      { asin: "B0CPTM6MKB", monthly_sold: null, rank: 98208 },
    ];
    const derived = siblings.map((s) => {
      const curve = rankToMonthlyUnits(
        s.rank,
        null,
        "Beauty & Personal Care > Skin Care > Body > Sets & Kits",
      );
      return { asin: s.asin, raw: deriveRaw(s.monthly_sold, curve) };
    });
    assertEq(
      "multi-sibling: active retail child gets 100",
      derived.find((d) => d.asin === "B07PDKG2TL")?.raw,
      100,
    );
    assertEq(
      "multi-sibling: full pallet falls back to curve = 60",
      derived.find((d) => d.asin === "B0CNS4BJMR")?.raw,
      60,
    );
    assertEq(
      "multi-sibling: half pallet falls back to curve = 60",
      derived.find((d) => d.asin === "B0CNS67V32")?.raw,
      60,
    );
    assertEq(
      "multi-sibling: parent shell falls back to curve = 60",
      derived.find((d) => d.asin === "B0CPTM6MKB")?.raw,
      60,
    );

    // After group_max attribution, the group rallies on the 100 — confirm
    // the variation-attribution step doesn't strip away the badge gain.
    const va = await import("../src/lib/enrichment/variation-attribution");
    const inputs = derived.map((d) => ({
      asin: d.asin,
      parent_asin: "B0CPTM6MKB",
      raw_monthly_units: d.raw,
      recent_review_count: d.asin === "B07PDKG2TL" ? 50 : 5,
      // Phase 32.1 — only active sibling has BB history.
      buy_box_change_count_90d: d.asin === "B07PDKG2TL" ? 12 : null,
    }));
    const out = va.attributeVariationSales(inputs);
    const active = out.find((r) => r.asin === "B07PDKG2TL");
    assertEq(
      "variation: active sibling raw_monthly_units echoes 100",
      active?.raw_monthly_units,
      100,
    );
    // group_max across siblings = max(100, 60, 60, 60) = 100. With
    // Phase 32.1 null-BB-as-zero-signal, only the active sibling has a
    // weight, so its attributed_monthly_units should equal the group_max.
    assertEq(
      "variation: active sibling absorbs full group_max via Phase 32.1",
      active?.attributed_monthly_units,
      100,
    );
    const pallet = out.find((r) => r.asin === "B0CNS4BJMR");
    assertEq(
      "variation: dormant pallet attributed_monthly_units zeros via Phase 32.1",
      pallet?.attributed_monthly_units,
      0,
    );
  }

  // --- Test 6: end-to-end Keepa parser → upsert payload ---
  // Mock the Keepa /product fetch with monthlySold = 100 (tier=2 floor)
  // for one ASIN and monthlySold = 0 for another. Verify:
  //   - parser flips 0 → null
  //   - parser preserves 100 as 100
  //   - the writer's per-ASIN derivation produces raw_monthly_units = 100
  //     for the badge ASIN; null/curve for the 0-mapped one
  //   - the upsert row carries keepa_monthly_sold = 100 and 0→null
  {
    const keepa = await import("../src/lib/keepa");
    keepa.clearKeepaProductCache();

    let productCalls = 0;
    globalThis.fetch = (async (url: string, _init?: any) => {
      const u = String(url);
      if (u.includes("/token")) {
        return new Response(
          JSON.stringify({
            tokensLeft: 5000,
            refillIn: 0,
            refillRate: 5,
          }),
          { status: 200 },
        );
      }
      if (u.includes("/product")) {
        productCalls += 1;
        const body = {
          tokensLeft: 4000,
          refillIn: 0,
          refillRate: 5,
          products: [
            {
              asin: "BADGE10000",
              title: "Badged ASIN",
              brand: "TestBrand",
              monthlySold: 100,
              parentAsin: null,
              productGroup: null,
              categoryTree: [
                { catId: 11055981, name: "Beauty & Personal Care" },
                { catId: 11060451, name: "Skin Care" },
              ],
              stats: {
                current: [
                  null, null, null, 98208, null, null, null, null, null, null,
                  null, null, null, null, null, null, null, null, 17999,
                ],
                avg365: [
                  null, null, null, 68486, null, null, null, null, null, null,
                  null, null, null, null, null, null, null, null, 18000,
                ],
                offerCountNew: 3,
              },
              offers: [],
              imagesCount: 5,
              features: [],
              videos: [],
              aPlus: [],
            },
            {
              asin: "ZEROBADGE0",
              title: "Zero-badge ASIN",
              brand: "TestBrand",
              monthlySold: 0, // must map to null
              parentAsin: null,
              productGroup: null,
              categoryTree: [
                { catId: 11055981, name: "Beauty & Personal Care" },
              ],
              stats: {
                current: [
                  null, null, null, 98208, null, null, null, null, null, null,
                  null, null, null, null, null, null, null, null, 9999,
                ],
                avg365: [
                  null, null, null, 68486, null, null, null, null, null, null,
                  null, null, null, null, null, null, null, null, 10000,
                ],
                offerCountNew: 2,
              },
              offers: [],
              imagesCount: 3,
              features: [],
              videos: [],
              aPlus: [],
            },
            {
              asin: "NULLBADGE0",
              title: "No-badge ASIN",
              brand: "TestBrand",
              // monthlySold field omitted entirely.
              parentAsin: null,
              productGroup: null,
              categoryTree: [
                { catId: 11055981, name: "Beauty & Personal Care" },
              ],
              stats: {
                current: [
                  null, null, null, 98208, null, null, null, null, null, null,
                  null, null, null, null, null, null, null, null, 4999,
                ],
                avg365: [
                  null, null, null, 68486, null, null, null, null, null, null,
                  null, null, null, null, null, null, null, null, 5000,
                ],
                offerCountNew: 1,
              },
              offers: [],
              imagesCount: 1,
              features: [],
              videos: [],
              aPlus: [],
            },
          ],
        };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response("not stubbed", { status: 404 });
    }) as any;

    process.env.KEEPA_API_KEY = "test-key";

    const details = await keepa.getProductDetails([
      "BADGE10000",
      "ZEROBADGE0",
      "NULLBADGE0",
    ]);
    assertEq("end-to-end: Keepa parser called once", productCalls, 1);
    assertEq("end-to-end: parser returned 3 products", details.length, 3);

    const badged = details.find((d) => d.asin === "BADGE10000");
    const zeroed = details.find((d) => d.asin === "ZEROBADGE0");
    const nulled = details.find((d) => d.asin === "NULLBADGE0");

    assertEq(
      "end-to-end: monthly_sold=100 preserved through parser",
      badged?.monthly_sold,
      100,
    );
    assertEq(
      "end-to-end: monthly_sold=0 mapped to null by parser",
      zeroed?.monthly_sold,
      null,
    );
    assertEq(
      "end-to-end: missing monthlySold mapped to null by parser",
      nulled?.monthly_sold,
      null,
    );

    // Now mirror the writer's per-ASIN derivation (the same 4 lines used
    // in `enrichBrandWithKeepa`) and verify each ASIN's upsert payload.
    for (const p of details) {
      const rank = p.sales_rank_avg365 ?? p.sales_rank_current ?? null;
      const categoryPath =
        p.category_tree?.map((c) => c.name).join(" > ") ?? null;
      const fromKeepa = p.monthly_sold ?? null;
      const fromCurve = rankToMonthlyUnits(
        rank,
        p.product_group ?? null,
        categoryPath,
      );
      const raw =
        fromKeepa != null ? Math.max(fromKeepa, fromCurve ?? 0) : fromCurve;
      const upsertRow = {
        asin: p.asin,
        raw_monthly_units: raw,
        keepa_monthly_sold: p.monthly_sold ?? null,
      };
      if (p.asin === "BADGE10000") {
        assertEq(
          "end-to-end (badge): upsert raw_monthly_units = 100",
          upsertRow.raw_monthly_units,
          100,
        );
        assertEq(
          "end-to-end (badge): upsert keepa_monthly_sold = 100",
          upsertRow.keepa_monthly_sold,
          100,
        );
      } else if (p.asin === "ZEROBADGE0") {
        assertEq(
          "end-to-end (zero): upsert raw_monthly_units falls back to curve = 60",
          upsertRow.raw_monthly_units,
          60,
        );
        assertEq(
          "end-to-end (zero): upsert keepa_monthly_sold = null",
          upsertRow.keepa_monthly_sold,
          null,
        );
      } else if (p.asin === "NULLBADGE0") {
        assertEq(
          "end-to-end (null): upsert raw_monthly_units falls back to curve = 60",
          upsertRow.raw_monthly_units,
          60,
        );
        assertEq(
          "end-to-end (null): upsert keepa_monthly_sold = null",
          upsertRow.keepa_monthly_sold,
          null,
        );
      }
    }
  }

  globalThis.fetch = ORIGINAL_FETCH;

  console.log(`\n${counts.pass} passed, ${counts.fail} failed`);
  if (counts.fail > 0) process.exit(1);
})();
