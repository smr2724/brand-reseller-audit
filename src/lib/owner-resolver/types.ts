/**
 * Phase 33 — Brand Owner Resolver
 *
 * Shared types for the resolver pipeline. The pipeline collects candidate
 * owner companies for an Amazon brand from external sources (USPTO trademark
 * registry + web search), scores them deterministically, and persists them
 * for human-in-the-loop selection in the admin UI.
 */

export type OwnerResolutionState =
  | "pending"
  | "running"
  | "candidates_ready"
  | "selected"
  | "failed"
  | "skipped";

export type OwnerResolutionTrigger =
  | "auto_post_enrichment"
  | "manual"
  | "rerun";

export type OwnerResolutionRunStatus = "running" | "succeeded" | "failed";

export type OwnerCandidateSource =
  | "uspto"
  | "web_search"
  | "seller_name_heuristic"
  | "manual";

export type ResolvedOwnerType =
  | "manufacturer"
  | "brand_owner"
  | "licensee"
  | "distributor"
  | "dba"
  | "holding_co"
  | "unknown";

export type HeuristicLabel =
  | "very_high"
  | "high"
  | "medium"
  | "needs_review"
  | "unscored";

/**
 * A candidate owner before persistence — fields gathered by adapters and
 * scored by the heuristic. `id` and `resolution_run_id` are filled when
 * the row is inserted.
 */
export interface RawOwnerCandidate {
  candidate_company_name: string;
  candidate_domain: string | null;
  candidate_source: OwnerCandidateSource;
  evidence_text: string | null;
  evidence_url: string | null;
  match_reason: string | null;
  trademark_serial_number: string | null;
  trademark_status: string | null;
  trademark_registration_date: string | null; // ISO date (YYYY-MM-DD)
  trademark_owner_address: string | null;
  goods_services_text: string | null;
  raw_payload: unknown;
}

export interface ScoredOwnerCandidate extends RawOwnerCandidate {
  heuristic_score: number;
  heuristic_label: HeuristicLabel;
  needs_manual_review: boolean;
}

export interface OwnerCandidateRow extends ScoredOwnerCandidate {
  id: string;
  brand_id: string;
  resolution_run_id: string;
  is_selected_owner: boolean;
  selected_at: string | null;
  selected_by_user_id: string | null;
  created_at: string;
}

export interface OwnerResolutionRunRow {
  id: string;
  brand_id: string;
  triggered_by: OwnerResolutionTrigger;
  started_at: string;
  completed_at: string | null;
  status: OwnerResolutionRunStatus;
  error_message: string | null;
  uspto_query: string | null;
  uspto_results_count: number | null;
  web_search_queries: string[] | null;
  web_search_results_count: number | null;
  raw_uspto_payload: unknown;
  raw_web_search_payload: unknown;
  candidates_inserted: number;
}

/**
 * Inputs the heuristic scorer needs about the brand context to apply
 * category- and product-overlap rules.
 */
export interface BrandContext {
  brand_id: string;
  brand_name: string;
  category: string | null;
  product_titles: string[];
}
