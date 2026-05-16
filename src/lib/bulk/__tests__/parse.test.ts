/**
 * Phase 75 — parseBrandList tests.
 *
 * No test runner is installed; run directly via:
 *   npx tsx src/lib/bulk/__tests__/parse.test.ts
 */
import { parseBrandList } from "../parse";

let failures = 0;
let passes = 0;

function assert(label: string, cond: boolean): void {
  if (cond) {
    passes++;
  } else {
    failures++;
    console.error(`FAIL: ${label}`);
  }
}

function deepEqual<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// 1. Mixed delimiters across newlines, commas, semicolons, tabs.
{
  const out = parseBrandList("yeti, oxo\ncarna4;sport-tek\tworld amenities");
  assert(
    "mixed-delimiter input yields 5 brands",
    deepEqual(out, ["yeti", "oxo", "carna4", "sport-tek", "world amenities"]),
  );
}

// 2. Case-insensitive dedupe, first-seen casing preserved.
{
  const out = parseBrandList("YETI\nyeti\n yeti ");
  assert(
    "case-insensitive dedupe keeps first-seen casing",
    deepEqual(out, ["YETI"]),
  );
}

// 3. Empty / whitespace-only input returns [].
{
  assert("empty string → []", deepEqual(parseBrandList(""), []));
  assert("whitespace only → []", deepEqual(parseBrandList("   \n\t\n,;"), []));
}

// 4. Surrounding quotes are stripped (single + double).
{
  assert(
    'double-quoted brand stripped',
    deepEqual(parseBrandList('"Yeti"'), ["Yeti"]),
  );
  assert(
    "single-quoted brand stripped",
    deepEqual(parseBrandList("'Yeti'"), ["Yeti"]),
  );
  assert(
    "mixed quotes across brands",
    deepEqual(parseBrandList(`"Yeti", 'OXO', Carna4`), ["Yeti", "OXO", "Carna4"]),
  );
}

// 5. Multiple consecutive delimiters collapse cleanly.
{
  const out = parseBrandList("Yeti,,,OXO\n\n\nCarna4");
  assert(
    "consecutive delimiters collapse",
    deepEqual(out, ["Yeti", "OXO", "Carna4"]),
  );
}

// 6. Leading/trailing whitespace within entries trimmed.
{
  const out = parseBrandList("  Yeti  ,  OXO  ");
  assert(
    "trim per-brand whitespace",
    deepEqual(out, ["Yeti", "OXO"]),
  );
}

console.log(`parseBrandList: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
