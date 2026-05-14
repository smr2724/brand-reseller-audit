BEGIN;

-- Phase 74 — backfill brands.resolved_owner_domain from Gate A controlling entity.
-- Phase 49 removed the owner-resolution auto-trigger; this seeds the column for
-- brands that have been qualified since but never got the column populated.

UPDATE brands b
SET
  resolved_owner_domain = trim(bq.gate_a_corporate_hierarchy->'controlling_entity'->>'domain'),
  owner_resolution_state = 'selected'
FROM brand_qualifications bq
WHERE bq.brand_id = b.id
  AND b.resolved_owner_domain IS NULL
  AND bq.gate_a_corporate_hierarchy->'controlling_entity'->>'domain' IS NOT NULL
  AND length(trim(bq.gate_a_corporate_hierarchy->'controlling_entity'->>'domain')) > 0;

COMMIT;
