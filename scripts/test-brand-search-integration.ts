/**
 * Phase 25.2 — Integration-style test for the fuzzy brand picker pipeline.
 *
 * Phase 25.1 used to rely on `inferBrandFromTitle` (since removed) and on
 * variant strings being labelled as candidates. Both were the architectural
 * bug that surfaced as the picker echoing the user's query back in
 * production. After Phase 25.2, candidate.name only ever comes from an
 * external API response (Keepa /search canonical brand, or DFS explicit
 * `brand` attribute) — never from variant generation or title inference.
 *
 * Run: npx tsx scripts/test-brand-search-integration.ts
 */
import { similarity } from "../src/lib/brand-search/similarity";
import { dedupeByBrand, dedupeKey, fallbackCandidate } from "../src/lib/brand-search/search";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} :: ${name}${detail ? " :: " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

// Phase 25.2 — Couple's Coffee outranks noise & dedupes Keepa+DFS into "both".
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

// dedupe key collapses casing/punctuation
{
  const merged = dedupeByBrand([
    { name: "Couple's Coffee", source: "keepa", asin_count: 14, storefront_url: null, similarity: 0 },
    { name: "COUPLE'S COFFEE", source: "keepa", asin_count: 12, storefront_url: null, similarity: 0 },
  ]);
  check(
    "dedupe: 'Couple's Coffee' and 'COUPLE'S COFFEE' merge to one row",
    merged.length === 1,
    `len=${merged.length}: ${JSON.stringify(merged)}`,
  );
}

// dedupe does NOT collapse different brands
{
  const merged = dedupeByBrand([
    { name: "Couples Coffee", source: "keepa", asin_count: 14, storefront_url: null, similarity: 0 },
    { name: "Couples Coffee Roasters", source: "dataforseo", asin_count: 5, storefront_url: null, similarity: 0 },
  ]);
  check(
    "dedupe: distinct brands stay separate",
    merged.length === 2,
    `len=${merged.length}: ${JSON.stringify(merged)}`,
  );
}

// dedupeKey
check(
  "dedupeKey: collapses apostrophe + casing",
  dedupeKey("Couple's Coffee") === "couples coffee",
  `got '${dedupeKey("Couple's Coffee")}'`,
);
check(
  "dedupeKey: collapses 'COUPLE'S COFFEE CO.' to 'couples coffee co'",
  dedupeKey("COUPLE'S COFFEE CO.") === "couples coffee co",
  `got '${dedupeKey("COUPLE'S COFFEE CO.")}'`,
);
check(
  "dedupeKey: empty string gives empty",
  dedupeKey("") === "",
);

// Safety-net fallback candidate
{
  const fb = fallbackCandidate("Couple's Coffee");
  check(
    "fallback: source is 'fallback'",
    fb.source === "fallback",
  );
  check(
    "fallback: name matches original query",
    fb.name === "Couple's Coffee",
  );
  check(
    "fallback: storefront URL is Amazon brand search",
    !!fb.storefront_url && fb.storefront_url.includes("amazon.com/s?k=") && fb.storefront_url.includes("brands"),
    fb.storefront_url ?? "(null)",
  );
  check(
    "fallback: URL contains the original brand text (encoded)",
    !!fb.storefront_url && /Couple/.test(fb.storefront_url) && /Coffee/.test(fb.storefront_url),
    fb.storefront_url ?? "(null)",
  );
  check(
    "fallback: similarity is 1 (it's the literal user input)",
    fb.similarity === 1,
  );
  check(
    "fallback: low_confidence flag set so UI can de-emphasize",
    fb.low_confidence === true,
  );
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
