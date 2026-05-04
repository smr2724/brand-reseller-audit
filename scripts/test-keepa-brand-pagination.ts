/**
 * Phase 33 — Pagination tests for `searchProductsByBrand`.
 *
 * Verifies:
 *  1. Loop terminates after the last short page (Keepa exhausted) and
 *     accumulates ASINs across pages until `totalProducts` is satisfied.
 *  2. `tokens_used` is the *sum* of `tokensConsumed` across pages.
 *  3. The caller's `maxResults` slice still applies after pagination.
 *  4. The pagination respects `KEEPA_MAX_PAGES_PER_BRAND` as a hard ceiling.
 *  5. Phase 33.1 — selection includes rank-ceiling and Amazon-availability filters.
 *
 * Run:
 *   npx tsx scripts/test-keepa-brand-pagination.ts
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

interface PageStub {
  asinList: string[];
  totalProducts: number;
  tokensConsumed: number;
  tokensLeft: number;
}

/**
 * Builds a fake fetch that:
 *  - Returns a generous token status for /token (used by ensureTokens and
 *    the in-loop budget check).
 *  - Returns the next scripted page from `pages` for each /query call,
 *    asserting page index increments correctly.
 */
function makeFakeFetch(pages: PageStub[], tokensLeftBetween = 3000) {
  let queryCalls = 0;
  const pageIndices: number[] = [];
  const selections: any[] = [];
  const fn = async (url: string, _init?: any) => {
    const u = String(url);
    if (u.includes("/token?")) {
      return new Response(
        JSON.stringify({ tokensLeft: tokensLeftBetween, refillIn: 0, refillRate: 5 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("/query?")) {
      const m = u.match(/selection=([^&]+)/);
      const sel = m ? JSON.parse(decodeURIComponent(m[1])) : null;
      pageIndices.push(Number(sel?.page ?? -1));
      selections.push(sel);
      const stub = pages[queryCalls] ?? {
        asinList: [],
        totalProducts: 0,
        tokensConsumed: 0,
        tokensLeft: tokensLeftBetween,
      };
      queryCalls += 1;
      return new Response(JSON.stringify(stub), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };
  return {
    fetch: fn,
    queryCount: () => queryCalls,
    pageIndices: () => pageIndices,
    selections: () => selections,
  };
}

(async () => {
  process.env.KEEPA_API_KEY = "test-key";

  const keepaMod = await import("../src/lib/keepa");
  const { searchProductsByBrand, KEEPA_MAX_PAGES_PER_BRAND, KEEPA_BRAND_SEARCH_RANK_CEILING } = keepaMod;

  // 1. Three pages — 100 / 100 / 50 — totalProducts 250.
  //    Loop must exit after page 2 (last page short). Accumulated = 250.
  //    tokens_used = sum across pages.
  {
    const pages: PageStub[] = [
      {
        asinList: Array.from({ length: 100 }, (_, i) => `A${String(i).padStart(9, "0")}`),
        totalProducts: 250,
        tokensConsumed: 5,
        tokensLeft: 2995,
      },
      {
        asinList: Array.from({ length: 100 }, (_, i) => `B${String(i).padStart(9, "0")}`),
        totalProducts: 250,
        tokensConsumed: 5,
        tokensLeft: 2990,
      },
      {
        asinList: Array.from({ length: 50 }, (_, i) => `C${String(i).padStart(9, "0")}`),
        totalProducts: 250,
        tokensConsumed: 5,
        tokensLeft: 2985,
      },
    ];
    const fake = makeFakeFetch(pages);
    globalThis.fetch = fake.fetch as any;

    const result = await searchProductsByBrand("Test Brand", 500);

    assertEq("3-page sweep — accumulated length is totalProducts (250)", result.asins.length, 250);
    assertEq("3-page sweep — first ASIN is page-0 first element", result.asins[0], "A000000000");
    assertEq("3-page sweep — last ASIN is page-2 last element", result.asins[249], "C000000049");
    assertEq("3-page sweep — tokens_used summed (5+5+5=15)", result.tokens_used, 15);
    assertEq("3-page sweep — tokens_left from final page", result.tokens_left, 2985);
    // Includes one /token preflight from ensureTokens; the remainder are /query.
    assertEq("3-page sweep — exactly 3 /query calls issued", fake.queryCount(), 3);
    assertEq(
      "3-page sweep — page indices were 0, 1, 2 in order",
      fake.pageIndices(),
      [0, 1, 2],
    );
  }

  // 2. Same 3-page stub, but caller asks for maxResults=50 — pagination still
  //    works mechanically, but the slice must cap at 50. We expect the loop
  //    to break on the maxResults guard after page 0 (100 ≥ 50), so only
  //    one /query call is issued.
  {
    const pages: PageStub[] = [
      {
        asinList: Array.from({ length: 100 }, (_, i) => `A${String(i).padStart(9, "0")}`),
        totalProducts: 250,
        tokensConsumed: 5,
        tokensLeft: 2995,
      },
      {
        asinList: Array.from({ length: 100 }, (_, i) => `B${String(i).padStart(9, "0")}`),
        totalProducts: 250,
        tokensConsumed: 5,
        tokensLeft: 2990,
      },
    ];
    const fake = makeFakeFetch(pages);
    globalThis.fetch = fake.fetch as any;

    const result = await searchProductsByBrand("Test Brand", 50);

    assertEq("maxResults=50 — slice yields exactly 50 ASINs", result.asins.length, 50);
    assertEq("maxResults=50 — first ASIN is page-0 first", result.asins[0], "A000000000");
    assertEq("maxResults=50 — last ASIN is page-0 element 49", result.asins[49], "A000000049");
    assertEq("maxResults=50 — only 1 /query call (loop broke on caller cap)", fake.queryCount(), 1);
  }

  // 3. Single short page — Keepa exhausted before any pagination needed.
  //    A small brand with 30 ASINs. Loop exits after page 0.
  {
    const pages: PageStub[] = [
      {
        asinList: Array.from({ length: 30 }, (_, i) => `Z${String(i).padStart(9, "0")}`),
        totalProducts: 30,
        tokensConsumed: 5,
        tokensLeft: 2995,
      },
    ];
    const fake = makeFakeFetch(pages);
    globalThis.fetch = fake.fetch as any;

    const result = await searchProductsByBrand("Tiny Brand", 500);

    assertEq("single short page — accumulated = 30", result.asins.length, 30);
    assertEq("single short page — only 1 /query call", fake.queryCount(), 1);
    assertEq("single short page — tokens_used = 5", result.tokens_used, 5);
  }

  // 4. KEEPA_MAX_PAGES_PER_BRAND ceiling — Keepa keeps returning full
  //    pages of 100. Loop must stop at the page ceiling even if Keepa
  //    has more.
  {
    // Build (KEEPA_MAX_PAGES_PER_BRAND + 2) full pages so we can prove
    // the loop never exceeds the ceiling.
    const huge: PageStub[] = Array.from({ length: KEEPA_MAX_PAGES_PER_BRAND + 2 }, (_, p) => ({
      asinList: Array.from({ length: 100 }, (_, i) => `H${p}${String(i).padStart(8, "0")}`),
      totalProducts: 9999,
      tokensConsumed: 5,
      tokensLeft: 3000 - p * 5,
    }));
    const fake = makeFakeFetch(huge);
    globalThis.fetch = fake.fetch as any;

    const result = await searchProductsByBrand("Huge Brand", 5000);

    assertEq(
      "page ceiling — exactly KEEPA_MAX_PAGES_PER_BRAND /query calls",
      fake.queryCount(),
      KEEPA_MAX_PAGES_PER_BRAND,
    );
    assertEq(
      "page ceiling — accumulated = ceiling × 100",
      result.asins.length,
      KEEPA_MAX_PAGES_PER_BRAND * 100,
    );
    assertEq(
      "page ceiling — tokens_used = ceiling × 5",
      result.tokens_used,
      KEEPA_MAX_PAGES_PER_BRAND * 5,
    );
  }

  // 5. Token-budget floor mid-loop — second page should be skipped if
  //    the cached token bucket has dropped below TOKEN_BUDGET_FLOOR.
  //    Page 0 returns tokensLeft=10 (below the default floor of 50);
  //    the in-loop check on page 1 must see that and bail.
  {
    const pages: PageStub[] = [
      {
        asinList: Array.from({ length: 100 }, (_, i) => `T${String(i).padStart(9, "0")}`),
        totalProducts: 9999,
        tokensConsumed: 5,
        tokensLeft: 10, // below floor
      },
      {
        asinList: Array.from({ length: 100 }, (_, i) => `U${String(i).padStart(9, "0")}`),
        totalProducts: 9999,
        tokensConsumed: 5,
        tokensLeft: 10,
      },
    ];
    // tokens-left served by /token endpoint = 10 too, so the in-loop
    // status check sees < floor.
    const fake = makeFakeFetch(pages, 10);
    globalThis.fetch = fake.fetch as any;

    const result = await searchProductsByBrand("Budget Brand", 5000);

    assertEq(
      "token-floor — only page 0 fetched (page 1 budget-gated)",
      fake.queryCount(),
      1,
    );
    assertEq("token-floor — accumulated from page 0 only", result.asins.length, 100);
  }

  // 6. Phase 33.1 — selection payload must carry the rank-ceiling filter
  //    and the Amazon-availability filter on every /query call.
  {
    const pages: PageStub[] = [
      {
        asinList: Array.from({ length: 30 }, (_, i) => `R${String(i).padStart(9, "0")}`),
        totalProducts: 30,
        tokensConsumed: 5,
        tokensLeft: 2995,
      },
    ];
    const fake = makeFakeFetch(pages);
    globalThis.fetch = fake.fetch as any;

    await searchProductsByBrand("Filter Brand", 500);

    const sels = fake.selections();
    assertEq("phase33.1 — exactly 1 /query call captured", sels.length, 1);
    assertEq(
      "phase33.1 — selection.current_SALES_lte equals KEEPA_BRAND_SEARCH_RANK_CEILING",
      sels[0]?.current_SALES_lte,
      KEEPA_BRAND_SEARCH_RANK_CEILING,
    );
    assertEq(
      "phase33.1 — selection.availabilityAmazon_gte is 0",
      sels[0]?.availabilityAmazon_gte,
      0,
    );
    // URLSearchParams encodes spaces as `+`; decodeURIComponent leaves
    // them as `+`. Either way, the brand string round-trips through the
    // selection — we just check it's present.
    assert(
      "phase33.1 — selection still carries brand + sort + perPage + page",
      typeof sels[0]?.brand?.[0] === "string" &&
        sels[0].brand[0].length > 0 &&
        Array.isArray(sels[0]?.sort) &&
        sels[0]?.perPage === 100 &&
        sels[0]?.page === 0,
    );
  }

  globalThis.fetch = ORIGINAL_FETCH;

  console.log(`\n${counts.pass} passed, ${counts.fail} failed.`);
  if (counts.fail > 0) process.exit(1);
})();
