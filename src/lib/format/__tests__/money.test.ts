/**
 * Phase 76 — formatAdditionalProfit tests.
 *
 * No test runner is installed; run directly via:
 *   npx tsx src/lib/format/__tests__/money.test.ts
 */
import { formatAdditionalProfit } from "../money";

let failures = 0;
let passes = 0;

function assertEqual(label: string, got: string, want: string): void {
  if (got === want) {
    passes++;
  } else {
    failures++;
    console.error(`FAIL: ${label}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  }
}

assertEqual("203541.32869458137 rounds and groups", formatAdditionalProfit(203541.32869458137), "$203,541");
assertEqual("1424789.30 rounds and groups", formatAdditionalProfit(1424789.30), "$1,424,789");
assertEqual("0 renders as $0", formatAdditionalProfit(0), "$0");
assertEqual("null renders as $0", formatAdditionalProfit(null), "$0");
assertEqual("undefined renders as $0", formatAdditionalProfit(undefined), "$0");
assertEqual("NaN renders as $0", formatAdditionalProfit(NaN), "$0");
assertEqual("invalid string renders as $0", formatAdditionalProfit("invalid"), "$0");
assertEqual("1000 renders as $1,000", formatAdditionalProfit(1000), "$1,000");
assertEqual("999 renders as $999", formatAdditionalProfit(999), "$999");
assertEqual("numeric string parses", formatAdditionalProfit("203541.32"), "$203,541");

console.log(`\nformatAdditionalProfit: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
