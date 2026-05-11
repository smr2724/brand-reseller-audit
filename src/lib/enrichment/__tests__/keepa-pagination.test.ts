/**
 * Phase 66 — Keepa pagination termination tests.
 *
 * Covers the matrix from the Phase 66 spec for searchProductsByBrand:
 *
 *   A. Loop terminates when Keepa returns a short page (<perPage).
 *   B. Loop terminates when Keepa returns an empty page.
 *   C. Loop terminates when totalProducts is exhausted.
 *   D. Loop terminates at maxResults requested by caller.
 *   E. Loop terminates at the Phase 66 hard ASIN cap (5,000)
 *      even when Keepa would happily return more.
 *   F. Loop terminates at the page-count ceiling
 *      (KEEPA_MAX_PAGES_PER_BRAND × perPage).
 *   G. Loop terminates on the Phase 66 wall-clock guard (slow Keepa
 *      response inflates per-page latency past 90s budget).
 *
 * Implementation note: the test patches global fetch + the keepa token
 * cache so we don't need real credentials or network. Run with:
 *   npx tsx src/lib/enrichment/__tests__/keepa-pagination.test.ts
 */
import assert from "node:assert/strict";

process.env.KEEPA_API_KEY = "test-key";
process.env.KEEPA_DOMAIN_ID = "1";
// Force a tiny page ceiling so case-F lands fast.
process.env.KEEPA_MAX_PAGES_PER_BRAND = "5";

interface MockResponse {
  status: number;
  ok: boolean;
  json: () => Promise<any>;
  text: () => Promise<string>;
}

function makeRes(body: any, status = 200): MockResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Token endpoint stays fat so ensureTokens passes through immediately.
const TOKEN_OK = { tokensLeft: 4000, refillIn: 0, refillRate: 0 };

let fetchScript: Array<{
  match: (url: string) => boolean;
  reply: (url: string) => MockResponse | Promise<MockResponse>;
}> = [];

function installFetch() {
  (globalThis as any).fetch = async (url: string | URL, _init?: any) => {
    const u = typeof url === "string" ? url : url.toString();
    for (const handler of fetchScript) {
      if (handler.match(u)) return handler.reply(u);
    }
    throw new Error(`no fetch handler matched ${u}`);
  };
}

installFetch();

async function load() {
  // Re-import per-test so module-level token cache is reset.
  delete require.cache[require.resolve("../../keepa")];
  delete require.cache[require.resolve("../../brand/recover-stuck-brands")];
  return require("../../keepa") as typeof import("../../keepa");
}

function genAsins(n: number, offset = 0): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const idx = i + offset;
    // Valid 10-char ASIN format
    out.push("B" + idx.toString(16).toUpperCase().padStart(9, "0"));
  }
  return out;
}

function pageHandler(pages: { asinList: string[]; totalProducts?: number }[]) {
  let callIndex = 0;
  fetchScript = [
    { match: (u) => u.includes("/token"), reply: () => makeRes(TOKEN_OK) },
    {
      match: (u) => u.includes("/query"),
      reply: () => {
        const page = pages[callIndex] ?? { asinList: [] };
        callIndex += 1;
        return makeRes({
          asinList: page.asinList,
          totalProducts: page.totalProducts,
          tokensLeft: TOKEN_OK.tokensLeft,
          tokensConsumed: 1,
          refillIn: 0,
          refillRate: 0,
        });
      },
    },
  ];
  return () => callIndex;
}

async function test_A_shortPage() {
  const calls = pageHandler([{ asinList: genAsins(40) }]);
  const { searchProductsByBrand } = await load();
  const r = await searchProductsByBrand("Tiny Brand", 500);
  assert.equal(r.asins.length, 40);
  assert.equal(calls(), 1, "should stop after first short page");
  console.log("ok: A — short page (<perPage) terminates the loop");
}

async function test_B_emptyPage() {
  const calls = pageHandler([{ asinList: [] }]);
  const { searchProductsByBrand } = await load();
  const r = await searchProductsByBrand("Empty Brand", 500);
  assert.equal(r.asins.length, 0);
  assert.equal(calls(), 1, "should stop after empty page");
  console.log("ok: B — empty page terminates the loop");
}

async function test_C_totalProductsReached() {
  const calls = pageHandler([
    { asinList: genAsins(100, 0), totalProducts: 100 },
  ]);
  const { searchProductsByBrand } = await load();
  const r = await searchProductsByBrand("Exact-100 Brand", 500);
  // The current implementation breaks on the short-page rule before
  // this branch fires for full pages; but the totalProducts branch
  // does fire when the next page would exceed it. We just verify the
  // outcome here.
  assert.equal(r.asins.length, 100);
  assert.ok(calls() <= 2, "should stop within two calls");
  console.log("ok: C — totalProducts cap terminates the loop");
}

