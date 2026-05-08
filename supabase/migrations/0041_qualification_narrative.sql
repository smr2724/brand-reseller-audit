-- Migration 0041: Phase 50 — upgraded qualification narrative + brand-associated sellers
--
-- Adds five nullable columns to brand_qualifications. Legacy rows keep their
-- existing short icp_reasoning; only newly-run qualifications populate these.
-- See phase50_qualification_narrative_design.md for the full spec.

ALTER TABLE brand_qualifications
  ADD COLUMN IF NOT EXISTS narrative_markdown        text,
  ADD COLUMN IF NOT EXISTS brand_associated_sellers  jsonb,
    -- [{seller_name, association_type, evidence}]
    -- association_type ∈ {brand_owned, parent_owned, affiliate, licensed_distributor}
    -- Sellers NOT in this array are implicitly resellers.
  ADD COLUMN IF NOT EXISTS false_positive_flags      jsonb,
    -- [{flag, explanation}]
  ADD COLUMN IF NOT EXISTS channel_pattern           text,
    -- e.g. dealer_led_oem, split_ip_split_ops, independent_owner_operator,
    -- pe_holdco, subsidiary_of_giant; null when no obvious pattern.
  ADD COLUMN IF NOT EXISTS pitch_math                jsonb;
    -- Only populated when icp_verdict = 'qualified'. Shape:
    -- { recoverable_share_pct, recoverable_revenue_usd,
    --   blended_margin_low, blended_margin_high,
    --   incremental_profit_low_usd, incremental_profit_high_usd,
    --   defensible_pitch_number_usd, reasoning }

CREATE INDEX IF NOT EXISTS brand_qualifications_channel_pattern_idx
  ON brand_qualifications(channel_pattern);
