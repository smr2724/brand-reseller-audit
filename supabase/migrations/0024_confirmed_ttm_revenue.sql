-- Phase 28 — Optional confirmed TTM revenue input.
--
-- Lets a user override the Keepa/price-only estimator with a known-good
-- revenue number from a trusted source (Orion data, seller-shared,
-- internal warehouse). When set, all downstream math (reseller_margin,
-- delta_profit, exit_lift, capture plan, DIY recoverable) uses the
-- confirmed value. The estimator still runs as a sanity-check note.

alter table public.brands
  add column if not exists confirmed_ttm_revenue_dollars numeric;

alter table public.brands
  add column if not exists confirmed_ttm_source text;

alter table public.brands
  add column if not exists confirmed_ttm_set_at timestamptz;
