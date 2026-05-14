-- Migration 0058: Backfill brands.resolved_owner_domain from brand_qualifications.selected_entity.evidence_url
-- Phase 74 — Option E (one-shot backfill paired with runtime fallback in
-- /api/brands/[id]/contacts/enrich-candidate)
--
-- The orchestrator (src/lib/contacts/orchestrate.ts) already falls back to
-- selected_entity.evidence_url when resolved_owner_domain is null. This migration
-- materialises that derived value onto brands so the column reflects reality and
-- downstream code that reads resolved_owner_domain directly works.
--
-- Skip rules:
--   * Skip rows where evidence_url is missing, 'unknown', or doesn't start with http(s)://
--   * Skip OpenCorporates URLs (user-mandated: never use opencorporates as a source)
--   * Skip if parsed domain has no dot (defensive guard against malformed URLs)
--   * Only touch rows where resolved_owner_domain IS NULL (idempotent — never overwrite)
--
-- Also sets owner_resolution_state='selected' on the same rows to clear the cosmetic
-- 'pending' tombstone left over from Phase 49's removal of maybeTriggerOwnerResolution.

BEGIN;

WITH backfill AS (
  SELECT
    b.id AS brand_id,
    lower(
      regexp_replace(
        regexp_replace(
          regexp_replace(bq.selected_entity->>'evidence_url', '^https?://', ''),
          '^www\.', ''
        ),
        '/.*$', ''
      )
    ) AS parsed_domain
  FROM brands b
  JOIN brand_qualifications bq ON bq.brand_id = b.id
  WHERE b.resolved_owner_domain IS NULL
    AND bq.selected_entity IS NOT NULL
    AND bq.selected_entity->>'evidence_url' IS NOT NULL
    AND bq.selected_entity->>'evidence_url' ~* '^https?://'
    AND bq.selected_entity->>'evidence_url' !~* 'opencorporates\.com'
)
UPDATE brands b
SET
  resolved_owner_domain = bf.parsed_domain,
  owner_resolution_state = 'selected',
  updated_at = now()
FROM backfill bf
WHERE b.id = bf.brand_id
  AND bf.parsed_domain ~ '\.'
  AND length(bf.parsed_domain) BETWEEN 4 AND 253;

COMMIT;
