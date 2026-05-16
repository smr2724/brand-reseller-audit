-- Migration 0059: Phase 75 — Bulk brand pipeline.
--
-- Two new tables back the bulk-paste pipeline:
--
--   bulk_runs         — one row per paste session (status, totals,
--                       which user kicked it off, when the summary
--                       email went out).
--   bulk_run_brands   — one row per brand from the input list.
--                       Tracks the per-brand state machine the worker
--                       drives (keepa_searching → keepa_enriching →
--                       qualifying → resolving_owner → discovering_contacts
--                       → verifying_email → drafting → completed),
--                       plus the terminal-outcome columns surfaced in
--                       the in-app ranked report and the email.
--
-- RLS mirrors the convention already used by `brands` (owner-only via
-- auth.uid = user_id) and `brand_*` child tables (scoped via parent
-- bulk_run row). Background writes happen through the service-role
-- client which bypasses RLS, same as the rest of the pipeline.

begin;

create table if not exists public.bulk_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  total_brands integer not null,
  brands_completed integer not null default 0,
  current_brand_id uuid references public.brands(id) on delete set null,
  current_brand_name text,
  started_at timestamptz default now(),
  completed_at timestamptz,
  report_email_sent_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_bulk_runs_status
  on public.bulk_runs (status) where status in ('pending', 'running');
create index if not exists idx_bulk_runs_user_created
  on public.bulk_runs (user_id, created_at desc);

create table if not exists public.bulk_run_brands (
  id uuid primary key default gen_random_uuid(),
  bulk_run_id uuid not null references public.bulk_runs(id) on delete cascade,
  position integer not null,
  input_name text not null,

  brand_id uuid references public.brands(id) on delete set null,

  status text not null default 'queued'
    check (status in (
      'queued',
      'keepa_searching',
      'keepa_not_found',
      'keepa_enriching',
      'qualifying',
      'disqualified',
      'resolving_owner',
      'discovering_contacts',
      'verifying_email',
      'drafting',
      'completed',
      'error'
    )),

  progress_percent integer not null default 0
    check (progress_percent between 0 and 100),
  current_step_label text,

  qualified boolean,
  disqualification_reason text,
  selected_entity_name text,
  resolved_owner_domain text,
  contact_name text,
  contact_email text,
  email_verifier text,
  -- email_status: contact email verification result. Upstream values are
  -- normalized to 'verified' by the Phase 73 contact orchestrator. The legacy
  -- MV enum is 'valid' | 'invalid' | 'risky' | 'unknown'. See
  -- DRAFT_ELIGIBLE_EMAIL_STATUSES in src/lib/bulk/worker.ts for which values
  -- trigger a draft.
  email_status text,
  outlook_draft_id text,
  outlook_draft_web_link text,
  legion_score numeric,
  legion_opportunity numeric,

  error_message text,
  error_step text,
  retry_count integer not null default 0,

  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_bulk_run_brands_run_position
  on public.bulk_run_brands (bulk_run_id, position);
create index if not exists idx_bulk_run_brands_brand
  on public.bulk_run_brands (brand_id);
create index if not exists idx_bulk_run_brands_run_status
  on public.bulk_run_brands (bulk_run_id, status);

alter table public.bulk_runs enable row level security;
alter table public.bulk_run_brands enable row level security;

drop policy if exists "bulk_runs_self_all" on public.bulk_runs;
create policy "bulk_runs_self_all" on public.bulk_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "bulk_run_brands_via_run" on public.bulk_run_brands;
create policy "bulk_run_brands_via_run" on public.bulk_run_brands
  for all using (
    exists (
      select 1 from public.bulk_runs r
      where r.id = bulk_run_id and r.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.bulk_runs r
      where r.id = bulk_run_id and r.user_id = auth.uid()
    )
  );

commit;
