/**
 * Phase 25.1 — End-to-end picker test.
 *
 * Verifies that all three user-attempted inputs that came back EMPTY in
 * production now return at least one candidate, and that the safety-net
 * Search-Amazon fallback kicks in when both providers return zero.
 *
 * Uses the dependency-injection hooks on `searchBrands` to swap out the
 * Keepa + DFS providers without monkeypatching modules.
 *
 * Run: npx tsx scripts/test-brand-picker-e2e.ts
 */
import { searchBrands, clearBrandSearchCache, type SearchBrandsDeps } from "../src/lib/brand-search/search";

// Models the production failure: Keepa only returns ASINs for the literal
// uppercase + suffixed form. The user's casual input ("Couples Coffee",
// "Couple's Coffee") doesn't match Keepa's strict-equality brand filter.
const KEEPA_INDEX: Record<string, string[]> = {
  "COUPLE'S COFFEE CO.": ["B0AAAAAAAA", "B0BBBBBBBB", "B0CCCCCCCC"],
};

const DFS_BY_QUERY: Record<string, Array<{ title?: string; brand?: string }>> = {
  "Couple's Coffee": [
    { brand: "", title: "Couple's Coffee Co. - 12oz Whole Bean, Medium Roast" },
    { brand: "", title: "Couple's Coffee Co. - 16oz Ground" },
    { brand: "Starbucks", title: "Starbucks Pike Place" },
  ],
  "Couples coffee": [
    { brand: "", title: "Couple's Coffee Co. - 12oz Whole Bean, Medium Roast" },
  ],
  "Couples Coffee": [
    { brand: "", title: "Couple's Coffee Co. - Single Origin" },
  ],
  "COUPLE'S COFFEE CO.": [
    { brand: "", title: "Couple's Coffee Co. - Single Origin" },
  ],
};

const deps: SearchBrandsDeps = {
  isKeepaConfigured: () => true,
  isDataForSEOConfigured: () => true,
  keepa: async (brand: string) => {
    const asins = KEEPA_INDEX[brand] ?? [];
    return { asins, tokens_used: 1, tokens_left: 100 };
  },
  dfs: async (query: string) => DFS_BY_QUERY[query] ?? [],
};

const noProvidersDeps: SearchBrandsDeps = {
  isKeepaConfigured: () => true,
  isDataForSEOConfigured: () => true,
  keepa: async () => ({ asins: [], tokens_used: 1, tokens_left: 100 }),
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
  // Production bug: all 3 of these returned 0 candidates pre-25.1.
  for (const input of ["Couple's Coffee", "Couples Coffee", "Couples coffee"]) {
    clearBrandSearchCache();
    const r = await searchBrands(input, "tight", deps);
    check(
      `e2e 25.1: '${input}' returns ≥1 candidate`,
      r.candidates.length >= 1,
      `${r.candidates.length} candidates: ${JSON.stringify(r.candidates.map((c) => c.name))}`,
    );
    check(
      `e2e 25.1: '${input}' candidate is real (not just fallback)`,
      r.candidates.some((c) => c.source !== "fallback"),
      JSON.stringify(r.candidates.map((c) => ({ n: c.name, s: c.source }))),
    );
    const top = r.candidates[0];
    check(
      `e2e 25.1: '${input}' top candidate is the real brand (Couple's Coffee variant)`,
      /couple/i.test(top?.name ?? "") && /coffee/i.test(top?.name ?? ""),
      JSON.stringify(top),
    );
  }

  // Exact ALL-CAPS + CO. input should resolve via Keepa exact match.
  {
    clearBrandSearchCache();
    const r = await searchBrands("COUPLE'S COFFEE CO.", "tight", deps);
    check(
      "e2e 25.1: 'COUPLE'S COFFEE CO.' resolves via Keepa exact match",
      r.candidates.length >= 1 && r.candidates.some((c) => c.source !== "fallback"),
      JSON.stringify(r.candidates.slice(0, 3)),
    );
  }

  // Safety net: when neither provider returns anything, the picker still
  // gets ONE row — the Search-Amazon fallback.
  {
    clearBrandSearchCache();
    const r = await searchBrands("ZZZ Totally Nonexistent Brand 999", "tight", noProvidersDeps);
    check(
      "e2e 25.1: safety net — unknown brand still yields 1 fallback candidate",
      r.candidates.length === 1 && r.candidates[0].source === "fallback",
      JSON.stringify(r.candidates),
    );
    check(
      "e2e 25.1: safety net candidate links to Amazon brand search",
      !!r.candidates[0].storefront_url && r.candidates[0].storefront_url.includes("amazon.com/s?k="),
      r.candidates[0].storefront_url ?? "(null)",
    );
  }

  // DFS-only brands (no Keepa hits) should still appear
  {
    clearBrandSearchCache();
    const dfsOnlyDeps: SearchBrandsDeps = {
      isKeepaConfigured: () => true,
      isDataForSEOConfigured: () => true,
      keepa: async () => ({ asins: [], tokens_used: 1, tokens_left: 100 }),
      dfs: async () => [
        { brand: "", title: "Couple's Coffee Co. - 12oz" },
        { brand: "", title: "Couple's Coffee Co. - 16oz" },
      ],
    };
    const r = await searchBrands("Couples Coffee", "tight", dfsOnlyDeps);
    check(
      "e2e 25.1: DFS-only brands appear (no Keepa hits) — title-derived",
      r.candidates.some((c) => c.source === "dataforseo" && /couple/i.test(c.name)),
      JSON.stringify(r.candidates.map((c) => ({ n: c.name, s: c.source }))),
    );
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(2);
});
