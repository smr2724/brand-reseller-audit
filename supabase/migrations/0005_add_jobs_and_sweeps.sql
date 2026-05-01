-- =============================================================
-- 0005 — jobs and sweeps tables
-- Background job queue + multi-keyword sweep grouping.
-- Idempotent: safe to re-run.
-- =============================================================

BEGIN;

-- ---------- sweeps ----------
create table if not exists public.sweeps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text,
  seed_keywords text[] not null default '{}'::text[],
  total_jobs integer not null default 0,
  complete_jobs integer not null default 0,
  failed_jobs integer not null default 0,
  status text not null default 'pending',
  notes text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

alter table public.sweeps enable row level security;

drop policy if exists users_own_sweeps on public.sweeps;
create policy users_own_sweeps on public.sweeps
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_sweeps_user on public.sweeps(user_id);
create index if not exists idx_sweeps_status on public.sweeps(status);

-- ---------- jobs ----------
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  status text not null default 'pending',
  payload jsonb not null default '{}'::jsonb,
  result_summary jsonb,
  error text,
  progress integer not null default 0,
  parent_sweep_id uuid references public.sweeps(id) on delete set null,
  related_opportunity_id uuid references public.opportunities(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

alter table public.jobs enable row level security;

drop policy if exists users_own_jobs on public.jobs;
create policy users_own_jobs on public.jobs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_jobs_user on public.jobs(user_id);
create index if not exists idx_jobs_status on public.jobs(status);
create index if not exists idx_jobs_parent_sweep on public.jobs(parent_sweep_id);
create index if not exists idx_jobs_related_opp on public.jobs(related_opportunity_id);

COMMIT;
