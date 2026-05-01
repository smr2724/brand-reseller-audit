-- =============================================================
-- Phase 4.5 / 5.5 — DataForSEO market-demand enrichment
--
-- Adds:
--   * dataforseo_cache         (raw response cache, mirror of keepa_cache shape)
--   * brand_search_metrics     (per-brand demand snapshot — RLS, owner-scoped)
--   * reports.data_sources     (jsonb provenance for combined Keepa+DFS reports)
--
-- All operations idempotent. RLS owner-scoped (auth.uid() = user_id).
-- =============================================================
BEGIN;

-- ---------- dataforseo_cache ----------
-- Cross-user cache: a SERP for "lego star wars" is the same payload regardless
-- of which RCG user asked for it, so this table is service-role only.
create table if not exists public.dataforseo_cache (
  key         text primary key,
  payload     jsonb not null,
  fetched_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create index if not exists dataforseo_cache_expires_idx
  on public.dataforseo_cache (expires_at);

alter table public.dataforseo_cache enable row level security;

-- No anon/authenticated policies: only the service role (which bypasses RLS)
-- reads/writes this table from server code.
drop policy if exists "dataforseo_cache_no_public" on public.dataforseo_cache;
create policy "dataforseo_cache_no_public" on public.dataforseo_cache
  for select using (false);

-- ---------- brand_search_metrics ----------
create table if not exists public.brand_search_metrics (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users(id) on delete cascade,
  brand_id                 uuid not null references public.brands(id) on delete cascade,
  branded_search_volume    int,
  branded_trend_pct        numeric,        -- +/- pct change vs trailing window
  top_keywords             jsonb,          -- [{keyword, search_volume}, ...]
  competitor_brands        jsonb,          -- [{brand, share_of_serp}, ...]
  serp_positions           jsonb,          -- [{asin, keyword, position}, ...]
  organic_traffic_value    numeric,        -- estimated $ value of branded traffic
  captured_at              timestamptz not null default now()
);

create index if not exists brand_search_metrics_brand_idx
  on public.brand_search_metrics (brand_id, captured_at desc);
create index if not exists brand_search_metrics_user_idx
  on public.brand_search_metrics (user_id, captured_at desc);

alter table public.brand_search_metrics enable row level security;

drop policy if exists "brand_search_metrics_self_all" on public.brand_search_metrics;
create policy "brand_search_metrics_self_all" on public.brand_search_metrics
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- brands: cached freshness + summary columns ----------
-- Mirrors the keepa_* freshness pattern from migration 0013.
alter table public.brands add column if not exists dataforseo_last_enriched_at timestamptz;
alter table public.brands add column if not exists dataforseo_branded_volume int;
alter table public.brands add column if not exists dataforseo_branded_trend_pct numeric;
alter table public.brands add column if not exists dataforseo_competitor_count int;
alter table public.brands add column if not exists dataforseo_top_keyword text;

create index if not exists brands_user_dfs_last_enriched_idx
  on public.brands (user_id, dataforseo_last_enriched_at desc nulls last);

-- ---------- reports.data_sources ----------
-- Provenance for combined Keepa + DataForSEO reports. Shape:
--   {"keepa": true, "dataforseo": true,
--    "keepa_freshness": "2026-04-29T17:01:00Z",
--    "dataforseo_freshness": "2026-04-29T17:02:00Z"}
alter table public.reports add column if not exists data_sources jsonb;

COMMIT;
