-- 0053_rejection_sim_advisory.sql
-- Phase 71: rejection_sim is no longer a terminal hard gate when
-- Gate A/B/C all pass. All behavior change is in application code; the
-- disqualification_pattern CHECK constraint stays unchanged (the
-- 'buyer_rejection_wins' value remains valid for backfill / for cases
-- where Gate A/B/C also fail and rejection adds context).
--
-- Phase 71 also introduces `email_source='apollo_linkedin_match'` for
-- contacts enriched directly via Apollo /v1/people/match keyed on the
-- Gate C decision-maker's LinkedIn URL. Widen the brand_contacts CHECK
-- constraint accordingly. Idempotent: drops the prior constraint first.

BEGIN;

ALTER TABLE brand_contacts
  DROP CONSTRAINT IF EXISTS brand_contacts_email_source_check;

ALTER TABLE brand_contacts
  ADD CONSTRAINT brand_contacts_email_source_check
    CHECK (
      email_source IS NULL
      OR email_source IN (
        'apollo',
        'apollo_crm',
        'apollo_match',
        'apollo_linkedin_match',
        'hunter',
        'hunter_pattern',
        'pattern_guess',
        'manual',
        'unknown'
      )
    );

COMMIT;
