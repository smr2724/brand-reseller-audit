/**
 * Phase 25 — Unit tests for the variant generator + similarity ranker.
 * Phase 25.1 — Adds coverage for suffix-ADD, ALL-CAPS, and singular
 * non-possessive forms (the production bug was that none of these were
 * generated, so Keepa's strict-equality /query never matched
 * "COUPLE'S COFFEE CO.").
 *
 * Run with `npx tsx scripts/test-brand-variants.ts`.
 */
import { tightVariants, looseVariants, normalizeQuery } from "../src/lib/brand-search/variants";
import { similarity } from "../src/lib/brand-search/similarity";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} :: ${name}${detail ? " :: " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

function lowerSet(arr: string[]): Set<string> {
  return new Set(arr.map((s) => s.toLowerCase()));
}

// Variant generator
{
  const v = tightVariants("Couples Coffee");
  const set = lowerSet(v);
  check("tight: contains original", set.has("couples coffee"));
  check(
    "tight: contains apostrophe-singular variant Couple's Coffee",
    set.has("couple's coffee"),
    JSON.stringify(v),
  );
  check(
    "tight: contains plural→singular Couple Coffee",
    set.has("couple coffee"),
    JSON.stringify(v),
  );
  check("tight: cap at <=16 entries", v.length <= 16, `len=${v.length}`);
}

{
  const v = tightVariants("Acme LLC");
  const set = lowerSet(v);
  check(
    "tight: strips LLC suffix",
    set.has("acme"),
    JSON.stringify(v),
  );
}

{
  const v = tightVariants("Acme Inc.");
  const set = lowerSet(v);
  check("tight: strips Inc. suffix", set.has("acme"), JSON.stringify(v));
}

{
  const v = tightVariants("Couple's Coffee");
  const set = lowerSet(v);
  check(
    "tight: apostrophe → no-apostrophe (Couples)",
    set.has("couples coffee") || set.has("couple s coffee"),
    JSON.stringify(v),
  );
}

{
  const v = tightVariants("World Amenities");
  const set = lowerSet(v);
  check(
    "tight: plural → singular (Amenity)",
    set.has("world amenity"),
    JSON.stringify(v),
  );
}

// Phase 25.1 — suffix-ADD variants
{
  const v = tightVariants("Couple's Coffee");
  const set = lowerSet(v);
  check(
    "tight 25.1: adds 'Co.' suffix variant",
    set.has("couple's coffee co."),
    JSON.stringify(v),
  );
  check(
    "tight 25.1: adds 'Company' suffix variant",
    set.has("couple's coffee company"),
    JSON.stringify(v),
  );
}

{
  const v = tightVariants("Couples Coffee");
  const set = lowerSet(v);
  check(
    "tight 25.1: Couples Coffee adds 'Co.' (Couples Coffee Co.)",
    set.has("couples coffee co."),
    JSON.stringify(v),
  );
}

// Phase 25.1 — does NOT add suffix when one already present
{
  const v = tightVariants("Couples Coffee Co.");
  const set = lowerSet(v);
  check(
    "tight 25.1: does not double-add suffix when already present",
    !v.some((s) => /co\.?\s+co\.?$/i.test(s)),
    JSON.stringify(v),
  );
}

// Phase 25.1 — ALL-CAPS variants for Keepa's strict-equality brand filter
{
  const v = tightVariants("Couple's Coffee");
  check(
    "tight 25.1: includes ALL-CAPS variant",
    v.includes("COUPLE'S COFFEE"),
    JSON.stringify(v),
  );
  check(
    "tight 25.1: includes ALL-CAPS + CO. variant (Amazon storefront form)",
    v.includes("COUPLE'S COFFEE CO."),
    JSON.stringify(v),
  );
}

// Phase 25.1 — Couple → Couples (singular base)
{
  const v = tightVariants("Couple Coffee");
  const set = lowerSet(v);
  check(
    "tight 25.1: singular base Couple → plural Couples Coffee",
    set.has("couples coffee"),
    JSON.stringify(v),
  );
}

{
  const v = looseVariants("The Couples Coffee Roasters");
  const set = lowerSet(v);
  check(
    "loose: drops trailing token (Couples Coffee)",
    set.has("the couples coffee"),
    JSON.stringify(v),
  );
  check(
    "loose: drops leading 'The' (Couples Coffee Roasters)",
    set.has("couples coffee roasters"),
    JSON.stringify(v),
  );
}

{
  const v = looseVariants("Yeti");
  // even single-word should at least include the original
  check("loose: handles single token", v.includes("Yeti"));
}

// Normalization
check("normalize: collapses whitespace", normalizeQuery("  Yeti   Cooler ") === "yeti cooler");
check(
  "normalize: lowercases + smart-quote folding",
  normalizeQuery("Couple’s Coffee") === "couple's coffee",
);

// Similarity
check("similarity: identical → 1", similarity("Couples Coffee", "Couples Coffee") === 1);
check(
  "similarity: apostrophe diff → high (>=0.85)",
  similarity("Couples Coffee", "Couple's Coffee") >= 0.85,
  similarity("Couples Coffee", "Couple's Coffee").toFixed(3),
);
check(
  "similarity: token-overlap (Couples Coffee vs Couple's Coffee Co.)",
  similarity("Couples Coffee", "Couple's Coffee Co.") >= 0.7,
  similarity("Couples Coffee", "Couple's Coffee Co.").toFixed(3),
);
check(
  "similarity: unrelated → low (<0.3)",
  similarity("Couples Coffee", "Yeti") < 0.3,
  similarity("Couples Coffee", "Yeti").toFixed(3),
);
check(
  "similarity: substring boost (Yeti vs Yeti Coolers)",
  similarity("Yeti", "Yeti Coolers") >= 0.75,
  similarity("Yeti", "Yeti Coolers").toFixed(3),
);

// Phase 25.1 — case-insensitive similarity
check(
  "similarity 25.1: case-insensitive (Couple's Coffee vs COUPLE'S COFFEE CO.)",
  similarity("Couple's Coffee", "COUPLE'S COFFEE CO.") >= 0.7,
  similarity("Couple's Coffee", "COUPLE'S COFFEE CO.").toFixed(3),
);

// Ranking sanity: Couple's Coffee should outrank a random brand
{
  const target = "Couples Coffee";
  const candidates = [
    "Couple's Coffee",
    "Couple's Coffee Co.",
    "Coffee Couple Roasters",
    "Yeti",
    "Starbucks",
  ];
  const ranked = candidates
    .map((c) => ({ c, s: similarity(target, c) }))
    .sort((a, b) => b.s - a.s);
  check(
    "ranker: Couple's Coffee outranks unrelated brands",
    ranked[0].c.toLowerCase().startsWith("couple's coffee"),
    JSON.stringify(ranked),
  );
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
