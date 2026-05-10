/**
 * Phase 56 — Deterministic ICP segmentation.
 *
 * The full segment matrix the qualification LLM kept getting wrong. This
 * is the source of truth: prompts hint, math decides. Disqualifiers are
 * applied first in priority order; only if none match do we segment into
 * one of the four qualified buckets.
 *
 * RCG sells channel control. The MORE resellers a brand has, the BETTER
 * the fit. 0% brand-controlled is the ideal customer, not a
 * disqualifier — see Segments 1 and 3.
 */

export type Segment =
  | "reseller_controlled"
  | "authorized_network_healthy"
  | "mixed_control"
  | "brand_managed_with_leakage"
  | "brand_self_managed"
  | "amazon_vendor_central"
  | "anti_amazon_stance"
  | "enterprise_pe_public"
  | "trademark_split"
  | "below_revenue_floor";

export type ReportMode =
  | "opportunity"
  | "tight"
  | "opportunity_softlead"
  | null;

export interface SegmentInput {
  /** 0-100. Brand-owned share of buy box. */
  brand_owned_pct: number;
  /** 0-100. Authorized-distributor share of buy box. */
  authorized_pct: number;
  /** 0-100. Unauthorized reseller share of buy box. */
  unauthorized_pct: number;
  /** 0-100. Amazon retail (ATVPDKIKX0DER) share of buy box. */
  amazon_pct: number;
  /** Trailing-12-month Amazon revenue in USD. */
  ttm_revenue_usd: number;
  /** True if the brand entity owns its own trademark. */
  has_trademark: boolean;
  /** LLM-determined: brand publicly opposes Amazon. */
  is_anti_amazon: boolean;
  /** LLM-determined: parent >$50M, PE-portfolio, or publicly traded. */
  is_enterprise_pe_public: boolean;
}

export interface SegmentResult {
  segment: Segment;
  qualified: boolean;
  report_mode: ReportMode;
  reason: string;
}

/** Revenue floor disqualifier. The ONLY hard dollar number in segmentation. */
export const REVENUE_FLOOR_USD = 500_000;

/** Buy-box thresholds (percent, 0-100). Keep in one place for tests. */
export const THRESHOLDS = {
  BRAND_SELF_MANAGED_BRAND_OWNED: 70,
  BRAND_SELF_MANAGED_UNAUTH_MAX: 10,
  AMAZON_VC: 50,
  S2_AUTHORIZED_MIN: 40,
  S2_UNAUTH_MAX: 20,
  S2_AMAZON_MAX: 50,
  S1_BRAND_OWNED_MAX: 5,
  S1_AUTHORIZED_MAX: 10,
  S1_UNAUTH_MIN: 50,
  S1_AMAZON_MAX: 50,
  S3_AUTHORIZED_MIN: 10,
  S3_UNAUTH_MIN: 20,
  S3_BRAND_OWNED_MAX: 70,
  S3_AMAZON_MAX: 50,
  S4_BRAND_OWNED_MIN: 30,
  S4_BRAND_OWNED_MAX: 70,
  S4_UNAUTH_MIN: 20,
  S4_AMAZON_MAX: 50,
} as const;

/**
 * Compute the segment for a brand from its channel shares + flags.
 *
 * Disqualifier priority (first match wins):
 *   1. trademark_split        — Phase 1 capture requires trademark ownership
 *   2. anti_amazon_stance     — we don't help brands leave the platform
 *   3. enterprise_pe_public   — we serve independent owner-operators
 *   4. below_revenue_floor    — TTM Amazon < $500K
 *   5. amazon_vendor_central  — Amazon >= 50% of buy box (1P)
 *   6. brand_self_managed     — brand already owns the channel
 *
 * Then segment into one of the four qualified buckets:
 *   - Segment 1 reseller_controlled         → opportunity
 *   - Segment 2 authorized_network_healthy  → tight
 *   - Segment 3 mixed_control               → opportunity
 *   - Segment 4 brand_managed_with_leakage  → opportunity_softlead
 *
 * Segment 1 is the default when nothing else matches (e.g. fresh scan
 * with everything unclassified → treated as unauthorized → Segment 1).
 */
