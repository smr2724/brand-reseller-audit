/**
 * Phase 68 — Hard-gate evaluator regression tests.
 *
 * No test runner is installed; run directly via:
 *   npx tsx src/lib/qualification/__tests__/hard-gates.test.ts
 *
 * Covers:
 *   1. Pure-math Gate B unit cases (pass / below-threshold / null parent revenue).
 *   2. Normalizer widening from migration 0050 — the 6 new patterns
 *      round-trip without being clamped to 'other'.
 *   3. Sequential evaluator with stubbed prescreen/gate-a/gate-c/rejection
 *      against the seven canonical brand fixtures.
 */
import { computeRevenueRatio, GATE_B_THRESHOLD } from "../gate-b";
import { normalizeDisqualificationPattern } from "../normalize";
import {
  runHardGates,
  type HardGateDeps,
} from "../hard-gates";
import { SEVEN_BRAND_FIXTURES } from "./seven-brand-fixtures";
import type { PrescreenResult } from "../prescreen";
import type { GateCResult } from "../gate-c";
import type { RejectionSimResult } from "../rejection-sim";

let failures = 0;
let passes = 0;

function assert(label: string, cond: boolean, extra?: string): void {
  if (cond) {
    passes++;
  } else {
    failures++;
    console.error(`FAIL: ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

// ---- Gate B math --------------------------------------------------------

{
  const r = computeRevenueRatio(250_000, 3_000_000);
  assert(
    "Gate B passes when 8.3% > 2%",
    r.passed === true && r.verdict === "pass" && Math.abs((r.ratio ?? 0) - 0.0833) < 0.001,
  );
}
{
  const r = computeRevenueRatio(100_000, 7_700_000_000);
  assert(
    "Gate B fails Realspace case (~0.0013%)",
    r.passed === false &&
      r.verdict === "hard_disqualify" &&
      r.pattern === "parent_revenue_ratio_below_threshold",
  );
}
{
  const r = computeRevenueRatio(50_000, null);
  assert(
    "Gate B → needs_review when controlling revenue null",
    r.verdict === "needs_review" && r.ratio === null,
  );
}
{
  const r = computeRevenueRatio(0, 1_000_000);
  assert(
    "Gate B → hard_disqualify when recoverable is zero",
    r.verdict === "hard_disqualify" && r.pattern === "parent_revenue_ratio_below_threshold",
  );
}
{
  assert(
    "GATE_B_THRESHOLD is 0.02 (2%) per spec",
    GATE_B_THRESHOLD === 0.02,
  );
}

// ---- Normalizer widening -------------------------------------------------

const NEW_PATTERNS = [
  "subsidiary_of_public",
  "pe_portfolio_large",
  "parent_revenue_ratio_below_threshold",
  "no_named_decision_maker",
  "buyer_rejection_wins",
  "holding_naming_signal_review",
];
for (const p of NEW_PATTERNS) {
  const r = normalizeDisqualificationPattern(p);
  assert(
    `normalize: ${p} passes through unclamped`,
    r.value === p && r.originalIfClamped === null,
  );
}

// ---- Seven-brand integration --------------------------------------------

function buildStubs(fx: typeof SEVEN_BRAND_FIXTURES[number]): HardGateDeps {
  return {
    async runPatternPrescreen() {
      return {
        hit: fx.prescreen_stub,
        llm: null,
        error: null,
      } as PrescreenResult;
    },
    async resolveCorporateHierarchy() {
      return fx.gate_a_stub;
    },
    async resolveNamedDecisionMaker(): Promise<GateCResult> {
      if (fx.gate_c_passed) {
        return {
          passed: true,
          person: {
            first_name: fx.gate_c_person_name?.split(" ")[0] ?? null,
            last_name:
              fx.gate_c_person_name?.split(" ").slice(1).join(" ") || null,
            full_name: fx.gate_c_person_name ?? null,
            title: "Owner",
            linkedin_url: null,
            evidence_sources: [],
          },
          personal_stake: {
            stake_type: "personal_equity",
            rationale: "Owner-operator, recoverable directly accretes to equity.",
          },
          search_trail: [],
          pattern: null,
          reason: "Named owner with personal equity stake.",
          cost_usd: 0.001,
        };
      }
      return {
        passed: false,
        person: null,
        personal_stake: null,
        search_trail: [
          "Checked LinkedIn: only job titles surfaced (Director of Private Label).",
        ],
        pattern: "no_named_decision_maker",
        reason: "No individual name identifiable for this controlling entity.",
        cost_usd: 0.001,
      };
    },
    async simulateBuyerRejection(): Promise<RejectionSimResult> {
      if (fx.rejection_verdict === "do_not_pursue") {
        return {
          rejection_lines: [
            "We already monitor resellers internally.",
            "$50K is below my approval threshold.",
            "Amazon Brand Registry handles this for free.",
          ],
          hook_strength: 3,
          rejection_strength: 8,
          verdict: "do_not_pursue",
          rationale: "Existing alternatives + sub-threshold dollars.",
          pattern: "buyer_rejection_wins",
          cost_usd: 0.001,
        };
      }
      return {
        rejection_lines: [
          "Tell me more about your recapture methodology.",
          "Can you share a case study?",
          "Send me a one-pager.",
        ],
        hook_strength: 8,
        rejection_strength: 3,
        verdict: "pursue_ok",
        rationale: "Owner-operator sees direct equity lift.",
        pattern: null,
        cost_usd: 0.001,
      };
    },
  };
}

async function runFixture(fx: typeof SEVEN_BRAND_FIXTURES[number]) {
  const stubs = buildStubs(fx);
  const result = await runHardGates(
    {
      brand_name: fx.brand,
      brand_description: fx.description ?? null,
      top_sellers: fx.top_sellers,
      recoverable_revenue_usd: fx.recoverable_revenue_usd,
      brand_revenue_usd: fx.brand_revenue_usd,
    },
    stubs,
  );

  assert(
    `[${fx.brand}] verdict = ${fx.expected_verdict}`,
    result.verdict === fx.expected_verdict,
    `got ${result.verdict} (failure_gate=${result.failure_gate}, pattern=${result.pattern})`,
  );

  if (fx.expected_failure_gate !== undefined) {
    assert(
      `[${fx.brand}] failure_gate = ${fx.expected_failure_gate}`,
      result.failure_gate === fx.expected_failure_gate,
      `got ${result.failure_gate}`,
    );
  }

  if (fx.expected_pattern) {
    assert(
      `[${fx.brand}] pattern = ${fx.expected_pattern}`,
      result.pattern === fx.expected_pattern,
      `got ${result.pattern}`,
    );
  }

  if (fx.expected_pattern_one_of) {
    assert(
      `[${fx.brand}] pattern ∈ {${fx.expected_pattern_one_of.join(",")}}`,
      result.pattern !== null && fx.expected_pattern_one_of.includes(result.pattern),
      `got ${result.pattern}`,
    );
  }
}

async function main() {
  for (const fx of SEVEN_BRAND_FIXTURES) {
    await runFixture(fx);
  }

  // Realspace specifically — the trigger case from the spec.
  const realspace = SEVEN_BRAND_FIXTURES.find((f) => f.brand === "Realspace")!;
  const realspaceResult = await runHardGates(
    {
      brand_name: realspace.brand,
      recoverable_revenue_usd: realspace.recoverable_revenue_usd,
      brand_revenue_usd: realspace.brand_revenue_usd,
      top_sellers: realspace.top_sellers,
    },
    buildStubs(realspace),
  );
  assert(
    "Realspace controlling entity ticker = ODP",
    realspaceResult.controlling_entity?.ticker === "ODP",
    `got ${realspaceResult.controlling_entity?.ticker}`,
  );
  assert(
    "Realspace hard_gate_verdict = hard_disqualify",
    realspaceResult.verdict === "hard_disqualify",
  );

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("test harness crashed:", e);
  process.exit(1);
});
