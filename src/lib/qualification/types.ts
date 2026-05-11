/**
 * Phase 47 — Shared types for Module 1 (Brand Qualification).
 */

export type LegalEntityType =
  | "individual"
  | "corporation"
  | "llc"
  | "subsidiary"
  | "partnership"
  | "unknown";

export type OwnershipSignal =
  | "owner_operated"
  | "pe_owned"
  | "public"
  | "subsidiary"
  | "unknown";

export type IcpVerdict = "qualified" | "disqualified" | "needs_review";

// Phase 68 — Migration 0050 widened the disqualification_pattern CHECK
// constraint with six gate-driven values. Keep this type in sync with the
// normalizer whitelist so callers don't have to cast.
export type DisqualificationPattern =
  | "public_company"
  | "subsidiary_of_public"
  | "pe_portfolio_large"
  | "dealer_network"
  | "anti_amazon"
  | "enterprise"
  | "subsidiary_of_giant"
  | "no_amazon_presence"
  | "brand_self_managed"
  | "parent_revenue_ratio_below_threshold"
  | "no_named_decision_maker"
  | "buyer_rejection_wins"
  | "holding_naming_signal_review"
  | "other";

export type QualificationState =
  | "pending"
  | "running"
  | "complete"
  | "error";

export interface CandidateEntity {
  name: string;
  type: LegalEntityType | string;
  country: string;
  evidence_url: string;
  evidence_summary: string;
  confidence: number;
}

export type HookCode =
  | "anti_amazon_policy_violation"
  | "trademark_split"
  | "dominant_single_reseller"
  | "geographic_diversion"
  | "small_attorney_signal"
  | "pe_or_holdco_dressed_as_indie"
  | "custom";

export interface CandidateHook {
  hook_code: HookCode | string;
  hook_text: string;
  evidence: string;
  confidence: number;
}

// Phase 50 — upgraded narrative output.
export type BrandAssociationType =
  | "brand_owned"
  | "parent_owned"
  | "affiliate"
  | "licensed_distributor";

export interface BrandAssociatedSeller {
  seller_name: string;
  association_type: BrandAssociationType;
  evidence: string;
}

export interface FalsePositiveFlag {
  flag: string;
  explanation: string;
}

export type ChannelPattern =
  | "dealer_led_oem"
  | "split_ip_split_ops"
  | "independent_owner_operator"
  | "pe_holdco"
  | "subsidiary_of_giant"
  | string;

/**
 * Phase 57 — Pitch Math is computed server-side from canonical economics
 * functions (`computeLegionEconomics` for opportunity-mode brands,
 * `computeBenchmarkEconomics` for Segment 2 / tight-mode brands). The
 * narrative LLM no longer touches this field — it produces narrative
 * markdown only. The 100% recapture story is non-negotiable: every
 * reseller is removed in Phase 1, so the recoverable slice equals the
 * reseller-controlled slice.
 *
 * Legacy LLM-emitted keys (recoverable_share_pct, blended_margin_*,
 * defensible_pitch_number_usd, reasoning) are removed. The backfill
 * script overwrites historical rows with the canonical shape.
 */
export interface PitchMath {
  ttm_revenue_usd: number;
  /** Share of revenue currently flowing through resellers (0..1). For
   *  Segment 2 (authorized_network_healthy) brands this is the authorized
   *  share — same canonical input either way. */
  reseller_controlled_share: number;
  /** TTM revenue × reseller_controlled_share. */
  reseller_controlled_revenue_usd: number;
  /** 100% of reseller_controlled_revenue_usd — RCG removes every reseller. */
  recoverable_revenue_usd: number;
  /** Current reseller-controlled-state net margin (LEGION_DEFAULTS.reseller_net_margin_pct = 0.105). */
  current_profit_margin: number;
  /** Post-Phase-1 brand-controlled-state margin (LEGION_DEFAULTS.current_profit_margin_pct = 0.20). */
  post_capture_profit_margin: number;
  /** TTM revenue × current_profit_margin. */
  current_annual_profit_usd: number;
  /** TTM revenue × post_capture_profit_margin. */
  post_capture_annual_profit_usd: number;
  /** post_capture_annual_profit_usd − current_annual_profit_usd ("profit doubled" math). */
  delta_profit_usd: number;
  /** Exit-lift @ EBITDA multiple — passthrough from the canonical economics function. */
  exit_lift_usd: number;
  /** Which canonical function this came from. Hard-coded; the LLM cannot
   *  set it. Renderers may key off this for the tight-mode card variant. */
  source: "computeLegionEconomics" | "computeBenchmarkEconomics";
}

export interface QualificationRow {
  id: string;
  brand_id: string;
  brand_name_input: string;
  top_seller_names: string[] | null;
  asin_count: number | null;
  ttm_revenue_estimate_usd: number | null;
  candidate_entities: CandidateEntity[];
  selected_entity: CandidateEntity | null;
  selection_reasoning: string | null;
  legal_entity_name: string | null;
  legal_entity_type: LegalEntityType | null;
  legal_entity_country: string | null;
  trademark_owner: string | null;
  trademark_attorney: string | null;
  trademark_serial: string | null;
  trademark_status: string | null;
  ownership_signal: OwnershipSignal | null;
  icp_verdict: IcpVerdict;
  icp_reasoning: string;
  icp_reconciliation_note: string | null;
  disqualification_pattern: DisqualificationPattern | null;
  candidate_hooks: CandidateHook[];
  // Phase 50 — long-form analyst narrative + structured side-fields.
  // Nullable on legacy rows that pre-date Phase 50.
  narrative_markdown: string | null;
  brand_associated_sellers: BrandAssociatedSeller[] | null;
  false_positive_flags: FalsePositiveFlag[] | null;
  channel_pattern: ChannelPattern | null;
  pitch_math: PitchMath | null;
  llm_model: string | null;
  llm_tokens_in: number | null;
  llm_tokens_out: number | null;
  llm_cost_usd: number | null;
  uspto_called: boolean;
  total_cost_usd: number | null;
  manual_override: boolean;
  manual_override_reason: string | null;
  manual_override_at: string | null;
  // Phase 68 — qualification hard gates (migration 0050).
  parent_entity: unknown | null;
  controlling_entity_revenue_usd: number | null;
  controlling_entity_employees: number | null;
  controlling_entity_ownership_type: string | null;
  recoverable_to_controlling_ratio: number | null;
  gate_a_corporate_hierarchy: unknown | null;
  gate_b_revenue_ratio: unknown | null;
  gate_c_named_decision_maker: unknown | null;
  buyer_rejection_simulation: unknown | null;
  hard_gate_verdict: "pass" | "hard_disqualify" | "needs_review" | null;
  hard_gate_failure_reason: string | null;
  hard_gate_failure_gate: string | null;
  hierarchy_sources: unknown | null;
  state: QualificationState;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}
