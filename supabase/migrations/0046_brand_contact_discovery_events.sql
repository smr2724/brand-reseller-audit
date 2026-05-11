-- Phase 61 — Contact Discovery Transparency + Persistence
--
-- 1. New table `brand_contact_discovery_events` capturing every provider
--    call's outcome per discovery run. Powers the expandable per-row
--    audit trail in the Contact Discovery UI.
-- 2. Adds `raw_apollo_match jsonb` to `brand_contacts` — currently the
--    Apollo /people/match payload is dropped after the email is
--    extracted; we now persist it for forensics.
--
-- Auth model mirrors `brand_contacts` (Phase 47, migration 0040): no
-- table-level RLS, ownership enforced at the API route layer by joining
-- through `brands.user_id`. This migration intentionally does NOT
-- introduce a new auth model — to stay consistent with brand_contacts.

-- ---------------------------------------------------------------------
-- 1. Per-provider audit-trail events.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brand_contact_discovery_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id        uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES brand_contacts(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL,
  provider        text NOT NULL CHECK (provider IN (
    'apollo_search',
    'apollo_match',
    'hunter_domain',
    'hunter_finder',
    'millionverifier',
    'zerobounce',
    'pattern_guess',
    'orchestrator'
  )),
  outcome         text NOT NULL CHECK (outcome IN (
    'found',
    'not_found',
    'skipped',
    'error',
    'retry_exhausted'
  )),
  reason          text,
  email_returned  text,
  status_returned text,
  score_returned  numeric(4,3),
  http_status     int,
  raw_payload     jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brand_contact_discovery_events_brand_idx
  ON brand_contact_discovery_events (brand_id, created_at DESC);
CREATE INDEX IF NOT EXISTS brand_contact_discovery_events_contact_idx
  ON brand_contact_discovery_events (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS brand_contact_discovery_events_run_idx
  ON brand_contact_discovery_events (run_id);

-- ---------------------------------------------------------------------
-- 2. Persist Apollo /people/match payload alongside the search payload.
-- ---------------------------------------------------------------------
ALTER TABLE brand_contacts
  ADD COLUMN IF NOT EXISTS raw_apollo_match jsonb;
