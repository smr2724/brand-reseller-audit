/**
 * Phase 69 — Shared types for the Contact Strategy step.
 *
 * Lives separate from `apollo.ts` / `orchestrate.ts` so the legacy
 * contact-discovery code path is untouched (Phase 63 lockdown).
 */

export type CompanySizeTier = "micro" | "small" | "mid" | "enterprise";

export type StrategyVerdict = "ready" | "needs_human_review" | "error";

export type PersonalStake =
  | "equity_owner"
  | "p_and_l_owner"
  | "comp_tied_to_channel"
  | "none";

export interface ContactProfileTemplate {
  primary_titles: string[];
  secondary_titles: string[];
  titles_to_avoid: string[];
  seniorities: string[];
  departments: string[];
  rationale_template: string;
}

export interface NamedCandidate {
  name: string;
  title: string | null;
  linkedin_url: string | null;
  reason: string;
  can_sign_50k: boolean;
  personal_stake: PersonalStake;
}

export interface SizeSignals {
  employees: number | null;
  revenue_usd: number | null;
  linkedin_count: number | null;
  wikipedia_employees: number | null;
  apollo_employees: number | null;
  source: "linkedin" | "wikipedia" | "apollo" | "llm_estimate" | "unknown";
}

export interface ContactStrategy {
  company_size_tier: CompanySizeTier;
  primary_titles: string[];
  secondary_titles: string[];
  titles_to_avoid: string[];
  seniorities: string[];
  departments: string[];
  profile_rationale: string;
  named_candidates: NamedCandidate[];
  outreach_order: string[]; // names, best first
  llm_verdict: StrategyVerdict;
  llm_model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

export interface ApolloPerson {
  id: string;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  title: string | null;
  linkedin_headline: string | null;
  linkedin_url: string | null;
  seniority: string | null;
  department: string | null;
  email: string | null;
  email_status: string | null;
  organization_id: string | null;
  organization_name: string | null;
  organization_domain: string | null;
}

export interface ApolloMixedSearchInput {
  organization_ids?: string[];
  q_organization_domains?: string[];
  person_titles: string[];
  person_seniorities?: string[];
  person_departments?: string[];
  /** Phase 71 — free-text keywords passed to Apollo's mixed_people/search
   *  `q_keywords` filter. Used to seed Gate C name disambiguation when
   *  searching by title at a domain returns multiple candidates. */
  q_keywords?: string;
  page?: number;
  per_page?: number;
}

export interface ApolloMixedSearchResult {
  ok: boolean;
  candidates: ApolloPerson[];
  total_entries: number;
  pagination: { page: number; per_page: number; total_pages: number };
  cost_credits: number;
  error?: string;
}

export interface ScoredCandidate {
  candidate: ApolloPerson;
  score: number;
}

export interface ControllingEntityShape {
  name: string | null;
  domain: string | null;
  type?: string | null;
  country?: string | null;
  // Phase 69 follow-up: Phase 68's resolution chain may already have an
  // authoritative employee count from controlling_entity. When present,
  // it short-circuits gatherSizeSignals so we never classify a $80M
  // brand as `micro` just because the lookups are stubbed.
  employees?: number | null;
}

export interface ContactStrategyPersistInput {
  brand_id: string;
  qualification_id: string | null;
  size_tier: CompanySizeTier;
  employees_estimate: number | null;
  revenue_estimate_usd: number | null;
  size_signals: SizeSignals;
  strategy: ContactStrategy;
  ranked: ScoredCandidate[];
  verdict: StrategyVerdict;
  verdict_reason: string;
  llm_cost_usd: number;
  apollo_cost_usd: number;
  hunter_cost_usd: number;
}

export interface ContactStrategyResult {
  ok: boolean;
  verdict: StrategyVerdict;
  strategy_id: string | null;
  reason?: string;
  ranked?: ScoredCandidate[];
}
