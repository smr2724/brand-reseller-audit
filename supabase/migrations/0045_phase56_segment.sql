-- Migration 0045: Phase 56 — ICP segmentation + report routing rewrite.
--
-- 1. Add `segment` to brand_qualifications so the deterministic
--    segmentation result is persisted alongside the LLM narrative.
-- 2. Auto-classify Amazon retail (ATVPDKIKX0DER) as 'amazon' on import
--    via a trigger on brand_sellers. This complements the existing
--    backfill clause in migration 0038.

ALTER TABLE brand_qualifications
  ADD COLUMN IF NOT EXISTS segment text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brand_qualifications_segment_check'
  ) THEN
    ALTER TABLE brand_qualifications
      ADD CONSTRAINT brand_qualifications_segment_check
      CHECK (
        segment IS NULL OR segment IN (
          'reseller_controlled',
          'authorized_network_healthy',
          'mixed_control',
          'brand_managed_with_leakage',
          'brand_self_managed',
          'amazon_vendor_central',
          'anti_amazon_stance',
          'enterprise_pe_public',
          'trademark_split',
          'below_revenue_floor'
        )
      );
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS brand_qualifications_segment_idx
  ON brand_qualifications(segment);

-- Trigger: when a brand_sellers row is inserted with seller_id =
-- ATVPDKIKX0DER (Amazon Retail), force classification to 'amazon' on
-- import. Users can still override via the classification UI.
CREATE OR REPLACE FUNCTION brand_sellers_auto_amazon_class()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.seller_id = 'ATVPDKIKX0DER' AND NEW.classification = 'reseller' THEN
    NEW.classification := 'amazon';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS brand_sellers_auto_amazon_class_trg ON brand_sellers;
CREATE TRIGGER brand_sellers_auto_amazon_class_trg
  BEFORE INSERT ON brand_sellers
  FOR EACH ROW
  EXECUTE FUNCTION brand_sellers_auto_amazon_class();
