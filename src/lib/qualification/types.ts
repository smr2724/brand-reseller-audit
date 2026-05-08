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

export type DisqualificationPattern =
  | "public_company"
  | "dealer_network"
  | "anti_amazon"
  | "enterprise"
  | "subsidiary_of_giant"
  | "no_amazon_presence"
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
  disqualification_pattern: DisqualificationPattern | null;
  candidate_hooks: CandidateHook[];
  llm_model: string | null;
  llm_tokens_in: number | null;
  llm_tokens_out: number | null;
  llm_cost_usd: number | null;
  uspto_called: boolean;
  total_cost_usd: number | null;
  manual_override: boolean;
  manual_override_reason: string | null;
  manual_override_at: string | null;
  state: QualificationState;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}
