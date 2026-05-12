-- Migration 0055: Phase 73 — widen email_source + provider CHECKs.
--
-- Phase 73 introduces two new provenance values:
--   - email_source 'llm_websearch'  : contacts whose email was found by
--                                     the LLM web-search last-resort
--                                     fallback (only fires when Apollo +
--                                     Hunter + 8-pattern all miss).
--   - email_source 'hunter_finder'  : explicit Hunter email-finder hits
--                                     (previously bucketed under the
--                                     generic 'hunter' source). Kept
--                                     alongside 'hunter' to avoid a
--                                     backfill churn.
--   - provider     'llm_websearch'  : audit-trail rows for the
--                                     web-search call.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT.

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
        'hunter_finder',
        'hunter_pattern',
        'llm_websearch',
        'pattern_guess',
        'manual',
        'unknown'
      )
    );

ALTER TABLE brand_contact_discovery_events
  DROP CONSTRAINT IF EXISTS brand_contact_discovery_events_provider_check;

ALTER TABLE brand_contact_discovery_events
  ADD CONSTRAINT brand_contact_discovery_events_provider_check
    CHECK (provider IN (
      'apollo_search',
      'apollo_match',
      'hunter_domain',
      'hunter_finder',
      'hunter_pattern',
      'linkedin_verify',
      'llm_websearch',
      'millionverifier',
      'zerobounce',
      'pattern_guess',
      'orchestrator',
      'enrichment_deferred'
    ));

COMMIT;
