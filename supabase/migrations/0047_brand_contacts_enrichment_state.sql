-- Phase 63 — Apollo-first contact discovery with primary-only auto-enrich.
--
-- 1. Add `enrichment_state` to brand_contacts so the orchestrator can
--    distinguish rows that have only been discovered (Apollo search hit,
--    NO credit-burning Apollo /people/match yet) from rows we've
--    enriched (Apollo unlock attempted + Hunter/pattern fallback chain
--    run). The UI uses this to show an "Enrich" button on discovered
--    rows.
--
-- 2. Backfill: any row that already has an email OR an email_source
--    counts as enriched. New rows from the Phase 63 orchestrator are
--    inserted as 'discovered' until they go through the enrichment
--    pipeline (auto for primary, on-demand for the rest).
--
-- 3. Extend the provider CHECK on brand_contact_discovery_events to
--    accept the new 'enrichment_deferred' provider that the orchestrator
--    emits for non-primary contacts so the audit trail explains why
--    they aren't enriched yet.

ALTER TABLE brand_contacts
  ADD COLUMN IF NOT EXISTS enrichment_state TEXT NOT NULL DEFAULT 'discovered'
    CHECK (enrichment_state IN ('discovered', 'enriched', 'error'));

CREATE INDEX IF NOT EXISTS idx_brand_contacts_enrichment_state
  ON brand_contacts(brand_id, enrichment_state);

-- Backfill: any row that already has email or email_source counts as enriched.
UPDATE brand_contacts
SET enrichment_state = 'enriched'
WHERE email IS NOT NULL OR email_source IS NOT NULL;

-- Extend provider CHECK on the discovery events table so the
-- orchestrator can record 'enrichment_deferred' events for the 4
-- non-primary contacts. The CHECK constraint name from migration 0046
-- is the default brand_contact_discovery_events_provider_check.
ALTER TABLE brand_contact_discovery_events
  DROP CONSTRAINT IF EXISTS brand_contact_discovery_events_provider_check;
ALTER TABLE brand_contact_discovery_events
  ADD CONSTRAINT brand_contact_discovery_events_provider_check
    CHECK (provider IN (
      'apollo_search',
      'apollo_match',
      'hunter_domain',
      'hunter_finder',
      'millionverifier',
      'zerobounce',
      'pattern_guess',
      'orchestrator',
      'enrichment_deferred'
    ));