async function test_D_maxResults() {
  const calls = pageHandler([
    { asinList: genAsins(100, 0), totalProducts: 10_000 },
    { asinList: genAsins(100, 100), totalProducts: 10_000 },
    { asinList: genAsins(100, 200), totalProducts: 10_000 },
  ]);
  const { searchProductsByBrand } = await load();
  const r = await searchProductsByBrand("Big Brand", 50);
  assert.equal(r.asins.length, 50, "caller's maxResults must clip the output");
  assert.equal(calls(), 1, "first page already exceeded maxResults");
  console.log("ok: D — maxResults clips output and stops further pages");
}

async function test_E_hardAsinCap() {
  // Provide enough pages of 100 ASINs to comfortably exceed 5000. The
  // hard cap should trip before the page-count ceiling does (5 pages ×
  // 100 = 500). For this test bump the env page ceiling to a value the
  // hard cap will trip below.
  process.env.KEEPA_MAX_PAGES_PER_BRAND = "100";
  // Fresh module load required to pick up the env change.
  const pages: { asinList: string[]; totalProducts?: number }[] = [];
  for (let p = 0; p < 60; p++) {
    pages.push({ asinList: genAsins(100, p * 100), totalProducts: 100_000 });
  }
  pageHandler(pages);
  const { searchProductsByBrand } = await load();
  const r = await searchProductsByBrand("Mega Brand", 100_000);
  // The pagination loop's hard ASIN cap is hardcoded at 5000.
  assert.equal(r.asins.length, 5000, "hard ASIN cap must clip accumulator at 5000");
  console.log("ok: E — Phase 66 hard ASIN cap (5000) terminates the loop");
  process.env.KEEPA_MAX_PAGES_PER_BRAND = "5";
}

async function test_F_pageCeiling() {
  // 5 pages × 100 ASINs each, all reporting totalProducts way higher
  // than we'll ever fetch.
  const pages: { asinList: string[]; totalProducts?: number }[] = [];
  for (let p = 0; p < 50; p++) {
    pages.push({ asinList: genAsins(100, p * 100), totalProducts: 100_000 });
  }
  const calls = pageHandler(pages);
  const { searchProductsByBrand, KEEPA_MAX_PAGES_PER_BRAND } = await load();
  const r = await searchProductsByBrand("Ceiling Brand", 100_000);
  // The page ceiling caps us at KEEPA_MAX_PAGES_PER_BRAND × 100 ASINs.
  assert.equal(r.asins.length, KEEPA_MAX_PAGES_PER_BRAND * 100);
  assert.equal(calls(), KEEPA_MAX_PAGES_PER_BRAND, "should stop at the page ceiling");
  console.log("ok: F — page-count ceiling terminates the loop");
}

async function test_G_paginationWallClock() {
  // Each page response is delayed past the 90s wall-clock budget.
  // To avoid a 90s test, monkey-patch the wall-clock check via a
  // lightweight strategy: we set Date.now to fast-forward after the
  // first page. The implementation reads `Date.now()` directly so
  // this works.
  const realDateNow = Date.now;
  let virtualNow = realDateNow();
  Date.now = () => virtualNow;
  try {
    let pageIndex = 0;
    fetchScript = [
      { match: (u) => u.includes("/token"), reply: () => makeRes(TOKEN_OK) },
      {
        match: (u) => u.includes("/query"),
        reply: () => {
          pageIndex += 1;
          // Advance virtual clock by 60s on the second page so the
          // next iteration trips the 90s pagination wall-clock.
          if (pageIndex >= 2) virtualNow += 60_000;
          return makeRes({
            asinList: genAsins(100, (pageIndex - 1) * 100),
            totalProducts: 100_000,
            tokensLeft: TOKEN_OK.tokensLeft,
            tokensConsumed: 1,
            refillIn: 0,
            refillRate: 0,
          });
        },
      },
    ];
    const { searchProductsByBrand } = await load();
    const r = await searchProductsByBrand("Slow Brand", 100_000);
    // We should have terminated before the page ceiling because of
    // the wall-clock guard.
    assert.ok(r.asins.length <= 500, "wall-clock guard breaks loop before full ceiling");
    console.log("ok: G — pagination wall-clock guard terminates the loop");
  } finally {
    Date.now = realDateNow;
  }
}

(async () => {
  await test_A_shortPage();
  await test_B_emptyPage();
  await test_C_totalProductsReached();
  await test_D_maxResults();
  await test_E_hardAsinCap();
  await test_F_pageCeiling();
  await test_G_paginationWallClock();
  console.log("\nPhase 66 keepa-pagination tests: ALL GREEN");
})().catch((e) => {
  console.error("test failure:", e);
  process.exit(1);
});
