/**
 * Phase 68 — Sequential hard-gate evaluator.
 *
 * Runs the five stages in order and short-circuits on the first non-pass.
 * The orchestrator calls this AFTER the canonical economics are computed
 * (so `recoverable_revenue_usd` is sourced from computeLegionEconomics /
 * computeBenchmarkEconomics — not recomputed here).
 *
 * Stages:
 *   1. Pattern prescreen        (small LLM)
 *   2. Gate A — corporate hierarchy
 *   3. Gate B — parent revenue ratio (pure math)
 *   4. Gate C — named decision-maker
 *   5. Buyer rejection simulation
 *
 * Verdict mapping back to the persisted icp_verdict happens in orchestrate.ts:
 *   pass            → keep existing icp_verdict
 *   hard_disqualify → icp_verdict='disqualified'
 *   needs_review    → icp_verdict='needs_review'
 *
 * Pattern propagation: each failing gate emits the disqualification_pattern
 * string that best describes the failure (already in the widened enum
 * after migration 0050).
 */
import {
  runPatternPrescreen as defaultRunPatternPrescreen,
  type PrescreenInput,
  type PrescreenResult,
} from "./prescreen";
import {
  resolveCorporateHierarchy as defaultResolveCorporateHierarchy,
  type GateAResult,
  type ControllingEntity,
} from "./hierarchy";
import { computeRevenueRatio, type GateBResult } from "./gate-b";
import {
  resolveNamedDecisionMaker as defaultResolveNamedDecisionMaker,
  type GateCInput,
  type GateCResult,
} from "./gate-c";
import {
  simulateBuyerRejection as defaultSimulateBuyerRejection,
  type RejectionSimInput,
  type RejectionSimResult,
} from "./rejection-sim";

/**
 * Injectable dependencies — production callers pass nothing and get the
 * real network-bound implementations. Tests pass stubs so the seven
 * brand fixtures execute deterministically.
 */
export interface HardGateDeps {
  runPatternPrescreen: (input: PrescreenInput) => Promise<PrescreenResult>;
  resolveCorporateHierarchy: (input: {
    brand_name: string;
    brand_description?: string | null;
    top_sellers?: string[];
    brand_revenue_usd?: number | null;
  }) => Promise<GateAResult>;
  resolveNamedDecisionMaker: (input: GateCInput) => Promise<GateCResult>;
  simulateBuyerRejection: (input: RejectionSimInput) => Promise<RejectionSimResult>;
}

const PRODUCTION_DEPS: HardGateDeps = {
  runPatternPrescreen: defaultRunPatternPrescreen,
  resolveCorporateHierarchy: defaultResolveCorporateHierarchy,
  resolveNamedDecisionMaker: defaultResolveNamedDecisionMaker,
  simulateBuyerRejection: defaultSimulateBuyerRejection,
};

export type HardGateVerdict = "pass" | "hard_disqualify" | "needs_review";
export type HardGateFailureGate =
  | "pattern_prescreen"
  | "gate_a"
  | "gate_b"
  | "gate_c"
  | "rejection_sim";

export interface HardGateResult {
  verdict: HardGateVerdict;
  failure_gate: HardGateFailureGate | null;
  failure_reason: string | null;
  /** Maps to the widened disqualification_pattern column. Null on pass. */
  pattern: string | null;
  prescreen: PrescreenResult;
  gate_a: GateAResult | null;
  gate_b: GateBResult | null;
  gate_c: GateCResult | null;
  rejection: RejectionSimResult | null;
  controlling_entity: ControllingEntity | null;
  recoverable_to_controlling_ratio: number | null;
  /** All sources from Gate A's resolution chain. Mirrors the
   *  hierarchy_sources jsonb column. */
  hierarchy_sources: GateAResult["sources"] | null;
  /** Cumulative cost across the five stages. */
  total_cost_usd: number;
}

export interface HardGateInput {
  brand_name: string;
  brand_description?: string | null;
  top_sellers?: string[];
  industry_hint?: string | null;
  known_parent?: string | null;
  /** Canonical recoverable revenue from computeLegionEconomics output.
   *  DO NOT recompute — pass through. */
  recoverable_revenue_usd: number | null;
  /** Brand's own TTM revenue, for the unresolved-hierarchy big-entity check. */
  brand_revenue_usd?: number | null;
}

