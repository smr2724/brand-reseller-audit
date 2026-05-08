-- Migration 0042: Phase 51 — verdict reconciliation belt-and-suspenders.
--
-- 1. Add `brand_self_managed` to the disqualification_pattern set on
--    brand_qualifications. The column is a free-form text with a CHECK
--    constraint (not a true enum), so we drop and re-add the constraint.
-- 2. Add icp_reconciliation_note (nullable) so the orchestrator can
--    surface conflicts between the ICP verdict and the narrative
--    recommendation without silently rewriting the verdict.

ALTER TABLE brand_qualifications
  DROP CONSTRAINT IF EXISTS brand_qualifications_disqualification_pattern_check;

ALTER TABLE brand_qualifications
  ADD CONSTRAINT brand_qualifications_disqualification_pattern_check
  CHECK (
    disqualification_pattern IS NULL
    OR disqualification_pattern IN (
      'public_company',
      'dealer_network',
      'anti_amazon',
      'enterprise',
      'subsidiary_of_giant',
      'no_amazon_presence',
      'brand_self_managed',
      'other'
    )
  );

ALTER TABLE brand_qualifications
  ADD COLUMN IF NOT EXISTS icp_reconciliation_note text;
