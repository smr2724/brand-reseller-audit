-- Phase 63 follow-up — add 'enriching' to the brand_contacts.enrichment_state
-- CHECK constraint so the on-demand /enrich endpoint and the orchestrator
-- can do an OPTIMISTIC CLAIM (set state='enriching' WHERE state='discovered')
-- before calling apolloUnlockPerson. This is the server-side idempotency
-- guard that prevents double-clicks / two tabs / impatient retries from
-- burning duplicate Apollo email credits on the same contact.
--
-- Lifecycle: discovered → enriching → enriched (or 'error' on failure).
-- The endpoint/orchestrator wrap the enrichment call in try/finally so the
-- row is NEVER left at 'enriching' — it's always flipped to 'enriched' on
-- success or 'error' on failure.
--
-- Migration 0047 declared enrichment_state via an inline CHECK on the column;
-- Postgres names that constraint brand_contacts_enrichment_state_check by
-- default. We drop and re-add the constraint to extend the allowed set.

ALTER TABLE brand_contacts
  DROP CONSTRAINT IF EXISTS brand_contacts_enrichment_state_check;
ALTER TABLE brand_contacts
  ADD CONSTRAINT brand_contacts_enrichment_state_check
    CHECK (enrichment_state IN ('discovered', 'enriching', 'enriched', 'error'));
