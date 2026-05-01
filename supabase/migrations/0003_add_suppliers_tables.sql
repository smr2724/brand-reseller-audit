-- =============================================================
-- 0003 — suppliers, opportunity_suppliers, supplier_scans
-- Adds the supplier/manufacturer scanning data model.
-- Idempotent: safe to re-run.
-- =============================================================

BEGIN;

-- ---------- suppliers ----------
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_name text not null,
  website text,
  domain text,
  hq_city text,
  hq_state text,
  hq_country text,
  geo_tier text,
  geo_score integer default 0,
  sells_on_amazon boolean,
  amazon_evidence text,
  not_on_amazon_score integer default 0,
  is_manufacturer boolean default true,
  channel_type text,
  turnkey_score integer default 0,
  quality_score integer default 0,
  reachability_score integer default 0,
  contact_email text,
  contact_phone text,
  contact_form_url text,
  product_lines text[],
  industries text[],
  description text,
  founded_year integer,
  employee_estimate text,
  evidence jsonb default '{}'::jsonb,
  raw_search_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint suppliers_user_id_domain_key unique (user_id, domain)
);

alter table public.suppliers enable row level security;

drop policy if exists users_own_suppliers on public.suppliers;
create policy users_own_suppliers on public.suppliers
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_suppliers_user_id on public.suppliers(user_id);
create index if not exists idx_suppliers_domain on public.suppliers(domain);

drop trigger if exists trg_suppliers_updated on public.suppliers;
create trigger trg_suppliers_updated before update on public.suppliers
  for each row execute function public.set_updated_at();

-- ---------- opportunity_suppliers (join + per-opp scoring) ----------
create table if not exists public.opportunity_suppliers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  supplier_score integer not null,
  recommended_path text,
  fit_summary text,
  why_excited text,
  why_skeptical text,
  outreach_angle text,
  ranked_position integer,
  created_at timestamptz not null default now(),
  constraint opportunity_suppliers_opportunity_id_supplier_id_key unique (opportunity_id, supplier_id)
);

alter table public.opportunity_suppliers enable row level security;

drop policy if exists users_own_opp_suppliers on public.opportunity_suppliers;
create policy users_own_opp_suppliers on public.opportunity_suppliers
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_opp_suppliers_opportunity on public.opportunity_suppliers(opportunity_id);
create index if not exists idx_opp_suppliers_supplier on public.opportunity_suppliers(supplier_id);
create index if not exists idx_opp_suppliers_user on public.opportunity_suppliers(user_id);

-- ---------- supplier_scans ----------
create table if not exists public.supplier_scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  status text not null default 'pending',
  started_at timestamptz default now(),
  completed_at timestamptz,
  candidates_found integer default 0,
  candidates_qualified integer default 0,
  error text,
  raw_input jsonb,
  created_at timestamptz not null default now()
);

alter table public.supplier_scans enable row level security;

drop policy if exists users_own_supplier_scans on public.supplier_scans;
create policy users_own_supplier_scans on public.supplier_scans
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_supplier_scans_opportunity on public.supplier_scans(opportunity_id);
create index if not exists idx_supplier_scans_user on public.supplier_scans(user_id);

COMMIT;
