/**
 * Phase 69 — size tier boundary tests.
 *
 * Run directly with tsx:
 *   npx tsx src/lib/contacts/__tests__/size-tier.test.ts
 */
import { classifyTier } from "../size-tier";

let failures = 0;
let passes = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passes += 1;
  } else {
    failures += 1;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// boundary tests per spec
check("9 employees → micro", classifyTier(9, null) === "micro");
check("10 employees → small", classifyTier(10, null) === "small");
check("49 employees → small", classifyTier(49, null) === "small");
check("50 employees → mid", classifyTier(50, null) === "mid");
check("499 employees → mid", classifyTier(499, null) === "mid");
check("500 employees → enterprise", classifyTier(500, null) === "enterprise");
check("null employees → micro (defensive)", classifyTier(null, null) === "micro");
check("0 employees → micro", classifyTier(0, null) === "micro");

console.log(`\nsize-tier.test.ts: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
