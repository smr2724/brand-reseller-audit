-- =============================================================
-- Phase 4: Keepa marketplace validation pipeline
-- Idempotent. User-scoped. RLS enforced via auth.uid().
-- =============================================================
begin;

-- ---------- brand_asins extensions ----------
alter table public.brand_asins add column if not exists buy_box_price numeric;
alter table public.brand_asins add column if not exists fba_offers_count int;
alter table public.brand_asins add column if not exists is_brand_controlled boolean;
alter table public.brand_asins add column if not exists amazon_price_history jsonb;

-- ---------- brand_sellers extensions ----------
alter table public.brand_sellers add column if not exists asins_won int default 0;
alter table public.brand_sellers add column if not exists is_fba boolean;
alter table public.brand_sellers add column if not exists seller_id text;

-- ---------- brands enrichment summary ----------
alter table public.brands add column if not exists keepa_last_enriched_at timestamptz;
alter table public.brands add column if not exists keepa_asin_count int;
alter table public.brands add column if not exists keepa_unique_seller_count int;
alter table public.brands add column if not exists keepa_brand_controlled_pct numeric;
alter table public.brands add column if not exists keepa_top_seller text;
alter table public.brands add column if not exists keepa_top_seller_share_pct numeric;
alter table public.brands add column if not exists keepa_avg_offers numeric;
alter table public.brands add column if not exists validation_score numeric;
alter table public.brands add column if not exists enrichment_error text;

create index if not exists brands_user_validation_score_idx
  on public.brands (user_id, validation_score desc nulls last);
create index if not exists brands_user_keepa_last_enriched_idx
  on public.brands (user_id, keepa_last_enriched_at desc nulls last);

-- ---------- enrichment_runs ----------
create table if not exists public.enrichment_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  source text not null,
  status text not null,
  tokens_used int,
  asins_found int,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text
);

create index if not exists enrichment_runs_user_brand_idx
  on public.enrichment_runs (user_id, brand_id, started_at desc);
create index if not exists enrichment_runs_user_started_idx
  on public.enrichment_runs (user_id, started_at desc);

alter table public.enrichment_runs enable row level security;

drop policy if exists "enrichment_runs_self_all" on public.enrichment_runs;
create policy "enrichment_runs_self_all" on public.enrichment_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

commit;
