/**
 * Phase 68 — Buyer rejection simulation.
 *
 * Last gate before pass. Asks the LLM to ROLE-PLAY as the named decision
 * maker and produce their most likely three-sentence rejection of the
 * RCG outbound pitch, plus self-scored hook strength + rejection
 * strength.
 *
 * If rejection_strength > hook_strength → verdict 'do_not_pursue'
 * (translates to hard_disqualify with pattern `buyer_rejection_wins`).
 *
 * Budget: ~$0.02/brand on gpt-4o-mini (the role-play is structurally
 * simple; the small model handles it fine and saves ~$0.08/brand vs the
 * main model).
 */
import {
  callQualificationLlm,
  QUALIFICATION_SMALL_MODEL,
  type LlmCallResult,
} from "./llm";
import type { ControllingEntity } from "./hierarchy";
import type { GateCPerson } from "./gate-c";

export type RejectionVerdict = "pursue_ok" | "do_not_pursue";
export type RejectionSeverity = "low" | "medium" | "high";

export interface RejectionSimResult {
  rejection_lines: string[];
  hook_strength: number;
  rejection_strength: number;
  verdict: RejectionVerdict;
  rationale: string;
  pattern: string | null;
  /**
   * Phase 71 — advisory severity for UI coloring. Computed from
   * (hook_strength, rejection_strength):
   *   high   → rejection_strength >= 7 AND hook_strength <= rejection_strength - 2
   *   medium → rejection_strength >= 5 AND hook_strength < rejection_strength
   *   low    → otherwise (deemphasize)
   */
  severity: RejectionSeverity;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
}

/**
 * Phase 71 — compute the advisory severity bucket for UI coloring.
 */
export function computeRejectionSeverity(
  hook_strength: number,
  rejection_strength: number,
): RejectionSeverity {
  if (rejection_strength >= 7 && hook_strength <= rejection_strength - 2) {
    return "high";
  }
  if (rejection_strength >= 5 && hook_strength < rejection_strength) {
    return "medium";
  }
  return "low";
}

export interface RejectionSimInput {
  brand_name: string;
  controlling_entity: ControllingEntity;
  named_person: GateCPerson;
  recoverable_revenue_usd: number;
}

