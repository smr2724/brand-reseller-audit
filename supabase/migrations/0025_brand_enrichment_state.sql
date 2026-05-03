DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'brand_enrichment_state') THEN
    CREATE TYPE brand_enrichment_state AS ENUM ('pending','queued','enriching','enriched','failed','deferred');
  END IF;
END $$;

ALTER TABLE brands ADD COLUMN IF NOT EXISTS enrichment_state brand_enrichment_state;

UPDATE brands SET enrichment_state = 'enriched' WHERE keepa_last_enriched_at IS NOT NULL AND enrichment_state IS NULL;
UPDATE brands SET enrichment_state = 'pending'  WHERE keepa_last_enriched_at IS NULL AND enrichment_state IS NULL;

ALTER TABLE brands ALTER COLUMN enrichment_state SET DEFAULT 'pending';
ALTER TABLE brands ALTER COLUMN enrichment_state SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_brands_enrichment_state ON brands (enrichment_state) WHERE enrichment_state IN ('pending','failed');
