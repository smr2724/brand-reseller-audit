-- Phase 31 — variation-aware sales attribution.
--
-- Per-ASIN revenue estimates were over-counting sales for variation
-- siblings (parent ASIN with multiple child ASINs like 4-pack / 12-pack
-- / pallet). Amazon's catalog often shares sales rank across child
-- variations, so Keepa's monthlySold-equivalent estimator returns the
-- same number for every child even when only one or two actually drive
-- sales. We now group children by parent_asin, take the max (not sum)
-- as the group's monthly volume, and distribute that volume across
-- siblings in proportion to recent review activity.
--
-- New columns persisted on `brand_asins`:
--   parent_asin            — Keepa parentAsin; null for singletons
--   variation_group_size   — number of siblings sharing this parent (incl. self)
--   variation_weight       — review-velocity weight (0..1); 1.0 for singletons
--   recent_review_count    — 90-day review delta (or total when no history)
--   raw_monthly_units      — pre-attribution monthly-units estimate from Keepa
--   attributed_monthly_units — post-attribution number consumed by the
--                              revenue estimator and per-ASIN cards

ALTER TABLE brand_asins ADD COLUMN IF NOT EXISTS parent_asin text;
ALTER TABLE brand_asins ADD COLUMN IF NOT EXISTS variation_group_size integer;
ALTER TABLE brand_asins ADD COLUMN IF NOT EXISTS variation_weight numeric;
ALTER TABLE brand_asins ADD COLUMN IF NOT EXISTS recent_review_count integer;
ALTER TABLE brand_asins ADD COLUMN IF NOT EXISTS raw_monthly_units numeric;
ALTER TABLE brand_asins ADD COLUMN IF NOT EXISTS attributed_monthly_units numeric;

-- Index for parent_asin lookups within a brand (variation grouping).
CREATE INDEX IF NOT EXISTS idx_brand_asins_brand_parent
  ON brand_asins (brand_id, parent_asin)
  WHERE parent_asin IS NOT NULL;