export async function simulateBuyerRejection(
  input: RejectionSimInput,
): Promise<RejectionSimResult> {
  const personFullName =
    input.named_person.full_name ||
    [input.named_person.first_name, input.named_person.last_name]
      .filter(Boolean)
      .join(" ") ||
    "(unnamed)";
  const personTitle = input.named_person.title ?? "(unknown title)";
  const recoverable = Math.round(input.recoverable_revenue_usd);

  const user = [
    `You are ${personFullName} (${personTitle} at ${input.controlling_entity.name}). You just received an outbound LinkedIn message from a consultant pitching:`,
    "",
    `  "We help brands recover $${recoverable.toLocaleString("en-US")} in margin currently lost to unauthorized Amazon resellers. Engagement starts at $50K."`,
    "",
    "Write your most likely THREE-SENTENCE rejection of this pitch. Be honest about your real objections: existing tools you already use, approval thresholds you face, internal alternatives, time pressure, skepticism about ROI claims.",
    "",
    "Then weigh:",
    "  - Proposed hook strength (1-10): how compelling is the recapture pitch to YOU specifically?",
    "  - Rejection strength (1-10): how credible is YOUR rejection?",
    "  - If rejection_strength > hook_strength, your verdict is 'do_not_pursue'. Otherwise 'pursue_ok'.",
    "",
    "Context for your self-assessment:",
    `  - Controlling entity revenue: ${
      input.controlling_entity.revenue_usd != null
        ? `$${Math.round(input.controlling_entity.revenue_usd).toLocaleString("en-US")}`
        : "unknown"
    }`,
    `  - Controlling entity employees: ${input.controlling_entity.employees ?? "unknown"}`,
    `  - Your ownership relationship: ${input.controlling_entity.ownership_type}`,
  ].join("\n");

  let llm: LlmCallResult;
  try {
    llm = await callQualificationLlm({
      model: QUALIFICATION_SMALL_MODEL,
      system: REJECTION_SIM_SYSTEM_PROMPT,
      user,
      maxTokens: 900,
      temperature: 0.4,
    });
  } catch (e) {
    return {
      rejection_lines: [
        `Rejection simulation failed: ${e instanceof Error ? e.message : String(e)}`,
      ],
      hook_strength: 0,
      rejection_strength: 10,
      verdict: "do_not_pursue",
      rationale: "LLM call failed; defaulted to do_not_pursue for safety.",
      pattern: "buyer_rejection_wins",
      severity: computeRejectionSeverity(0, 10),
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
    };
  }

  const parsed = (llm.parsed ?? {}) as Partial<RejectionJson>;
  const lines = Array.isArray(parsed.rejection_lines)
    ? parsed.rejection_lines
        .map((s) => String(s).trim())
        .filter((s) => s.length > 0)
        .slice(0, 3)
    : [];
  const hook = clamp10(parsed.hook_strength);
  const rejection = clamp10(parsed.rejection_strength);
  // Spec rule: rejection_strength > hook_strength → do_not_pursue.
  const llmVerdict = String(parsed.verdict ?? "").toLowerCase().trim();
  const verdict: RejectionVerdict =
    llmVerdict === "do_not_pursue" || llmVerdict === "pursue_ok"
      ? (llmVerdict as RejectionVerdict)
      : rejection > hook
        ? "do_not_pursue"
        : "pursue_ok";

  // Defense in depth: enforce the deterministic rule even if the LLM
  // emitted the wrong verdict for its own scores.
  const finalVerdict: RejectionVerdict =
    rejection > hook ? "do_not_pursue" : verdict;

  return {
    rejection_lines: lines,
    hook_strength: hook,
    rejection_strength: rejection,
    verdict: finalVerdict,
    rationale: String(parsed.rationale ?? "").slice(0, 800),
    // Phase 71 — pattern is preserved for backfill compatibility (widened
    // enum still accepts 'buyer_rejection_wins') but the hard-gates
    // evaluator no longer propagates it when Gate A/B/C all passed.
    pattern: finalVerdict === "do_not_pursue" ? "buyer_rejection_wins" : null,
    severity: computeRejectionSeverity(hook, rejection),
    cost_usd: llm.cost_usd,
    tokens_in: llm.tokens_in,
    tokens_out: llm.tokens_out,
  };
}

interface RejectionJson {
  rejection_lines: string[];
  hook_strength: number | string;
  rejection_strength: number | string;
  verdict: string;
  rationale: string;
}

function clamp10(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, Math.round(n)));
}

const REJECTION_SIM_SYSTEM_PROMPT = `You are role-playing as a specific brand decision-maker on the receiving end of an outbound consulting pitch. Be honest about real-world objections: incumbent tools, approval thresholds, internal alternatives, ROI skepticism. Do NOT default to polite generic rejections — channel the actual buyer.

Output STRICTLY this JSON schema (no markdown, no prose):

{
  "rejection_lines": [
    "<sentence 1>",
    "<sentence 2>",
    "<sentence 3>"
  ],
  "hook_strength": <integer 1-10>,
  "rejection_strength": <integer 1-10>,
  "verdict": "<pursue_ok | do_not_pursue>",
  "rationale": "<one short paragraph weighing your hook vs your rejection>"
}

Rules:
  - Exactly three rejection sentences.
  - Scores are integers 1-10.
  - If rejection_strength > hook_strength, verdict MUST be 'do_not_pursue'.
  - Otherwise verdict is 'pursue_ok'.
  - Stay in character as the named decision-maker — not as a generic skeptic.`;
