-- Phase 39 — Seller-classification modal before report generation.
--
-- Adds a 4-bucket classification on brand_sellers (brand_owned /
-- authorized / amazon / reseller) plus per-row attribution so we know
-- who classified the row and when. Also adds a snapshot column on
-- reports so a generated report stays reproducible even if the user
-- later edits the brand_sellers rows.
--
-- IMPORTANT: This migration is created but NOT applied here. Parent
-- agent applies via Supabase MCP after PR review.

-- ---------------------------------------------------------------------
-- brand_sellers — per-row 4-bucket classification.
-- ---------------------------------------------------------------------
alter table public.brand_sellers
  add column if not exists classification text not null default 'reseller';

alter table public.brand_sellers
  add column if not exists classified_by_user_id uuid null references auth.users(id);

alter table public.brand_sellers
  add column if not exists classified_at timestamp with time zone null;

-- Validate the enum at the DB layer so a typo from an older client
-- can't slip through.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'brand_sellers_classification_check'
  ) then
    alter table public.brand_sellers
      add constraint brand_sellers_classification_check
      check (classification in ('brand_owned', 'authorized', 'amazon', 'reseller'));
  end if;
end$$;

create index if not exists brand_sellers_brand_id_classification_idx
  on public.brand_sellers (brand_id, classification);

-- Backfill from existing data. Safe to re-run because each clause is
-- guarded by the existing classification still being the default
-- ('reseller') OR matching the case we'd assign anyway.
update public.brand_sellers
   set classification = 'brand_owned'
 where is_brand_controlled = true
   and classification = 'reseller';

update public.brand_sellers
   set classification = 'amazon'
 where (seller_id = 'ATVPDKIKX0DER' or lower(coalesce(seller_name, '')) = 'amazon.com')
   and classification = 'reseller';

-- ---------------------------------------------------------------------
-- reports — snapshot of classifications + derived share buckets.
-- ---------------------------------------------------------------------
alter table public.reports
  add column if not exists seller_classifications jsonb null;

alter table public.reports
  add column if not exists brand_owned_share_pct numeric null;

alter table public.reports
  add column if not exists authorized_share_pct numeric null;

alter table public.reports
  add column if not exists amazon_share_pct numeric null;

alter table public.reports
  add column if not exists reseller_share_pct numeric null;
