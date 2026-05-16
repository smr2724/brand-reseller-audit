-- Migration 0061: Add economics_status flag to surface low-revenue / tight-channel
-- brands whose computed seven_x_multiple_value is non-positive (clamped to $0).
--
-- Phase 80 — Brands like Lemax (~$34K annual revenue) and Sport-Tek (~$40K)
-- produce negative delta_profit because recoverable_revenue × 0.10500 net margin
-- can't clear the tiered labor floor ($30K/$130K/$250K). Persisting
-- additional_profit / seven_x_multiple_value as negative numbers showed up as
-- nonsensical "$-178K opportunity" rows in the bulk report. The persistence
-- layer now clamps both columns to 0 and surfaces the underlying reason via
-- this new flag instead.
--
-- Allowed values:
--   'healthy'       — positive delta_profit; normal recapture economics
--   'low_revenue'   — brand is too small to clear the labor floor (default fallback)
--   'tight_channel' — brand_controlled_pct ≥ 0.95 so there's nothing recoverable

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS economics_status text
    CHECK (
      economics_status IN ('healthy', 'low_revenue', 'tight_channel')
      OR economics_status IS NULL
    );

ALTER TABLE bulk_run_brands
  ADD COLUMN IF NOT EXISTS economics_status text
    CHECK (
      economics_status IN ('healthy', 'low_revenue', 'tight_channel')
      OR economics_status IS NULL
    );

-- Backfill existing brand rows from already-persisted economics:
--   seven_x_multiple_value > 0  → 'healthy'
--   seven_x_multiple_value <= 0 AND est_monthly_revenue * 12 < $200K → 'low_revenue'
--   seven_x_multiple_value <= 0 (everything else)  → 'tight_channel'
-- We can't read the original brand_controlled_pct here, so we use the revenue
-- floor as the primary classifier and let 'tight_channel' be the residual.
UPDATE brands
SET economics_status = CASE
  WHEN seven_x_multiple_value IS NULL THEN NULL
  WHEN seven_x_multiple_value > 0 THEN 'healthy'
  WHEN COALESCE(est_monthly_revenue, 0) * 12 < 200000 THEN 'low_revenue'
  ELSE 'tight_channel'
END
WHERE economics_status IS NULL
  AND seven_x_multiple_value IS NOT NULL;
