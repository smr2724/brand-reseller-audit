/**
 * Phase 80 — Classify a brand's economics_status when delta_profit is
 * non-positive, and clamp the headline dollar columns.
 *
 * Thresholds:
 *   - LOW_REVENUE_ANNUAL_FLOOR = $200,000. Below this, even at full recovery
 *     the recovered margin can't clear the under-$2M labor tier ($30K).
 *     Verified against Lemax (~$34K annual) / Sport-Tek (~$40K).
 *   - TIGHT_CHANNEL_PCT = 0.95. At or above this share of brand-controlled
 *     traffic, there's nothing meaningful left for resellers, so recapture
 *     math doesn't apply even at large absolute revenue.
 *
 * Tweak these in lock-step with the math in legion-economics.ts if the
 * tier breakpoints change.
 */
export type EconomicsStatus = "healthy" | "low_revenue" | "tight_channel";

export const LOW_REVENUE_ANNUAL_FLOOR = 200_000;
export const TIGHT_CHANNEL_PCT = 0.95;

export interface ClassifyInputs {
  delta_profit: number;
  /** Annual revenue dollars. */
  revenue: number;
  /** 0-1; null/missing treated as 0 (= legacy "all recoverable" behavior). */
  brand_controlled_pct: number | null;
}

export interface ClampedEconomics {
  status: EconomicsStatus;
  /** Clamped to 0 when delta_profit ≤ 0. */
  additional_profit: number;
  /** Clamped to 0 when delta_profit ≤ 0. */
  seven_x_multiple_value: number;
}

/**
 * Decide healthy vs low_revenue vs tight_channel.
 *
 * When both low-revenue AND tight-channel would apply we prefer
 * 'tight_channel' — the share of brand-controlled traffic is the tighter
 * signal (a brand pulling $50K with 99% buy-box wins is a tight-channel
 * brand more than a low-revenue brand).
 */
export function classifyEconomicsStatus(inputs: ClassifyInputs): EconomicsStatus {
  const delta = Number(inputs.delta_profit) || 0;
  if (delta > 0) return "healthy";
  const bc = inputs.brand_controlled_pct;
  const bcNum =
    bc == null || !Number.isFinite(Number(bc)) ? 0 : Math.max(0, Math.min(1, Number(bc)));
  if (bcNum >= TIGHT_CHANNEL_PCT) return "tight_channel";
  const annualRevenue = Math.max(0, Number(inputs.revenue) || 0);
  if (annualRevenue < LOW_REVENUE_ANNUAL_FLOOR) return "low_revenue";
  // Default fallback when neither rule fires but delta_profit is still ≤ 0.
  return "low_revenue";
}

/**
 * Clamp + classify in a single call. Healthy brands flow through with their
 * positive numbers preserved; non-positive deltas get zeroed and tagged.
 */
export function clampAndClassifyEconomics(
  inputs: ClassifyInputs & { exit_lift: number },
): ClampedEconomics {
  const status = classifyEconomicsStatus(inputs);
  if (status === "healthy") {
    return {
      status,
      additional_profit: Number(inputs.delta_profit) || 0,
      seven_x_multiple_value: Number(inputs.exit_lift) || 0,
    };
  }
  return {
    status,
    additional_profit: 0,
    seven_x_multiple_value: 0,
  };
}
