-- 0021 — Keepa /seller name cache
--
-- Names returned from Keepa's /seller endpoint cost 1 token per ID
-- resolved. Cache them across reports with a 30-day TTL so we don't
-- re-pay for the same seller every audit.

create table if not exists public.keepa_seller_cache (
  seller_id text primary key,
  seller_name text,
  payload jsonb,
  fetched_at timestamptz not null default now()
);

create index if not exists keepa_seller_cache_fetched_idx
  on public.keepa_seller_cache (fetched_at);

-- Service-role-only table; no RLS-exposed access path.
alter table public.keepa_seller_cache enable row level security;

drop policy if exists keepa_seller_cache_no_access on public.keepa_seller_cache;
create policy keepa_seller_cache_no_access on public.keepa_seller_cache
  for all using (false) with check (false);

COMMIT;
