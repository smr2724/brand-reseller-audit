-- Phase 32 — Buy Box win frequency for variation attribution.
--
-- Phase 31 attributed group-level sales across variation siblings using
-- review velocity. Reviews proved too noisy in practice: pallet listings
-- accumulate legacy review counts comparable to active small-pack
-- siblings (Amazon often shows reviews at parent level), so dormant
-- pallets still received material attribution and produced phantom
-- TTM revenue. Buy Box win frequency is a sharper "what actually sold
-- recently" signal — a pallet that hasn't moved in months has zero
-- Buy Box winner changes while an active 4-pack flips frequently.
--
-- New column on `brand_asins`:
--   buy_box_change_count_90d
--     Count of distinct Buy Box winner changes in the last 90 days,
--     derived from Keepa csv[32] (seller-id history) with csv[18]
--     (BB shipping-price history) as fallback. NULL when neither
--     series is present (no recent offers / no winner).

ALTER TABLE brand_asins
  ADD COLUMN IF NOT EXISTS buy_box_change_count_90d integer;
