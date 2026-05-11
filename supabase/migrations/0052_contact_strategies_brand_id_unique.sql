-- Migration 0052: Phase 69 follow-up — UNIQUE INDEX on contact_strategies(brand_id)
--
-- The Phase 69 orchestrator runs once per brand and was originally
-- written with a plain INSERT. Without a uniqueness guarantee on
-- brand_id, re-running for the same brand silently creates orphan rows
-- and `brands.contact_strategy_id` ends up pointing to the most recent.
--
-- This migration deduplicates any existing rows (keeping the newest by
-- id) and then enforces uniqueness. Together with the orchestrator's
-- switch to upsert(onConflict: 'brand_id'), re-runs UPDATE in place.
-- Idempotent: safe to re-apply.

-- Drop duplicates first so the unique index can be created.
DELETE FROM contact_strategies a
USING contact_strategies b
WHERE a.id < b.id
  AND a.brand_id = b.brand_id;

CREATE UNIQUE INDEX IF NOT EXISTS contact_strategies_brand_id_unique
  ON contact_strategies(brand_id);
