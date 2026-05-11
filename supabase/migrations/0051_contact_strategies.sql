-- Migration 0051: Phase 69 Contact Strategy
--
-- Adds a `contact_strategies` table that stores the per-brand "ideal
-- contact profile" derived from the Phase 68 hard-gate output plus the
-- ranked candidate set sourced from Apollo/Hunter. Idempotent — mirrors
-- the migration already applied to prod so re-applying is a no-op.

CREATE TABLE IF NOT EXISTS contact_strategies (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id             uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  qualification_id     uuid REFERENCES brand_qualifications(id) ON DELETE SET NULL,

  -- Size classification
  company_size_tier    text NOT NULL,
  employees_estimate   integer,
  revenue_estimate_usd numeric,
  size_signals         jsonb,

  -- Ideal contact profile
  primary_titles       text[] NOT NULL,
  secondary_titles     text[] NOT NULL DEFAULT '{}',
  titles_to_avoid      text[] NOT NULL DEFAULT '{}',
  seniorities          text[] NOT NULL DEFAULT '{}',
  departments          text[] NOT NULL DEFAULT '{}',
  profile_rationale    text,

  -- Named candidates (LLM output before Apollo)
  named_candidates     jsonb NOT NULL DEFAULT '[]'::jsonb,
  outreach_order       jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Verdict
  verdict              text NOT NULL,
  verdict_reason       text,

  -- Cost tracking
  llm_model            text,
  llm_tokens_in        integer,
  llm_tokens_out       integer,
  llm_cost_usd         numeric,
  apollo_cost_usd      numeric,
  hunter_cost_usd      numeric,
  total_cost_usd       numeric,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT contact_strategies_company_size_tier_check
    CHECK (company_size_tier = ANY (ARRAY['micro','small','mid','enterprise'])),
  CONSTRAINT contact_strategies_verdict_check
    CHECK (verdict = ANY (ARRAY['ready','needs_human_review','error']))
);

CREATE INDEX IF NOT EXISTS idx_contact_strategies_brand_id ON contact_strategies(brand_id);
CREATE INDEX IF NOT EXISTS idx_contact_strategies_verdict  ON contact_strategies(verdict);

-- brand-level pointer to the latest strategy row
ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS contact_strategy_id uuid REFERENCES contact_strategies(id) ON DELETE SET NULL;
