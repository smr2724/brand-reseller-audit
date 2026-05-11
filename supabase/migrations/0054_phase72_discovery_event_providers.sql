-- Migration 0054: Phase 72 — widen brand_contact_discovery_events.provider
--
-- Phase 72 adds two new provider rows on the audit trail:
--   - linkedin_verify : HEAD-verification of the Gate C LinkedIn URL
--                       before passing it to Apollo people/match.
--   - hunter_pattern  : pattern-construction fallback (Hunter
--                       domain-search pattern × Gate C name) when
--                       Apollo + Hunter email-finder all miss.
--
-- Idempotent: drops the existing CHECK and rebuilds it with the widened
-- set. Order of values is preserved alphabetically for readability.

BEGIN;

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
      'millionverifier',
      'zerobounce',
      'pattern_guess',
      'orchestrator',
      'enrichment_deferred'
    ));

COMMIT;
