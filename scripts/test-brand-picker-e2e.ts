/**
 * Phase 25.2 — End-to-end picker test.
 *
 * Verifies that the picker now sources candidate names ONLY from external
 * API responses (Keepa /search canonical brand or DFS explicit brand), and
 * never echoes the user's query back. The previous (25.1) version of this
 * test passed because it asserted a fuzzy regex match on the candidate
 * name, which the broken implementation satisfied by labelling the
 * variant-string itself as the candidate. Phase 25.2 tightens the
 * assertions to the canonical Keepa string verbatim.
 *
 * Uses the dependency-injection hooks on `searchBrands` to swap out the
 * Keepa /search + DFS providers without monkeypatching modules.
 *
 * Run: npx tsx scripts/test-brand-picker-e2e.ts
 */
import {
  searchBrands,
  clearBrandSearchCache,
  type SearchBrandsDeps,
} from "../src/lib/brand-search/search";

const CANONICAL = "Couple's Coffee Co.";

// Keepa /search is fuzzy-friendly: any of the user's typed forms will
// hit and return products with the canonical brand string verbatim.
function keepaSearch(_term: string, _page = 0) {
  return Promise.resolve({
    products: [
      { asin: "B0AAAAAAAA", brand: CANONICAL, title: "Whole bean medium roast" },
      { asin: "B0BBBBBBBB", brand: CANONICAL, title: "Single origin 16oz" },
      { asin: "B0CCCCCCCC", brand: CANONICAL, title: "Decaf 12oz" },
    ],
    tokens_left: 100,
  });
}

const DFS_BY_QUERY: Record<string, Array<{ title?: string; brand?: string }>> = {
  "Couple's Coffee": [
    { brand: CANONICAL, title: "Couple's Coffee Co. - 12oz Whole Bean, Medium Roast" },
    { brand: CANONICAL, title: "Couple's Coffee Co. - 16oz Ground" },
    { brand: "Starbucks", title: "Starbucks Pike Place" },
  ],
  "Couples coffee": [
    { brand: CANONICAL, title: "Couple's Coffee Co. - 12oz Whole Bean, Medium Roast" },
  ],
  "Couples Coffee": [
    { brand: CANONICAL, title: "Couple's Coffee Co. - Single Origin" },
  ],
  "COUPLE'S COFFEE CO.": [
    { brand: CANONICAL, title: "Couple's Coffee Co. - Single Origin" },
  ],
};

const deps: SearchBrandsDeps = {
  isKeepaConfigured: () => true,
  isDataForSEOConfigured: () => true,
  keepaSearch: keepaSearch as SearchBrandsDeps["keepaSearch"],
  dfs: async (query: string) => DFS_BY_QUERY[query] ?? [],
};

const noProvidersDeps: SearchBrandsDeps = {
  isKeepaConfigured: () => true,
  isDataForSEOConfigured: () => true,
  keepaSearch: async () => ({ products: [], tokens_left: 100 }),
  dfs: async () => [],
};

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} :: ${name}${detail ? " :: " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

async function main() {
  // The exact production failure: each of these inputs MUST resolve to the
  // canonical Keepa brand string, NOT echo the user query.
  for (const input of ["Couple's Coffee", "Couples Coffee", "Couples coffee"]) {
    clearBrandSearchCache();
    const r = await searchBrands(input, "tight", deps);
    check(
      `e2e 25.2: '${input}' returns ≥1 real candidate (not fallback)`,
      r.candidates.length >= 1 && r.candidates.some((c) => c.source !== "fallback"),
      `${r.candidates.length} candidates: ${JSON.stringify(r.candidates.map((c) => c.name))}`,
    );
    check(
      `e2e 25.2: '${input}' top candidate.name === canonical Keepa brand verbatim`,
      r.candidates[0]?.name === CANONICAL,
      `got '${r.candidates[0]?.name}'`,
    );
    check(
      `e2e 25.2: '${input}' no candidate echoes the user query`,
      r.candidates.every((c) => c.name !== input),
      JSON.stringify(r.candidates.map((c) => c.name)),
    );
  }

  // Exact ALL-CAPS + CO. input also resolves to canonical via Keepa /search.
  {
    clearBrandSearchCache();
    const r = await searchBrands("COUPLE'S COFFEE CO.", "tight", deps);
    check(
      "e2e 25.2: ALL-CAPS exact input resolves to canonical brand",
      r.candidates[0]?.name === CANONICAL,
      JSON.stringify(r.candidates.slice(0, 3)),
    );
  }

  // Safety net: when neither provider returns anything, the picker still
  // gets ONE row — the Search-Amazon fallback.
  {
    clearBrandSearchCache();
    const r = await searchBrands("ZZZ Totally Nonexistent Brand 999", "tight", noProvidersDeps);
    check(
      "e2e 25.2: safety net — unknown brand still yields 1 fallback candidate",
      r.candidates.length === 1 && r.candidates[0].source === "fallback",
      JSON.stringify(r.candidates),
    );
    check(
      "e2e 25.2: safety net candidate links to Amazon brand search",
      !!r.candidates[0].storefront_url && r.candidates[0].storefront_url.includes("amazon.com/s?k="),
      r.candidates[0].storefront_url ?? "(null)",
    );
  }

  // DFS-only path (Keepa offline) — DFS items with explicit brand still surface.
  {
    clearBrandSearchCache();
    const dfsOnlyDeps: SearchBrandsDeps = {
      isKeepaConfigured: () => false,
      isDataForSEOConfigured: () => true,
      dfs: async () => [
        { brand: CANONICAL, title: "Couple's Coffee Co. - 12oz" },
        { brand: CANONICAL, title: "Couple's Coffee Co. - 16oz" },
        { brand: "", title: "Couples coffee anything" }, // dropped: no explicit brand
      ],
    };
    const r = await searchBrands("Couples Coffee", "tight", dfsOnlyDeps);
    check(
      "e2e 25.2: DFS-only path uses explicit brand attr only",
      r.candidates.some((c) => c.source === "dataforseo" && c.name === CANONICAL),
      JSON.stringify(r.candidates.map((c) => ({ n: c.name, s: c.source }))),
    );
    check(
      "e2e 25.2: DFS items with empty brand are dropped (no title-derived echo)",
      !r.candidates.some((c) => c.name?.toLowerCase().includes("anything")),
      JSON.stringify(r.candidates.map((c) => c.name)),
    );
  }

  // Anti-echo: even when title heads are user query, candidate.name is canonical.
  {
    clearBrandSearchCache();
    const r = await searchBrands("Couples coffee", "tight", deps);
    check(
      "e2e 25.2: candidate.name is NEVER 'Couples coffee' (the user input)",
      r.candidates.every((c) => c.name !== "Couples coffee"),
      JSON.stringify(r.candidates.map((c) => c.name)),
    );
    check(
      "e2e 25.2: candidate.name is NEVER 'Couples Coffee' (the title-leading echo)",
      r.candidates.every((c) => c.name !== "Couples Coffee"),
      JSON.stringify(r.candidates.map((c) => c.name)),
    );
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(2);
});