export async function runHardGates(
  input: HardGateInput,
  deps: HardGateDeps = PRODUCTION_DEPS,
): Promise<HardGateResult> {
  let totalCost = 0;

  // Stage 1 — pattern prescreen
  const prescreen = await deps.runPatternPrescreen({
    brand_name: input.brand_name,
    brand_description: input.brand_description ?? null,
    top_sellers: input.top_sellers,
    industry_hint: input.industry_hint ?? null,
    known_parent: input.known_parent ?? null,
  });
  totalCost += prescreen.llm?.cost_usd ?? 0;

  if (prescreen.hit?.verdict === "hard_disqualify") {
    return {
      verdict: "hard_disqualify",
      failure_gate: "pattern_prescreen",
      failure_reason: prescreen.hit.reason,
      pattern: prescreen.hit.pattern,
      prescreen,
      gate_a: null,
      gate_b: null,
      gate_c: null,
      rejection: null,
      controlling_entity: null,
      recoverable_to_controlling_ratio: null,
      hierarchy_sources: null,
      total_cost_usd: totalCost,
    };
  }

  // holding_naming_signal_review (needs_review) does NOT abort — it
  // proceeds to Gate A which is the actual arbiter. We retain the hit
  // so the UI can surface "extra Gate A scrutiny applied".

  // Stage 2 — Gate A
  const gateA = await deps.resolveCorporateHierarchy({
    brand_name: input.brand_name,
    brand_description: input.brand_description ?? null,
    top_sellers: input.top_sellers,
    brand_revenue_usd: input.brand_revenue_usd ?? null,
  });
  totalCost += gateA.cost_usd;

  if (gateA.verdict === "hard_disqualify") {
    return {
      verdict: "hard_disqualify",
      failure_gate: "gate_a",
      failure_reason: gateA.verdict_reason,
      pattern: gateA.pattern,
      prescreen,
      gate_a: gateA,
      gate_b: null,
      gate_c: null,
      rejection: null,
      controlling_entity: gateA.controlling_entity,
      recoverable_to_controlling_ratio: null,
      hierarchy_sources: gateA.sources,
      total_cost_usd: totalCost,
    };
  }
  if (gateA.verdict === "needs_review") {
    return {
      verdict: "needs_review",
      failure_gate: "gate_a",
      failure_reason: gateA.verdict_reason,
      pattern: gateA.pattern,
      prescreen,
      gate_a: gateA,
      gate_b: null,
      gate_c: null,
      rejection: null,
      controlling_entity: gateA.controlling_entity,
      recoverable_to_controlling_ratio: null,
      hierarchy_sources: gateA.sources,
      total_cost_usd: totalCost,
    };
  }

  const controlling = gateA.controlling_entity;
  if (!controlling) {
    // Defensive: Gate A passed but yielded no entity — escalate.
    return {
      verdict: "needs_review",
      failure_gate: "gate_a",
      failure_reason: "Gate A returned pass with no controlling entity resolved.",
      pattern: "other",
      prescreen,
      gate_a: gateA,
      gate_b: null,
      gate_c: null,
      rejection: null,
      controlling_entity: null,
      recoverable_to_controlling_ratio: null,
      hierarchy_sources: gateA.sources,
      total_cost_usd: totalCost,
    };
  }

  // Stage 3 — Gate B
  const gateB = computeRevenueRatio(
    input.recoverable_revenue_usd,
    controlling.revenue_usd,
  );

  if (gateB.verdict === "hard_disqualify") {
    return {
      verdict: "hard_disqualify",
      failure_gate: "gate_b",
      failure_reason: gateB.math_explanation,
      pattern: gateB.pattern,
      prescreen,
      gate_a: gateA,
      gate_b: gateB,
      gate_c: null,
      rejection: null,
      controlling_entity: controlling,
      recoverable_to_controlling_ratio: gateB.ratio,
      hierarchy_sources: gateA.sources,
      total_cost_usd: totalCost,
    };
  }
  if (gateB.verdict === "needs_review") {
    return {
      verdict: "needs_review",
      failure_gate: "gate_b",
      failure_reason: gateB.math_explanation,
      pattern: gateB.pattern,
      prescreen,
      gate_a: gateA,
      gate_b: gateB,
      gate_c: null,
      rejection: null,
      controlling_entity: controlling,
      recoverable_to_controlling_ratio: gateB.ratio,
      hierarchy_sources: gateA.sources,
      total_cost_usd: totalCost,
    };
  }

  // Stage 4 — Gate C
  const recoverable = input.recoverable_revenue_usd ?? 0;
  const gateC = await deps.resolveNamedDecisionMaker({
    brand_name: input.brand_name,
    controlling_entity: controlling,
    recoverable_revenue_usd: recoverable,
  });
  totalCost += gateC.cost_usd;

  if (!gateC.passed) {
    return {
      verdict: "hard_disqualify",
      failure_gate: "gate_c",
      failure_reason: gateC.reason,
      pattern: gateC.pattern,
      prescreen,
      gate_a: gateA,
      gate_b: gateB,
      gate_c: gateC,
      rejection: null,
      controlling_entity: controlling,
      recoverable_to_controlling_ratio: gateB.ratio,
      hierarchy_sources: gateA.sources,
      total_cost_usd: totalCost,
    };
  }

  // Stage 5 — rejection sim
  const rejection = await deps.simulateBuyerRejection({
    brand_name: input.brand_name,
    controlling_entity: controlling,
    named_person: gateC.person!,
    recoverable_revenue_usd: recoverable,
  });
  totalCost += rejection.cost_usd;

  if (rejection.verdict === "do_not_pursue") {
    return {
      verdict: "hard_disqualify",
      failure_gate: "rejection_sim",
      failure_reason: rejection.rationale,
      pattern: rejection.pattern,
      prescreen,
      gate_a: gateA,
      gate_b: gateB,
      gate_c: gateC,
      rejection,
      controlling_entity: controlling,
      recoverable_to_controlling_ratio: gateB.ratio,
      hierarchy_sources: gateA.sources,
      total_cost_usd: totalCost,
    };
  }

  // Pass.
  return {
    verdict: "pass",
    failure_gate: null,
    failure_reason: null,
    pattern: null,
    prescreen,
    gate_a: gateA,
    gate_b: gateB,
    gate_c: gateC,
    rejection,
    controlling_entity: controlling,
    recoverable_to_controlling_ratio: gateB.ratio,
    hierarchy_sources: gateA.sources,
    total_cost_usd: totalCost,
  };
}
