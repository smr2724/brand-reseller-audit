-- Migration 0057: Phase 73.2 — Manual contact entry.
--
-- Steve can now add a contact by hand from the merged Decision-Makers
-- card (Apollo / Hunter / 8-pattern / LLM web-search all missed; he
-- already knows the email from the brand's Contact page). The route
-- gates on MillionVerifier — only MV='valid' addresses get written —
-- and stamps the new row with `email_source='manual'`. The audit
-- trail surfaces a paired `provider='manual'` event so the discovery
-- panel shows that a human supplied the email.
--
-- Migration 0055 already allowed `email_source='manual'` on
-- brand_contacts (it was carried forward from the original 0040
-- constraint). The only widening needed here is the discovery-events
-- provider CHECK, which had no 'manual' value. Rebuild
-- brand_contacts.email_source_check too so this file is the canonical
-- statement of the current allowed set even if 0055 is ever rolled
-- back partially.
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
      'enrichment_deferred',
      'manual'
    ));

COMMIT;
