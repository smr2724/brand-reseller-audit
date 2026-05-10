/**
 * Phase 57 — Server-side pitch math computation.
 *
 * The narrative LLM previously emitted `pitch_math` JSON with a
 * `recoverable_share` of 65% and a free-text "industry-standard reclaim
 * is 60-70%" justification. That contradicted RCG's actual offer: every
 * reseller is removed in Phase 1, so the brand recovers 100% of the
 * reseller-controlled slice. The hedged framing is gone.
 *
 * This module is the single source of truth for the `pitch_math` JSONB
 * column on `brand_qualifications`. It reads canonical inputs (TTM
 * revenue + reseller-controlled share) and projects them through the
 * canonical economics functions (`computeLegionEconomics` for
 * opportunity-mode brands, `computeBenchmarkEconomics` for tight-mode
 * Segment 2 brands) plus the canonical margin constants exported by
 * `LEGION_DEFAULTS`. No new constants are introduced here — every number
 * traces back to `legion-economics.ts`.
 */
import {
  LEGION_DEFAULTS,
  computeBenchmarkEconomics,
  computeLegionEconomics,
  defaultLegionInputs,
} from "@/lib/math/legion-economics";
import type { PitchMath } from "./types";
import type { Segment } from "./segments";

export interface PitchMathInput {
  /** Trailing-12-month Amazon revenue in USD. Must be > 0; callers pass null when sizing failed. */
  ttm_revenue_usd: number | null;
  /** 0..1 share of buy box currently controlled by resellers (unauthorized) for opportunity-mode brands,
   *  or 0..1 share controlled by authorized distributors for tight-mode (Segment 2) brands. */
  reseller_controlled_share: number;
  /** Final segment from `computeSegment`. Drives function selection (opportunity vs tight). */
  segment: Segment;
}

/**
 * Compute the canonical `pitch_math` for a qualified brand. Returns null
 * for disqualified segments, brands without sizing, or zero/negative
 * shares (the math has nothing to say). The LLM never touches this — it
 * is invoked at qualification time, persisted alongside the narrative,
 * and re-applied via the Phase 57 backfill for historical rows.
 */
export function computePitchMath(input: PitchMathInput): PitchMath | null {
  const revenue = Number(input.ttm_revenue_usd);
  if (!Number.isFinite(revenue) || revenue <= 0) return null;

  // Segment 2 (`authorized_network_healthy`) flows through the benchmark
  // function because the recapture-from-resellers story does not apply
  // cleanly to an authorized network. Every other qualified segment uses
  // the full opportunity economics. Disqualified segments don't produce
  // pitch math at all.
  const isTight = input.segment === "authorized_network_healthy";
  const isOpportunity =
    input.segment === "reseller_controlled" ||
    input.segment === "mixed_control" ||
    input.segment === "brand_managed_with_leakage";
  if (!isTight && !isOpportunity) return null;

  const share = clamp01(input.reseller_controlled_share);
  const resellerControlledRevenue = revenue * share;

  // Canonical margin constants — sourced from LEGION_DEFAULTS so the
  // pitch math can never drift from the rest of the report.
  const currentMargin = LEGION_DEFAULTS.reseller_net_margin_pct; // 0.105
  const postMargin = LEGION_DEFAULTS.current_profit_margin_pct; // 0.20

  // Per the Phase 57 spec, current/post profit are projected from TTM
  // revenue (not from the recoverable slice) so the "profit doubled"
  // headline lines up with the Diversified Hospitality case study copy.
  // The wholesale-leg internals of computeLegionEconomics still feed
  // exit_lift below.
  const currentAnnualProfit = revenue * currentMargin;
  const postCaptureAnnualProfit = revenue * postMargin;
  const deltaProfit = postCaptureAnnualProfit - currentAnnualProfit;

  let exitLift: number;
  let source: PitchMath["source"];
  if (isTight) {
    const benchmark = computeBenchmarkEconomics({
      revenue,
      current_profit_margin_pct: postMargin,
      ebitda_multiple: LEGION_DEFAULTS.ebitda_multiple,
    });
    exitLift = benchmark.business_value;
    source = "computeBenchmarkEconomics";
  } else {
    // Phase 27 — `brand_controlled_pct` in computeLegionEconomics is
    // "the slice NOT recoverable". For an opportunity-mode brand, the
    // share of revenue going to resellers IS the recoverable slice, so
    // brand_controlled_pct = 1 − reseller_controlled_share.
    const legion = computeLegionEconomics({
      ...defaultLegionInputs(revenue),
      brand_controlled_pct: 1 - share,
    });
    exitLift = legion.exit_lift;
    source = "computeLegionEconomics";
  }

  return {
    ttm_revenue_usd: round(revenue),
    reseller_controlled_share: round4(share),
    reseller_controlled_revenue_usd: round(resellerControlledRevenue),
    recoverable_revenue_usd: round(resellerControlledRevenue),
    current_profit_margin: currentMargin,
    post_capture_profit_margin: postMargin,
    current_annual_profit_usd: round(currentAnnualProfit),
    post_capture_annual_profit_usd: round(postCaptureAnnualProfit),
    delta_profit_usd: round(deltaProfit),
    exit_lift_usd: round(exitLift),
    source,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function round(n: number): number {
  return Math.round(n);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
