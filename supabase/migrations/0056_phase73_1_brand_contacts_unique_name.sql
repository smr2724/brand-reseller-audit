-- Phase 73.1 — Unique index on (brand_id, lower(full_name))
--
-- The /api/brands/[id]/contacts/enrich-candidate route does
-- case-insensitive full_name lookup + insert-if-missing. Two
-- near-simultaneous clicks (two tabs, double-click, bulk + row
-- clicked together) used to both SELECT-miss and both INSERT,
-- producing duplicate brand_contacts rows for the same human and
-- burning duplicate Apollo credits when enrichment fired.
--
-- This partial unique index makes the race impossible at the DB
-- layer; the route catches 23505 and falls back to SELECT.
--
-- Partial-WHERE on `full_name IS NOT NULL` because legacy rows may
-- predate the requirement and we don't want to retroactively reject
-- nulls.
--
-- Pre-collapse: if duplicates already exist (from runs before the
-- Phase 73.1 race fix), keep the row with the richest data
-- (non-null email wins; otherwise earliest created_at). The
-- enrichment runs that produced the duplicates are still recorded
-- in brand_contact_discovery_events, so the audit trail survives
-- the row removal.
--
-- Idempotent. Safe to re-apply.

BEGIN;

-- Collapse any pre-existing duplicates: keep the best row per
-- (brand_id, lower(full_name)) where "best" = has email first,
-- then earliest created_at.
WITH ranked AS (
  SELECT
    id,
    brand_id,
    lower(full_name) AS lname,
    ROW_NUMBER() OVER (
      PARTITION BY brand_id, lower(full_name)
      ORDER BY
        CASE WHEN email IS NOT NULL AND length(email) > 0 THEN 0 ELSE 1 END,
        created_at ASC,
        id ASC
    ) AS rn
  FROM brand_contacts
  WHERE full_name IS NOT NULL
)
DELETE FROM brand_contacts
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS brand_contacts_brand_lower_full_name_idx
  ON brand_contacts (brand_id, lower(full_name))
  WHERE full_name IS NOT NULL;

COMMIT;
