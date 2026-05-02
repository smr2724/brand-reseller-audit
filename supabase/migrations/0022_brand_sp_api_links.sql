-- =============================================================
-- 0022 — SP-API override links for revenue-estimator v2
--
-- When a brand has a row in this table, the v2 audit pipeline pulls
-- its trailing-12mo revenue from the seller's Amazon SP-API (via the
-- `amazon_selling_partner__pipedream` external connector) instead of
-- estimating from Keepa BSR + price.
--
-- Empty/absent for cold prospects — they continue to use the Keepa
-- estimator with the recalibrated category-aware rank table.
--
-- Idempotent.
-- =============================================================

BEGIN;

create table if not exists public.brand_sp_api_links (
  brand_id uuid primary key references public.brands(id) on delete cascade,
  -- Marketplace: ATVPDKIKX0DER = Amazon US, A2EUQ1WTGCTBG2 = CA, etc.
  marketplace_id text not null default 'ATVPDKIKX0DER',
  -- Free-form connector account identifier. Today the only producer is
  -- the Pipedream-hosted `amazon_selling_partner__pipedream` connector;
  -- the value is which Pipedream account/credential it should use.
  connector_account text,
  -- Optional notes (which seller, contractual scope, etc.)
  notes text,
  configured_at timestamptz not null default now(),
  configured_by uuid references auth.users(id) on delete set null
);

alter table public.brand_sp_api_links enable row level security;

drop policy if exists brand_sp_api_links_owner_read on public.brand_sp_api_links;
create policy brand_sp_api_links_owner_read on public.brand_sp_api_links
  for select using (
    exists (
      select 1 from public.brands b
      where b.id = brand_sp_api_links.brand_id
        and b.user_id = auth.uid()
    )
  );

drop policy if exists brand_sp_api_links_owner_write on public.brand_sp_api_links;
create policy brand_sp_api_links_owner_write on public.brand_sp_api_links
  for all using (
    exists (
      select 1 from public.brands b
      where b.id = brand_sp_api_links.brand_id
        and b.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.brands b
      where b.id = brand_sp_api_links.brand_id
        and b.user_id = auth.uid()
    )
  );

COMMIT;
