-- 0062_phase81_api_costs.sql
-- Phase 81 — Bulk Run Cost Transparency.
-- Already applied to production via Supabase connector; this file exists
-- so the schema change is tracked in git. Idempotent.
create table if not exists api_costs (
  id uuid primary key default gen_random_uuid(),
  bulk_run_id uuid references bulk_runs(id) on delete cascade,
  bulk_run_brand_id uuid references bulk_run_brands(id) on delete cascade,
  brand_id uuid references brands(id) on delete set null,
  provider text not null,                  -- keepa | apollo | hunter | million_verifier | openai | resend
  operation text not null,                 -- keepa_product | apollo_people_match | ...
  units numeric(12,4) not null default 0,  -- tokens / credits / verifications
  cost_usd numeric(10,4) not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists api_costs_bulk_run_id_idx on api_costs(bulk_run_id);
create index if not exists api_costs_bulk_run_brand_id_idx on api_costs(bulk_run_brand_id);
create index if not exists api_costs_brand_id_idx on api_costs(brand_id);
create index if not exists api_costs_created_at_idx on api_costs(created_at desc);

alter table api_costs enable row level security;

-- Service role only (no end-user read). Admin-facing reads are server-side under service key.
drop policy if exists api_costs_service_role_all on api_costs;
create policy api_costs_service_role_all on api_costs
  for all to service_role using (true) with check (true);

-- Per-brand and per-run rollup columns (denormalized for fast reads).
alter table bulk_run_brands
  add column if not exists cost_total_usd numeric(10,4) not null default 0,
  add column if not exists cost_breakdown jsonb;  -- {"keepa":0.0014,"apollo":0.04,...}

alter table bulk_runs
  add column if not exists cost_total_usd numeric(10,4) not null default 0;
