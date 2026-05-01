-- =============================================================
-- 0008 — reports + email-sequence columns on outreach_threads
-- Adds public-shareable report tokens and 5-step sequence tracking.
-- Idempotent: safe to re-run.
-- =============================================================

BEGIN;

-- ---------- reports ----------
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  views integer not null default 0,
  last_viewed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.reports enable row level security;

drop policy if exists reports_owner_all on public.reports;
create policy reports_owner_all on public.reports
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists reports_public_read on public.reports;
create policy reports_public_read on public.reports
  for select to anon
  using (true);

create index if not exists idx_reports_user on public.reports(user_id);
create index if not exists idx_reports_supplier on public.reports(supplier_id);
create index if not exists idx_reports_opportunity on public.reports(opportunity_id);
create index if not exists idx_reports_token on public.reports(token);

-- ---------- outreach_threads: step + template_key ----------
alter table public.outreach_threads
  add column if not exists step smallint;

alter table public.outreach_threads
  add column if not exists template_key text;

-- step must be 1..5 (matches live outreach_threads_step_check)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'outreach_threads_step_check'
      and conrelid = 'public.outreach_threads'::regclass
  ) then
    alter table public.outreach_threads
      add constraint outreach_threads_step_check
      check (step is null or (step between 1 and 5));
  end if;
end $$;

COMMIT;
