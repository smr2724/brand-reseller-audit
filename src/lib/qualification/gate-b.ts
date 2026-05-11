/**
 * Phase 68 — Gate B: parent revenue ratio.
 *
 * Pure math. recoverable_revenue_usd MUST come from the canonical
 * economics output (computeLegionEconomics or computeBenchmarkEconomics
 * via pitch-math). DO NOT recalculate here — the protected symbol rule
 * applies and the result must match the displayed pitch-math card.
 *
 * Threshold: 2% of controlling entity revenue. Below threshold ⇒
 * hard_disqualify with pattern `parent_revenue_ratio_below_threshold`.
 *
 * Edge case: when controlling_entity_revenue_usd is null (Gate A resolved
 * a private entity but couldn't size it), Gate B returns needs_review
 * rather than a numeric pass. The orchestrator surfaces "controlling
 * entity revenue unknown" in the UI for these cases.
 */

export type GateBVerdict = "pass" | "hard_disqualify" | "needs_review";

export interface GateBResult {
  passed: boolean;
  verdict: GateBVerdict;
  ratio: number | null;
  threshold: number;
  recoverable_revenue_usd: number | null;
  controlling_entity_revenue_usd: number | null;
  math_explanation: string;
  pattern: string | null;
}

export const GATE_B_THRESHOLD = 0.02;

export function computeRevenueRatio(
  recoverableRevenueUsd: number | null | undefined,
  controllingRevenueUsd: number | null | undefined,
): GateBResult {
  const recoverable =
    typeof recoverableRevenueUsd === "number" && Number.isFinite(recoverableRevenueUsd)
      ? recoverableRevenueUsd
      : null;
  const controlling =
    typeof controllingRevenueUsd === "number" && Number.isFinite(controllingRevenueUsd)
      ? controllingRevenueUsd
      : null;

  if (controlling == null) {
    return {
      passed: false,
      verdict: "needs_review",
      ratio: null,
      threshold: GATE_B_THRESHOLD,
      recoverable_revenue_usd: recoverable,
      controlling_entity_revenue_usd: null,
      math_explanation:
        "Controlling entity revenue is unknown; cannot compute ratio. Surface for human sizing before pursuing.",
      pattern: null,
    };
  }

  if (recoverable == null || recoverable <= 0) {
    return {
      passed: false,
      verdict: "hard_disqualify",
      ratio: 0,
      threshold: GATE_B_THRESHOLD,
      recoverable_revenue_usd: recoverable,
      controlling_entity_revenue_usd: controlling,
      math_explanation:
        "Recoverable revenue is zero or unknown — nothing to recapture relative to parent.",
      pattern: "parent_revenue_ratio_below_threshold",
    };
  }

  if (controlling <= 0) {
    // Defensive: a zero/negative controlling revenue cannot meaningfully
    // gate; treat as needs_review (Gate A misfire).
    return {
      passed: false,
      verdict: "needs_review",
      ratio: null,
      threshold: GATE_B_THRESHOLD,
      recoverable_revenue_usd: recoverable,
      controlling_entity_revenue_usd: controlling,
      math_explanation:
        "Controlling entity revenue resolved to a non-positive value; Gate A likely misfired.",
      pattern: null,
    };
  }

  const ratio = recoverable / controlling;
  const passed = ratio >= GATE_B_THRESHOLD;
  const ratioPct = (ratio * 100).toFixed(ratio < 0.001 ? 4 : 1);
  const explanation = `$${Math.round(recoverable).toLocaleString("en-US")} / $${Math.round(controlling).toLocaleString("en-US")} = ${ratioPct}% — ${passed ? "above" : "below"} ${GATE_B_THRESHOLD * 100}% threshold.`;

  return {
    passed,
    verdict: passed ? "pass" : "hard_disqualify",
    ratio,
    threshold: GATE_B_THRESHOLD,
    recoverable_revenue_usd: recoverable,
    controlling_entity_revenue_usd: controlling,
    math_explanation: explanation,
    pattern: passed ? null : "parent_revenue_ratio_below_threshold",
  };
}
