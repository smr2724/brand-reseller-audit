-- =============================================================
-- Legion Opportunity Scanner — Initial Schema
-- =============================================================

-- Enable required extensions
create extension if not exists "pgcrypto";

-- ---------- profiles ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  created_at timestamptz default now()
);

-- Auto-create profile row when a new auth user is created
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- scans ----------
create table if not exists public.scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  seed_keyword text not null,
  marketplace text default 'amazon_us',
  scan_depth text default 'standard',
  status text default 'pending',
  started_at timestamptz default now(),
  completed_at timestamptz,
  error_message text,
  raw_input jsonb,
  created_at timestamptz default now()
);

-- ---------- opportunities ----------
create table if not exists public.opportunities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  scan_id uuid references public.scans(id) on delete set null,
  name text,
  main_keyword text,
  category text,
  marketplace text default 'amazon_us',
  status text default 'new',
  recommended_path text,
  legion_score numeric,
  demand_score numeric,
  competition_weakness_score numeric,
  product_advantage_score numeric,
  visual_demo_score numeric,
  economics_score numeric,
  partner_score numeric,
  monthly_search_volume integer,
  total_cluster_search_volume integer,
  top_10_avg_reviews numeric,
  top_10_avg_rating numeric,
  avg_price numeric,
  summary text,
  why_excited text,
  why_skeptical text,
  product_advantage_hypothesis text,
  visual_demo_notes text,
  economics_notes text,
  partner_notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_scanned_at timestamptz
);

-- ---------- keywords ----------
create table if not exists public.keywords (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid references public.opportunities(id) on delete cascade,
  keyword text,
  search_volume integer,
  intent_type text,
  source text,
  created_at timestamptz default now()
);

-- ---------- products ----------
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  asin text,
  marketplace text default 'amazon_us',
  title text,
  brand text,
  product_url text,
  image_url text,
  category text,
  price numeric,
  rating numeric,
  review_count integer,
  bsr integer,
  is_sponsored boolean default false,
  first_seen_at timestamptz,
  last_enriched_at timestamptz,
  keepa_payload jsonb,
  dataforseo_payload jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (asin, marketplace)
);

-- ---------- opportunity_products (join) ----------
create table if not exists public.opportunity_products (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid references public.opportunities(id) on delete cascade,
  product_id uuid references public.products(id) on delete cascade,
  keyword text,
  position integer,
  organic_position integer,
  sponsored_position integer,
  listing_quality_score numeric,
  weakness_notes text,
  created_at timestamptz default now()
);

-- ---------- notes ----------
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  opportunity_id uuid references public.opportunities(id) on delete cascade,
  body text,
  created_at timestamptz default now()
);

-- ---------- decisions ----------
create table if not exists public.decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  opportunity_id uuid references public.opportunities(id) on delete cascade,
  decision text,
  reason text,
  created_at timestamptz default now()
);

-- ---------- manufacturers ----------
create table if not exists public.manufacturers (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid references public.opportunities(id) on delete cascade,
  company_name text,
  website text,
  product_line text,
  amazon_presence_notes text,
  distribution_notes text,
  fit_score numeric,
  contact_status text default 'identified',
  suggested_pitch text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---------- api_logs ----------
create table if not exists public.api_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  provider text,
  endpoint text,
  request_summary text,
  response_status text,
  cost_estimate numeric,
  tokens_used integer,
  created_at timestamptz default now()
);

-- ---------- Indexes ----------
create index if not exists idx_opportunities_user_id on public.opportunities(user_id);
create index if not exists idx_opportunities_legion_score on public.opportunities(legion_score desc);
create index if not exists idx_opportunities_status on public.opportunities(status);
create index if not exists idx_scans_user_id on public.scans(user_id);
create index if not exists idx_products_asin on public.products(asin);
create index if not exists idx_keywords_opportunity_id on public.keywords(opportunity_id);
create index if not exists idx_opportunity_products_opp on public.opportunity_products(opportunity_id);
create index if not exists idx_decisions_opportunity on public.decisions(opportunity_id);
create index if not exists idx_notes_opportunity on public.notes(opportunity_id);
create index if not exists idx_manufacturers_opp on public.manufacturers(opportunity_id);

-- ---------- updated_at triggers ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_opportunities_updated on public.opportunities;
create trigger trg_opportunities_updated before update on public.opportunities
  for each row execute function public.set_updated_at();

drop trigger if exists trg_products_updated on public.products;
create trigger trg_products_updated before update on public.products
  for each row execute function public.set_updated_at();

drop trigger if exists trg_manufacturers_updated on public.manufacturers;
create trigger trg_manufacturers_updated before update on public.manufacturers
  for each row execute function public.set_updated_at();