export function computeSegment(input: SegmentInput): SegmentResult {
  const {
    brand_owned_pct,
    authorized_pct,
    unauthorized_pct,
    amazon_pct,
    ttm_revenue_usd,
    has_trademark,
    is_anti_amazon,
    is_enterprise_pe_public,
  } = input;

  // 1. Trademark split.
  if (!has_trademark) {
    return {
      segment: "trademark_split",
      qualified: false,
      report_mode: null,
      reason:
        "Trademark not owned by the brand entity. Phase 1 capture requires trademark ownership.",
    };
  }

  // 2. Anti-Amazon stance.
  if (is_anti_amazon) {
    return {
      segment: "anti_amazon_stance",
      qualified: false,
      report_mode: null,
      reason: "Brand opposes Amazon. We don't help brands leave the platform.",
    };
  }

  // 3. Enterprise / PE / public.
  if (is_enterprise_pe_public) {
    return {
      segment: "enterprise_pe_public",
      qualified: false,
      report_mode: null,
      reason:
        "Out of ICP — we serve independent owner-operator brands, not enterprise.",
    };
  }

  // 4. Below revenue floor.
  if (ttm_revenue_usd < REVENUE_FLOOR_USD) {
    return {
      segment: "below_revenue_floor",
      qualified: false,
      report_mode: null,
      reason: "Below revenue floor. Engagement isn't justified at this scale.",
    };
  }

  // 5. Amazon Vendor Central / 1P.
  if (amazon_pct >= THRESHOLDS.AMAZON_VC) {
    return {
      segment: "amazon_vendor_central",
      qualified: false,
      report_mode: null,
      reason:
        "Brand is on Amazon Vendor Central / 1P. Amazon does this better than we could.",
    };
  }

  // 6. Brand self-managed clean.
  if (
    brand_owned_pct >= THRESHOLDS.BRAND_SELF_MANAGED_BRAND_OWNED &&
    unauthorized_pct < THRESHOLDS.BRAND_SELF_MANAGED_UNAUTH_MAX &&
    amazon_pct < THRESHOLDS.AMAZON_VC
  ) {
    return {
      segment: "brand_self_managed",
      qualified: false,
      report_mode: null,
      reason:
        "Brand already controls the channel. We have no Phase 1 to sell. Phase 2 only follows our Phase 1, so no offer.",
    };
  }

  // ---- Qualified segments ----

  // Segment 2 — authorized network healthy.
  if (
    authorized_pct >= THRESHOLDS.S2_AUTHORIZED_MIN &&
    unauthorized_pct <= THRESHOLDS.S2_UNAUTH_MAX &&
    amazon_pct < THRESHOLDS.S2_AMAZON_MAX
  ) {
    return {
      segment: "authorized_network_healthy",
      qualified: true,
      report_mode: "tight",
      reason:
        "Healthy authorized-distributor network. Phase 2 still requires direct brand control of the channel.",
    };
  }

  // Segment 4 — brand-managed with leakage (NEW Phase 56).
  if (
    brand_owned_pct >= THRESHOLDS.S4_BRAND_OWNED_MIN &&
    brand_owned_pct < THRESHOLDS.S4_BRAND_OWNED_MAX &&
    unauthorized_pct >= THRESHOLDS.S4_UNAUTH_MIN &&
    amazon_pct < THRESHOLDS.S4_AMAZON_MAX
  ) {
    return {
      segment: "brand_managed_with_leakage",
      qualified: true,
      report_mode: "opportunity_softlead",
      reason:
        "Brand controls a meaningful share already, but unauthorized resellers are causing leakage. Close the gap, double profit on existing demand, set up Phase 2.",
    };
  }

  // Segment 3 — mixed control.
  if (
    authorized_pct >= THRESHOLDS.S3_AUTHORIZED_MIN &&
    unauthorized_pct >= THRESHOLDS.S3_UNAUTH_MIN &&
    brand_owned_pct < THRESHOLDS.S3_BRAND_OWNED_MAX &&
    amazon_pct < THRESHOLDS.S3_AMAZON_MAX
  ) {
    return {
      segment: "mixed_control",
      qualified: true,
      report_mode: "opportunity",
      reason:
        "Partial distributor strategy plus uncontrolled resellers eating margin. Close the unauthorized gap, transition the authorized piece tactfully.",
    };
  }

  // Segment 1 — reseller-controlled (default for fresh / heavy-reseller brands).
  return {
    segment: "reseller_controlled",
    qualified: true,
    report_mode: "opportunity",
    reason:
      "Resellers control the channel today. Phase 1 takes it back — brand owns the buy box, profit on existing demand doubles, Phase 2 grows it.",
  };
}

/** Human-readable label for UI surfaces. */
export const SEGMENT_LABEL: Record<Segment, string> = {
  reseller_controlled: "Reseller-controlled",
  authorized_network_healthy: "Authorized network (healthy)",
  mixed_control: "Mixed control",
  brand_managed_with_leakage: "Brand-managed with leakage",
  brand_self_managed: "Brand self-managed",
  amazon_vendor_central: "Amazon Vendor Central / 1P",
  anti_amazon_stance: "Anti-Amazon stance",
  enterprise_pe_public: "Enterprise / PE / public",
  trademark_split: "Trademark split",
  below_revenue_floor: "Below revenue floor",
};
