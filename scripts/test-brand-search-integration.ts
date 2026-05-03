/**
 * Phase 25 — Integration-style test for the fuzzy brand picker pipeline.
 * Phase 25.1 — Adds coverage for the safety-net fallback (when both
 * providers return zero, return a single Search-Amazon row), DFS
 * title-derived brand inference, and the alphanumeric dedupe key that
 * collapses "Couple's Coffee" + "COUPLE'S COFFEE CO." into one row.
 *
 * Run: npx tsx scripts/test-brand-search-integration.ts
 */
import { similarity } from "../src/lib/brand-search/similarity";
import { dedupeByBrand, dedupeKey, inferBrandFromTitle, fallbackCandidate } from "../src/lib/brand-search/search";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} :: ${name}${detail ? " :: " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

// Phase 25 baseline — Couple's Coffee outranks noise & dedupes Keepa+DFS.
{
  const QUERY = "Couples Coffee";
  const merged = dedupeByBrand([
    { name: "Couple's Coffee", source: "keepa", asin_count: 14, storefront_url: null, similarity: 0 },
    { name: "Couple's Coffee", source: "dataforseo", asin_count: 6, storefront_url: null, similarity: 0 },
    { name: "Starbucks", source: "dataforseo", asin_count: 2, storefront_url: null, similarity: 0 },
    { name: "Folgers", source: "dataforseo", asin_count: 1, storefront_url: null, similarity: 0 },
  ]);
  for (const c of merged) c.similarity = similarity(QUERY, c.name);
  merged.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    return (b.asin_count ?? 0) - (a.asin_count ?? 0);
  });

  check(
    "Couple's Coffee is the top candidate for 'Couples Coffee'",
    merged[0]?.name === "Couple's Coffee",
    JSON.stringify(merged.slice(0, 3)),
  );
  check(
    "Couple's Coffee dedupes Keepa+DFS into one row with source=both",
    merged.find((c) => c.name === "Couple's Coffee")?.source === "both",
  );
  check(
    "dedupe takes max ASIN count (14, not 6)",
    merged.find((c) => c.name === "Couple's Coffee")?.asin_count === 14,
  );
}

// Phase 25.1 — alphanumeric dedupe key collapses casing/punctuation
{
  const merged = dedupeByBrand([
    { name: "Couple's Coffee", source: "keepa", asin_count: 14, storefront_url: null, similarity: 0 },
    { name: "COUPLE'S COFFEE", source: "keepa", asin_count: 12, storefront_url: null, similarity: 0 },
  ]);
  check(
    "25.1 dedupe: 'Couple's Coffee' and 'COUPLE'S COFFEE' merge to one row",
    merged.length === 1,
    `len=${merged.length}: ${JSON.stringify(merged)}`,
  );
}

// Phase 25.1 — alphanumeric dedupe does NOT collapse different brands
{
  const merged = dedupeByBrand([
    { name: "Couples Coffee", source: "keepa", asin_count: 14, storefront_url: null, similarity: 0 },
    { name: "Couples Coffee Roasters", source: "dataforseo", asin_count: 5, storefront_url: null, similarity: 0 },
  ]);
  check(
    "25.1 dedupe: distinct brands stay separate",
    merged.length === 2,
    `len=${merged.length}: ${JSON.stringify(merged)}`,
  );
}

// Phase 25.1 — dedupeKey
check(
  "dedupeKey 25.1: collapses apostrophe + casing",
  dedupeKey("Couple's Coffee") === "couples coffee",
  `got '${dedupeKey("Couple's Coffee")}'`,
);
check(
  "dedupeKey 25.1: collapses 'COUPLE'S COFFEE CO.' to 'couples coffee co'",
  dedupeKey("COUPLE'S COFFEE CO.") === "couples coffee co",
  `got '${dedupeKey("COUPLE'S COFFEE CO.")}'`,
);
check(
  "dedupeKey 25.1: empty string gives empty",
  dedupeKey("") === "",
);

// Phase 25.1 — DFS title-derived brand
check(
  "inferBrandFromTitle 25.1: extracts brand head from comma-separated title",
  inferBrandFromTitle("Couple's Coffee Co. - 12oz Bag, Medium Roast") === "Couple's Coffee Co.",
  `got '${inferBrandFromTitle("Couple's Coffee Co. - 12oz Bag, Medium Roast")}'`,
);
check(
  "inferBrandFromTitle 25.1: caps at 4 leading tokens",
  (inferBrandFromTitle("One Two Three Four Five Six Seven") ?? "").split(/\s+/).length <= 4,
);
check(
  "inferBrandFromTitle 25.1: rejects empty/null",
  inferBrandFromTitle(undefined) === null,
);
check(
  "inferBrandFromTitle 25.1: rejects numbers-only head",
  inferBrandFromTitle("12345 — fancy product") === null,
);

// Phase 25.1 — Safety-net fallback candidate
{
  const fb = fallbackCandidate("Couple's Coffee");
  check(
    "fallback 25.1: source is 'fallback'",
    fb.source === "fallback",
  );
  check(
    "fallback 25.1: name matches original query",
    fb.name === "Couple's Coffee",
  );
  check(
    "fallback 25.1: storefront URL is Amazon brand search",
    !!fb.storefront_url && fb.storefront_url.includes("amazon.com/s?k=") && fb.storefront_url.includes("brands"),
    fb.storefront_url ?? "(null)",
  );
  check(
    "fallback 25.1: URL contains the original brand text (encoded)",
    !!fb.storefront_url && /Couple/.test(fb.storefront_url) && /Coffee/.test(fb.storefront_url),
    fb.storefront_url ?? "(null)",
  );
  check(
    "fallback 25.1: similarity is 1 (it's the literal user input)",
    fb.similarity === 1,
  );
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
