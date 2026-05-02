/**
 * Unit test for filterRelevant — the canonical World Amenities case
 * from the brief.
 *
 * Run: npx tsx scripts/test-filter-relevant.ts
 */
import { filterRelevant, simpleStem } from "../src/lib/enrichment/dataforseo";

type R = { keyword: string; search_volume: number | null };

let passed = 0;
let failed = 0;
function expect(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${label}${detail ? "\n        " + detail : ""}`);
  }
}

// --- simpleStem sanity ---
console.log("simpleStem:");
expect("wipes -> wipe", simpleStem("wipes") === "wipe", `got "${simpleStem("wipes")}"`);
expect("remover -> remov", simpleStem("remover") === "remov", `got "${simpleStem("remover")}"`);
expect("cleansing -> cleans", simpleStem("cleansing") === "cleans", `got "${simpleStem("cleansing")}"`);
expect("foaming -> foam", simpleStem("foaming") === "foam", `got "${simpleStem("foaming")}"`);
expect("body -> body (no strip on short root)", simpleStem("body") === "body", `got "${simpleStem("body")}"`);
expect("washed -> wash", simpleStem("washed") === "wash", `got "${simpleStem("washed")}"`);

// --- canonical World Amenities case ---
console.log("\nfilterRelevant — World Amenities canonical case:");
// Brief's spec: seeds + "vocab = {body, lotion, hand, wash, makeup, wipes}
// plus other title tokens". For a brand whose ASIN titles include
// "Facial Cleansing Wipes", "Makeup Remover Wipes", "Travel Size Body
// Lotion", the title-vocab pulled upstream realistically contains
// facial/cleansing/remover/travel/size/foaming. We mirror that here.
const seeds = ["body lotion", "hand wash", "makeup wipes"];
const vocab = [
  "body", "lotion", "hand", "wash", "makeup", "wipes",
  "facial", "cleansing", "remover", "travel", "size", "foaming",
  "amenities",
];
const candidates: R[] = [
  { keyword: "world amenities", search_volume: 187 },           // brand row
  { keyword: "makeup remover wipes", search_volume: 40000 },    // makeup, remover (stem match), wipes → 3/3
  { keyword: "facial cleansing wipes", search_volume: 22000 },  // facial, cleansing, wipes → 3/3
  { keyword: "butcher paper", search_volume: 90000 },           // 0/2 — should drop
  { keyword: "travel size lotion", search_volume: 18000 },      // travel, size, lotion → 3/3
  { keyword: "foaming hand wash", search_volume: 50000 },       // foaming, hand, wash → 3/3
];

const out = filterRelevant(candidates, "World Amenities", seeds, vocab);
const kept = new Set(out.map((k) => k.keyword.toLowerCase()));
console.log("  kept:", out.map((k) => k.keyword));

expect("keeps world amenities (brand)", kept.has("world amenities"));
expect("keeps makeup remover wipes", kept.has("makeup remover wipes"));
expect("keeps facial cleansing wipes", kept.has("facial cleansing wipes"));
expect("keeps travel size lotion", kept.has("travel size lotion"));
expect("keeps foaming hand wash", kept.has("foaming hand wash"));
expect("drops butcher paper", !kept.has("butcher paper"));

// Stem rule with the brief's literal seed vocab and a wider candidate
// list — verify "butcher paper" drops without the safety floor
// kicking in (need ≥4 keepers from the relaxed pass).
console.log("\nfilterRelevant — stem rule alone with literal seed vocab:");
const literalVocab = ["body", "lotion", "hand", "wash", "makeup", "wipes"];
const wider: R[] = [
  { keyword: "world amenities", search_volume: 187 },
  { keyword: "makeup remover wipes", search_volume: 40000 }, // makeup, wipe → 2/3 ≥ 50%
  { keyword: "foaming hand wash", search_volume: 50000 },    // hand, wash → 2/3
  { keyword: "body wash", search_volume: 60000 },            // body, wash → 2/2
  { keyword: "hand soap", search_volume: 30000 },            // hand → 1/2 = 50% (kept)
  { keyword: "butcher paper", search_volume: 90000 },        // 0/2 → drop
  { keyword: "kraft paper roll", search_volume: 9000 },      // 0/3 → drop
];
const out2 = filterRelevant(wider, "World Amenities", seeds, literalVocab);
const kept2 = new Set(out2.map((k) => k.keyword.toLowerCase()));
console.log("  kept:", out2.map((k) => k.keyword));
expect("stem-only: keeps makeup remover wipes (2/3)", kept2.has("makeup remover wipes"));
expect("stem-only: keeps foaming hand wash (2/3)", kept2.has("foaming hand wash"));
expect("stem-only: drops butcher paper", !kept2.has("butcher paper"));
expect("stem-only: drops kraft paper roll", !kept2.has("kraft paper roll"));

// --- brand pinned at top ---
console.log("\nfilterRelevant — brand pinned at top:");
expect(
  "world amenities is first",
  out[0]?.keyword.toLowerCase() === "world amenities",
  `got first="${out[0]?.keyword}"`,
);

// --- safety floor ---
console.log("\nfilterRelevant — safety floor (relaxed yields too few, no substring hits):");
const sparseCandidates: R[] = [
  { keyword: "tiny brand", search_volume: 50 },
  { keyword: "kraft paper roll", search_volume: 9000 },
  { keyword: "butcher paper", search_volume: 90000 },
  { keyword: "wax paper sheets", search_volume: 6000 },
  { keyword: "freezer paper", search_volume: 4000 },
];
const sparseOut = filterRelevant(sparseCandidates, "Tiny Brand", ["body lotion"], ["body", "lotion"]);
console.log("  fallback kept:", sparseOut.map((k) => k.keyword));
expect("safety floor returns fallback (>=4 items)", sparseOut.length >= 4);
expect(
  "safety-floor pins brand match first",
  sparseOut[0]?.keyword.toLowerCase().includes("tiny brand"),
  `got first="${sparseOut[0]?.keyword}"`,
);

// --- substring pre-pass: a candidate that would FAIL the 50% stem
// rule but passes because a seed phrase is a substring ---
console.log("\nfilterRelevant — seed-substring pre-pass:");
const subCandidates: R[] = [
  { keyword: "world amenities", search_volume: 187 },
  // 4 tokens; only "body" + "lotion" would stem-match (50% on the
  // edge). The point is that the substring rule fires FIRST, before
  // the ratio is even computed, so it always wins.
  { keyword: "extreme weather sport body lotion", search_volume: 1200 },
  { keyword: "body lotion for women", search_volume: 5000 },     // substring hit
  { keyword: "moisturizing body lotion", search_volume: 8000 },  // substring hit
  { keyword: "hand wash refill", search_volume: 4000 },          // substring hit
  { keyword: "kraft paper roll", search_volume: 9000 },          // 0/3 → drop
  { keyword: "butcher paper", search_volume: 90000 },            // 0/2 → drop
];
const subOut = filterRelevant(
  subCandidates,
  "World Amenities",
  ["body lotion", "hand wash"],
  ["body", "lotion", "hand", "wash", "amenities"],
);
const subKept = new Set(subOut.map((k) => k.keyword.toLowerCase()));
console.log("  kept:", subOut.map((k) => k.keyword));
expect("substring pre-pass keeps 'extreme weather sport body lotion'", subKept.has("extreme weather sport body lotion"));
expect("substring pre-pass keeps 'hand wash refill'", subKept.has("hand wash refill"));
expect("substring pre-pass still drops 'butcher paper'", !subKept.has("butcher paper"));
expect("substring pre-pass still drops 'kraft paper roll'", !subKept.has("kraft paper roll"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
