-- Phase 34 — capture Keepa's `monthlySold` field on `brand_asins`.
--
-- Amazon publishes an "X+ bought in past month" badge on PDPs in tiered
-- buckets (50, 100, 200, 500, 1000, 2000, 5000+). Keepa surfaces this as
-- `monthlySold`. Phase 34 prefers this value over the BSR-curve estimate
-- when present (with `Math.max(fromKeepa, fromCurve)` as a defensive
-- floor in case Amazon temporarily strips a badge from a high-velocity
-- ASIN). The new column persists the raw published value so reports can
-- audit per-ASIN whether the badge or the curve was the source.

ALTER TABLE brand_asins
  ADD COLUMN IF NOT EXISTS keepa_monthly_sold integer;

COMMENT ON COLUMN brand_asins.keepa_monthly_sold IS
  'Amazon-published "X+ bought in past month" floor as reported by Keepa. Null when not published. See Phase 34.';
