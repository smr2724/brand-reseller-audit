/**
 * Phase 25.2 smoke test for src/lib/brand-search/search.ts.
 *
 * Run with: npx tsx scripts/test-brand-search.mts
 *
 * No real network. Both Keepa /search and DataForSEO Amazon SERP are
 * passed in via the deps DI hook so we can deterministically reproduce
 * the bug we just fixed: candidate.name being echoed from the user's
 * query instead of sourced from an authoritative external response.
 */
import { searchBrands, clearBrandSearchCache } from "../src/lib/brand-search/search.js";

let pass = 0;
let fail = 0;

function assert(cond: unknown, msg: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

async function test(name: string, fn: () => Promise<void> | void) {
  console.log(`\n# ${name}`);
  clearBrandSearchCache();
  try {
    await fn();
  } catch (e) {
    fail++;
    console.error("  ✗ threw:", e);
  }
}

await test(
  "Keepa /search canonical brand surfaces verbatim — does NOT echo user query",
  async () => {
    const userQuery = "Couples coffee"; // lowercase, no apostrophe — the bug input
    const canonical = "Couple's Coffee Co.";
    const r = await searchBrands(userQuery, "tight", {
      isKeepaConfigured: () => true,
      isDataForSEOConfigured: () => false,
      keepaSearch: async () => ({
        products: [
          { asin: "B0AAAAAAAA", brand: canonical, title: "X" },
          { asin: "B0BBBBBBBB", brand: canonical, title: "Y" },
          { asin: "B0CCCCCCCC", brand: "Other Brand", title: "Z" },
        ],
        tokens_left: 100,
      }),
    });
    const top = r.candidates[0];
    assert(top, "got at least one candidate");
    assert(top.name === canonical, `top candidate name === '${canonical}' (got '${top.name}')`);
    assert(top.source === "keepa", `top candidate source === 'keepa' (got '${top.source}')`);
    assert(
      r.candidates.every((c) => c.name !== userQuery && c.name !== "Couples Coffee"),
      "no candidate echoes the user's query string",
    );
    assert(top.asin_count === 2, `Keepa-returned brand asin_count === 2 (got ${top.asin_count})`);
  },
);

await test(
  "Echo guard: even when sources contain user's query in product fields, candidates are sourced from explicit `brand`",
  async () => {
    const userQuery = "Couples coffee";
    const r = await searchBrands(userQuery, "tight", {
      isKeepaConfigured: () => true,
      isDataForSEOConfigured: () => true,
      keepaSearch: async () => ({
        products: [
          { asin: "B01AAAAAAA", brand: "Couple's Coffee Co.", title: "Couples coffee 12oz Medium Roast" },
        ],
        tokens_left: 50,
      }),
      // DFS items: titles all start with the user query (this is what
      // Amazon search returns) but `brand` is explicit on every item.
      dfs: async () => [
        { asin: "B01AAAAAAA", title: "Couples coffee bag", brand: "Couple's Coffee Co." },
        { asin: "B02BBBBBBB", title: "Couples coffee gift set", brand: "Couple's Coffee Co." },
        { asin: "B03CCCCCCC", title: "Couples coffee mug — generic", brand: "" }, // no brand → MUST be dropped, not inferred from title
      ],
    });
    assert(
      r.candidates.every((c) => c.name !== userQuery),
      "no candidate has name === user query",
    );
    assert(
      r.candidates.every((c) => c.name !== "Couples coffee bag"),
      "no candidate has title-leading-tokens as name",
    );
    assert(
      r.candidates[0]?.name === "Couple's Coffee Co.",
      `top candidate is canonical (got '${r.candidates[0]?.name}')`,
    );
    // keepa + dataforseo merge → source should be "both"
    assert(r.candidates[0]?.source === "both", `merged source === 'both' (got '${r.candidates[0]?.source}')`);
  },
);

await test(
  "Fallback row only fires when EVERY external source returns 0",
  async () => {
    const r = await searchBrands("zzzzzznoexistbrand", "tight", {
      isKeepaConfigured: () => true,
      isDataForSEOConfigured: () => true,
      keepaSearch: async () => ({ products: [], tokens_left: 100 }),
      dfs: async () => [],
    });
    assert(r.candidates.length === 1, "exactly one fallback candidate");
    assert(r.candidates[0].source === "fallback", "source === fallback");
    assert(r.exhausted === true, "exhausted true when only fallback present");
  },
);

await test(
  "Fallback NOT shown when Keepa returns hits",
  async () => {
    const r = await searchBrands("Acme", "tight", {
      isKeepaConfigured: () => true,
      isDataForSEOConfigured: () => true,
      keepaSearch: async () => ({
        products: [{ asin: "B099999999", brand: "Acme Inc.", title: "t" }],
        tokens_left: 10,
      }),
      dfs: async () => [],
    });
    assert(
      !r.candidates.some((c) => c.source === "fallback"),
      "no fallback row when Keepa has a hit",
    );
    assert(r.candidates[0].name === "Acme Inc.", "canonical Acme Inc. surfaced");
  },
);

await test(
  "DFS-only path: explicit brand attribute used, items with empty brand dropped (no title-inference echo)",
  async () => {
    const userQuery = "vague search term";
    const r = await searchBrands(userQuery, "tight", {
      isKeepaConfigured: () => false,
      isDataForSEOConfigured: () => true,
      dfs: async () => [
        { asin: "B0DFS00001", title: "Vague search term — Acme item", brand: "Acme" },
        { asin: "B0DFS00002", title: "Vague search term anything else", brand: "" },
      ],
    });
    assert(
      r.candidates.every((c) => c.name !== userQuery),
      "no candidate echoes user query",
    );
    assert(r.candidates.some((c) => c.name === "Acme"), "explicit DFS brand Acme surfaced");
    assert(
      !r.candidates.some((c) => c.name?.toLowerCase().startsWith("vague search term")),
      "no candidate has name derived from leading title tokens",
    );
  },
);

await test(
  "Casing/punctuation merge keeps the canonical (longer) form when names differ ONLY in case/punctuation",
  async () => {
    const r = await searchBrands("Couples coffee", "tight", {
      isKeepaConfigured: () => true,
      isDataForSEOConfigured: () => true,
      keepaSearch: async () => ({
        products: [
          { asin: "B11", brand: "Couple's Coffee Co.", title: "x" },
          { asin: "B12", brand: "Couple's Coffee Co.", title: "x" },
        ],
        tokens_left: 50,
      }),
      // Same brand name as Keepa but lowercased and different punctuation —
      // dedupeKey collapses them, longer form is kept.
      dfs: async () => [
        { asin: "B13", title: "x", brand: "couple's coffee co" },
      ],
    });
    const names = r.candidates.map((c) => c.name);
    assert(names.includes("Couple's Coffee Co."), "kept the longer canonical form");
    assert(
      !names.includes("couple's coffee co"),
      "dropped the lowercase variant during dedupe",
    );
    assert(r.candidates.length === 1, "merged into one candidate");
  },
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
