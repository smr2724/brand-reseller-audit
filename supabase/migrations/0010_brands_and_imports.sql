-- =============================================================
-- Phase 2: Brands + Imports
-- Idempotent. User-scoped. RLS enforced via auth.uid().
-- =============================================================
begin;

-- ---------- brands ----------
create table if not exists public.brands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  name_normalized text not null,
  category text,

  -- SmartScout signal columns
  brand_score numeric,
  est_monthly_revenue numeric,
  trailing_12_months numeric,
  avg_sellers numeric,
  avg_fba_sellers numeric,
  dominant_seller_sales_pct numeric,
  dominant_seller_country text,
  dominant_seller_name text,
  has_storefront boolean,
  total_products int,

  -- Growth metrics
  monthly_growth_pct numeric,
  trailing_12_growth_pct numeric,

  -- Initial-Targets overlay
  manual_notes text,
  outreach_activity text,
  current_profit numeric,
  resellers_margin numeric,
  recouped_shipping numeric,
  labor_cost numeric,
  additional_profit numeric,
  rcg_fees numeric,
  new_profit numeric,
  seven_x_multiple_value numeric,

  disqualifier_tags text[] not null default '{}',
  status text not null default 'new',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, name_normalized)
);

create index if not exists brands_user_status_idx on public.brands (user_id, status);
create index if not exists brands_user_name_norm_idx on public.brands (user_id, name_normalized);

-- ---------- brand_asins (Phase 4 placeholder) ----------
create table if not exists public.brand_asins (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  asin text not null,
  title text,
  buy_box_seller text,
  offers_count int,
  last_checked_at timestamptz,
  unique (brand_id, asin)
);

-- ---------- brand_sellers (Phase 4 placeholder) ----------
create table if not exists public.brand_sellers (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  seller_name text,
  seller_country text,
  share_pct numeric,
  last_seen_at timestamptz
);

-- ---------- imports ----------
create table if not exists public.imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  filename text not null,
  source_type text not null,
  row_count int,
  inserted_count int,
  updated_count int,
  skipped_count int,
  status text not null default 'pending',
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists imports_user_created_idx on public.imports (user_id, created_at desc);

-- ---------- import_column_mappings ----------
create table if not exists public.import_column_mappings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_type text not null,
  source_column text not null,
  target_field text not null,
  unique (user_id, source_type, source_column)
);

-- ---------- RLS ----------
alter table public.brands enable row level security;
alter table public.brand_asins enable row level security;
alter table public.brand_sellers enable row level security;
alter table public.imports enable row level security;
alter table public.import_column_mappings enable row level security;

drop policy if exists "brands_self_all" on public.brands;
create policy "brands_self_all" on public.brands
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "brand_asins_via_brand" on public.brand_asins;
create policy "brand_asins_via_brand" on public.brand_asins
  for all using (
    exists (select 1 from public.brands b where b.id = brand_id and b.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.brands b where b.id = brand_id and b.user_id = auth.uid())
  );

drop policy if exists "brand_sellers_via_brand" on public.brand_sellers;
create policy "brand_sellers_via_brand" on public.brand_sellers
  for all using (
    exists (select 1 from public.brands b where b.id = brand_id and b.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.brands b where b.id = brand_id and b.user_id = auth.uid())
  );

drop policy if exists "imports_self_all" on public.imports;
create policy "imports_self_all" on public.imports
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "import_column_mappings_self_all" on public.import_column_mappings;
create policy "import_column_mappings_self_all" on public.import_column_mappings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

commit;
