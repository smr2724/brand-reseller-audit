-- Phase 68 — Qualification hard gates + buyer rejection simulation.
--
-- Adds per-gate result columns on brand_qualifications, three new CHECK
-- constraints for the new enum fields, widens the disqualification_pattern
-- CHECK to admit the gate-driven values, and indexes the new
-- hard_gate_verdict column so the queue can filter on it.
--
-- Already applied to prod via Supabase MCP — this file checks the change
-- into source control. Every operation is idempotent (IF NOT EXISTS,
-- DROP IF EXISTS, DO $$ ... IF NOT EXISTS ... END $$) so replaying
-- against prod is a no-op.

-- New per-gate result columns on brand_qualifications
ALTER TABLE brand_qualifications
  ADD COLUMN IF NOT EXISTS parent_entity                       jsonb,
  ADD COLUMN IF NOT EXISTS controlling_entity_revenue_usd      numeric,
  ADD COLUMN IF NOT EXISTS controlling_entity_employees        integer,
  ADD COLUMN IF NOT EXISTS controlling_entity_ownership_type   text,
  ADD COLUMN IF NOT EXISTS recoverable_to_controlling_ratio    numeric,
  ADD COLUMN IF NOT EXISTS gate_a_corporate_hierarchy          jsonb,
  ADD COLUMN IF NOT EXISTS gate_b_revenue_ratio                jsonb,
  ADD COLUMN IF NOT EXISTS gate_c_named_decision_maker         jsonb,
  ADD COLUMN IF NOT EXISTS buyer_rejection_simulation          jsonb,
  ADD COLUMN IF NOT EXISTS hard_gate_verdict                   text,
  ADD COLUMN IF NOT EXISTS hard_gate_failure_reason            text,
  ADD COLUMN IF NOT EXISTS hard_gate_failure_gate              text,
  ADD COLUMN IF NOT EXISTS hierarchy_sources                   jsonb;

-- Constrain hard_gate_verdict (idempotent via pg_constraint lookup).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'brand_qualifications_hard_gate_verdict_check'
       AND conrelid = 'brand_qualifications'::regclass
  ) THEN
    ALTER TABLE brand_qualifications
      ADD CONSTRAINT brand_qualifications_hard_gate_verdict_check
        CHECK (hard_gate_verdict IS NULL
               OR hard_gate_verdict = ANY (ARRAY['pass','hard_disqualify','needs_review']));
  END IF;
END $$;

-- Constrain hard_gate_failure_gate (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'brand_qualifications_hard_gate_failure_gate_check'
       AND conrelid = 'brand_qualifications'::regclass
  ) THEN
    ALTER TABLE brand_qualifications
      ADD CONSTRAINT brand_qualifications_hard_gate_failure_gate_check
        CHECK (hard_gate_failure_gate IS NULL
               OR hard_gate_failure_gate = ANY (ARRAY['pattern_prescreen','gate_a','gate_b','gate_c','rejection_sim']));
  END IF;
END $$;

-- Constrain controlling_entity_ownership_type (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'brand_qualifications_controlling_ownership_check'
       AND conrelid = 'brand_qualifications'::regclass
  ) THEN
    ALTER TABLE brand_qualifications
      ADD CONSTRAINT brand_qualifications_controlling_ownership_check
        CHECK (controlling_entity_ownership_type IS NULL
               OR controlling_entity_ownership_type = ANY (ARRAY['public','pe_owned','private_independent','family_office','holding_co_private','unknown']));
  END IF;
END $$;

-- Widen disqualification_pattern CHECK to admit the new gate-driven values.
-- Drop + re-add (PG has no easy ALTER CHECK).
ALTER TABLE brand_qualifications
  DROP CONSTRAINT IF EXISTS brand_qualifications_disqualification_pattern_check;

ALTER TABLE brand_qualifications
  ADD CONSTRAINT brand_qualifications_disqualification_pattern_check
    CHECK (disqualification_pattern IS NULL
           OR disqualification_pattern = ANY (ARRAY[
             'public_company',
             'subsidiary_of_public',
             'pe_portfolio_large',
             'dealer_network',
             'anti_amazon',
             'enterprise',
             'subsidiary_of_giant',
             'no_amazon_presence',
             'brand_self_managed',
             'parent_revenue_ratio_below_threshold',
             'no_named_decision_maker',
             'buyer_rejection_wins',
             'holding_naming_signal_review',
             'other'
           ]));

-- Index for filtering the queue by gate verdict
CREATE INDEX IF NOT EXISTS idx_brand_qualifications_hard_gate_verdict
  ON brand_qualifications(hard_gate_verdict);
