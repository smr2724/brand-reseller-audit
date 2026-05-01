-- =============================================================
-- 0019 — Audit Report v2 (sales-weapon rebuild)
--
-- Adds per-report jsonb storage so the v2 generator can persist:
--   • report_assumptions    — every numeric assumption that drives the
--                             "Math" section (margin %, MCF uplift, etc.)
--                             Editable per-prospect after generation.
--   • competitor_benchmark  — the 4-row competitor comparison table.
--   • reseller_dossier      — top reseller profile (risk, ASINs, mix).
--   • cx_audit              — listing scores, screenshots, callouts.
--
-- Plus a cross-user cache table for competitor brand snapshots so we
-- amortize Keepa cost across many reports.
--
-- Idempotent.
-- =============================================================

BEGIN;

alter table public.reports add column if not exists report_assumptions jsonb;
alter table public.reports add column if not exists competitor_benchmark jsonb;
alter table public.reports add column if not exists reseller_dossier jsonb;
alter table public.reports add column if not exists cx_audit jsonb;

create table if not exists public.competitor_brands_cache (
  id uuid primary key default gen_random_uuid(),
  brand_name_norm text not null unique,
  display_name text not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days')
);

create index if not exists competitor_brands_cache_expires_idx
  on public.competitor_brands_cache (expires_at);

-- Service-role-only table; no RLS-exposed access path.
alter table public.competitor_brands_cache enable row level security;

drop policy if exists competitor_brands_cache_no_access on public.competitor_brands_cache;
create policy competitor_brands_cache_no_access on public.competitor_brands_cache
  for all using (false) with check (false);

COMMIT;
