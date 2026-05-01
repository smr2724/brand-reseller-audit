-- =============================================================
-- Phase 6 — Decision-maker contacts + outreach drafts (copy-only)
--
-- Extends the existing CRM tables (`contacts`, `outreach_threads` from
-- migration 0007) so that contacts and outreach drafts can be associated
-- with a brand (Phase 2 brands) instead of only a supplier (Phase 1).
--
-- Adds the `contact_discovery_runs` audit log for Apollo runs.
--
-- Purely additive + idempotent — safe to re-run.
-- =============================================================

BEGIN;

-- ---------- brands: optional website (used as Apollo seed) ----------
alter table public.brands add column if not exists website text;

-- ---------- contacts: brand association + decision-maker fields ----------
-- supplier_id is `not null` in 0007 — relax it so brand-only contacts work.
alter table public.contacts alter column supplier_id drop not null;

alter table public.contacts add column if not exists brand_id uuid references public.brands(id) on delete cascade;
alter table public.contacts add column if not exists department text;            -- executive|ecommerce|marketing|operations|other
alter table public.contacts add column if not exists is_primary boolean not null default false;
alter table public.contacts add column if not exists disqualified boolean not null default false;
alter table public.contacts add column if not exists disqualified_reason text;
alter table public.contacts add column if not exists apollo_raw jsonb;

-- title, seniority, linkedin_url, phone already exist in 0007 — skip.

create index if not exists contacts_brand_idx on public.contacts(brand_id) where brand_id is not null;
create index if not exists contacts_user_brand_primary_idx on public.contacts(user_id, brand_id, is_primary);

-- ---------- outreach_threads: brand association + draft body fields ----------
-- contact_id is `not null` in 0007 — relax it to allow drafts where the
-- contact has been deleted or removed (matches the `on delete set null` semantics
-- of the new FK below).
alter table public.outreach_threads alter column contact_id drop not null;
alter table public.outreach_threads alter column supplier_id drop not null;

alter table public.outreach_threads add column if not exists brand_id uuid references public.brands(id) on delete cascade;
alter table public.outreach_threads add column if not exists body_text text;
alter table public.outreach_threads add column if not exists body_html text;
alter table public.outreach_threads add column if not exists copied_at timestamptz;
alter table public.outreach_threads add column if not exists tone text;             -- direct|curious|educational
alter table public.outreach_threads add column if not exists generation_model text;

-- subject, body, status, sent_at already exist in 0007 — skip.

create index if not exists outreach_threads_brand_idx on public.outreach_threads(brand_id) where brand_id is not null;
create index if not exists outreach_threads_user_status_idx on public.outreach_threads(user_id, status);

-- ---------- contact_discovery_runs ----------
create table if not exists public.contact_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  source text not null default 'apollo',
  status text not null,                     -- running|completed|failed|no_match
  contacts_found int,
  credits_used int,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text
);

create index if not exists contact_discovery_runs_user_brand_idx
  on public.contact_discovery_runs (user_id, brand_id, started_at desc);

alter table public.contact_discovery_runs enable row level security;

drop policy if exists contact_discovery_runs_self_all on public.contact_discovery_runs;
create policy contact_discovery_runs_self_all on public.contact_discovery_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

COMMIT;
