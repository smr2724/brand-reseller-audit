-- =============================================================
-- Row Level Security Policies
-- Products table is SHARED across users (enriched ASIN data),
-- but all user-scoped tables are strict per-user.
-- =============================================================

alter table public.profiles enable row level security;
alter table public.scans enable row level security;
alter table public.opportunities enable row level security;
alter table public.keywords enable row level security;
alter table public.products enable row level security;
alter table public.opportunity_products enable row level security;
alter table public.notes enable row level security;
alter table public.decisions enable row level security;
alter table public.manufacturers enable row level security;
alter table public.api_logs enable row level security;

-- ---------- profiles ----------
drop policy if exists "profiles_self_select" on public.profiles;
create policy "profiles_self_select" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update" on public.profiles
  for update using (auth.uid() = id);

drop policy if exists "profiles_self_insert" on public.profiles;
create policy "profiles_self_insert" on public.profiles
  for insert with check (auth.uid() = id);

-- ---------- scans ----------
drop policy if exists "scans_self_all" on public.scans;
create policy "scans_self_all" on public.scans
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- opportunities ----------
drop policy if exists "opportunities_self_all" on public.opportunities;
create policy "opportunities_self_all" on public.opportunities
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- keywords (scoped via parent opportunity) ----------
drop policy if exists "keywords_via_opportunity" on public.keywords;
create policy "keywords_via_opportunity" on public.keywords
  for all using (
    exists (select 1 from public.opportunities o
            where o.id = opportunity_id and o.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.opportunities o
            where o.id = opportunity_id and o.user_id = auth.uid())
  );

-- ---------- products (shared read, authenticated write) ----------
drop policy if exists "products_auth_read" on public.products;
create policy "products_auth_read" on public.products
  for select using (auth.role() = 'authenticated');

drop policy if exists "products_auth_write" on public.products;
create policy "products_auth_write" on public.products
  for insert with check (auth.role() = 'authenticated');

drop policy if exists "products_auth_update" on public.products;
create policy "products_auth_update" on public.products
  for update using (auth.role() = 'authenticated');

-- ---------- opportunity_products ----------
drop policy if exists "opp_products_via_opportunity" on public.opportunity_products;
create policy "opp_products_via_opportunity" on public.opportunity_products
  for all using (
    exists (select 1 from public.opportunities o
            where o.id = opportunity_id and o.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.opportunities o
            where o.id = opportunity_id and o.user_id = auth.uid())
  );

-- ---------- notes ----------
drop policy if exists "notes_self_all" on public.notes;
create policy "notes_self_all" on public.notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- decisions ----------
drop policy if exists "decisions_self_all" on public.decisions;
create policy "decisions_self_all" on public.decisions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- manufacturers ----------
drop policy if exists "manufacturers_via_opportunity" on public.manufacturers;
create policy "manufacturers_via_opportunity" on public.manufacturers
  for all using (
    exists (select 1 from public.opportunities o
            where o.id = opportunity_id and o.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.opportunities o
            where o.id = opportunity_id and o.user_id = auth.uid())
  );

-- ---------- api_logs ----------
drop policy if exists "api_logs_self_all" on public.api_logs;
create policy "api_logs_self_all" on public.api_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
