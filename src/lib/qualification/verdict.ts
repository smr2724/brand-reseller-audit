/**
 * Phase 71 — Effective qualification verdict, post-override.
 *
 * `manual_override=true` is "Override → Pursue" — Steve has reviewed the
 * brand and is overriding a `disqualified` / `needs_review` verdict back
 * to qualified. The override is set on `brand_qualifications` via the
 * /qualification/override route.
 *
 * Pre-Phase-71 bug: downstream callers (Contact Strategy button + API,
 * Contact Discovery button + API) were reading raw `icp_verdict` and
 * raw `hard_gate_verdict` directly. With override active, the brand was
 * still gated out of contact flows because the raw fields were never
 * rewritten — only the `manual_override` flag was. This helper is the
 * single point of truth callers must use instead.
 *
 * The Phase 69 server-side hard-gate-bypass check still applies: the
 * server only allows contact discovery / strategy when the EFFECTIVE
 * hard_gate_verdict is 'pass'. Raw 'qualified' icp_verdict alone is not
 * enough — override is the only way to bypass a 'hard_disqualify' or
 * 'needs_review' hard gate.
 */

export interface EffectiveVerdictInput {
  icp_verdict: "qualified" | "disqualified" | "needs_review" | null | undefined;
  hard_gate_verdict: "pass" | "hard_disqualify" | "needs_review" | null | undefined;
  manual_override: boolean | null | undefined;
}

export interface EffectiveVerdict {
  icp_verdict: "qualified" | "disqualified" | "needs_review";
  hard_gate_verdict: "pass" | "hard_disqualify" | "needs_review";
  source: "raw" | "manual_override";
}

/**
 * Returns the effective verdict that callers should reason about.
 *
 * - `manual_override=true` forces qualified + pass with source='manual_override'.
 * - Otherwise the raw fields pass through, defaulting nullish raw values
 *   to needs_review (safer than silently treating null as disqualified).
 */
export function effectiveVerdict(q: EffectiveVerdictInput): EffectiveVerdict {
  if (q.manual_override === true) {
    return {
      icp_verdict: "qualified",
      hard_gate_verdict: "pass",
      source: "manual_override",
    };
  }
  return {
    icp_verdict:
      q.icp_verdict === "qualified" ||
      q.icp_verdict === "disqualified" ||
      q.icp_verdict === "needs_review"
        ? q.icp_verdict
        : "needs_review",
    hard_gate_verdict:
      q.hard_gate_verdict === "pass" ||
      q.hard_gate_verdict === "hard_disqualify" ||
      q.hard_gate_verdict === "needs_review"
        ? q.hard_gate_verdict
        : "needs_review",
    source: "raw",
  };
}
