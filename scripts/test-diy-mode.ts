/**
 * Phase 24 — sanity test for the DIY-mode fit decision.
 *
 * The decision lives inside `assembleV2` (assemble.ts) but the helper is
 * not exported, so this test reproduces the logic and asserts the
 * expected mode + recoverable revenue for the canonical cases:
 *
 *   • Fantaswick — small total, brand owns ~70% → diy_fit
 *   • OXO / Yeti — big total even with reseller share → high_fit
 *   • Brand-controlled = null → high_fit (don't downgrade unknowns)
 *
 * Run with `npx tsx scripts/test-diy-mode.ts`.
 */

type Mode = "high_fit" | "diy_fit";
function decide(args: {
  trailing12: number | null;
  brandControlledPct: number | null;
  threshold?: number;
}): { mode: Mode; recoverable: number | null } {
  const t = args.threshold ?? 500_000;
  const { trailing12, brandControlledPct } = args;
  let recoverable: number | null = null;
  if (trailing12 != null && brandControlledPct != null) {
    const pct = Math.max(0, Math.min(1, brandControlledPct));
    recoverable = Math.max(0, trailing12 * (1 - pct));
  }
  const tightChannel =
    brandControlledPct != null && brandControlledPct >= 0.5;
  const lowRecoverable = recoverable != null && recoverable < t;
  const mode: Mode = tightChannel && lowRecoverable ? "diy_fit" : "high_fit";
  return { mode, recoverable };
}

interface Case {
  name: string;
  trailing12: number | null;
  brandControlledPct: number | null;
  expectMode: Mode;
}

const cases: Case[] = [
  {
    name: "Fantaswick — small candle brand, 70% brand-controlled",
    trailing12: 600_000, // tiny brand
    brandControlledPct: 0.7,
    expectMode: "diy_fit", // recoverable = 600k × 0.3 = 180k < 500k
  },
  {
    name: "Yeti — big brand, even at 70% brand-controlled, 30% leak >> $500k",
    trailing12: 80_000_000,
    brandControlledPct: 0.7,
    expectMode: "high_fit", // recoverable = 24M >> 500k
  },
  {
    name: "OXO — mid-size brand with reseller leak",
    trailing12: 12_000_000,
    brandControlledPct: 0.4, // less than 50% brand-controlled
    expectMode: "high_fit", // tightChannel=false → high_fit regardless
  },
  {
    name: "Tight-channel small brand at 95% — clearly diy",
    trailing12: 2_000_000,
    brandControlledPct: 0.95,
    expectMode: "diy_fit", // recoverable = 100k
  },
  {
    name: "Tight-channel mid brand at 85% — leak still > $500k",
    trailing12: 5_000_000,
    brandControlledPct: 0.85,
    expectMode: "high_fit", // recoverable = 750k
  },
  {
    name: "Unknown brand-controlled (null) — high_fit (don't downgrade unknowns)",
    trailing12: 1_000_000,
    brandControlledPct: null,
    expectMode: "high_fit",
  },
  {
    name: "Unknown revenue — high_fit",
    trailing12: null,
    brandControlledPct: 0.8,
    expectMode: "high_fit",
  },
  {
    name: "Boundary: recoverable exactly = $500k → high_fit (strict <)",
    trailing12: 1_000_000,
    brandControlledPct: 0.5,
    expectMode: "high_fit",
  },
  {
    name: "Boundary: recoverable just under $500k → diy_fit",
    trailing12: 999_999,
    brandControlledPct: 0.5,
    expectMode: "diy_fit",
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const got = decide({
    trailing12: c.trailing12,
    brandControlledPct: c.brandControlledPct,
  });
  const ok = got.mode === c.expectMode;
  console.log(
    `${ok ? "PASS" : "FAIL"} :: ${c.name} :: mode=${got.mode}, recoverable=${got.recoverable}`,
  );
  if (ok) pass++;
  else fail++;
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
