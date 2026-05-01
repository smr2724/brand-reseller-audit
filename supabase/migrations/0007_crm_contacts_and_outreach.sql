-- =============================================================
-- 0007 — CRM: contacts + outreach_threads
-- Contacts enriched from Apollo, plus per-contact outreach threads.
-- Idempotent: safe to re-run.
-- =============================================================

BEGIN;

-- ---------- contacts ----------
create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  full_name text not null,
  first_name text,
  last_name text,
  title text,
  seniority text,
  departments text[],
  email text,
  email_status text,
  linkedin_url text,
  phone text,
  city text,
  state text,
  country text,
  apollo_person_id text unique,
  source text not null default 'apollo',
  enriched_at timestamptz,
  ai_priority_rank integer,
  ai_priority_reason text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.contacts enable row level security;

drop policy if exists contacts_owner on public.contacts;
create policy contacts_owner on public.contacts
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_contacts_user on public.contacts(user_id);
create index if not exists idx_contacts_supplier on public.contacts(supplier_id);
create index if not exists idx_contacts_apollo_person_id on public.contacts(apollo_person_id);

drop trigger if exists trg_contacts_updated on public.contacts;
create trigger trg_contacts_updated before update on public.contacts
  for each row execute function public.set_updated_at();

-- ---------- outreach_threads ----------
create table if not exists public.outreach_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  opportunity_id uuid references public.opportunities(id) on delete set null,
  status text not null default 'draft',
  subject text,
  body text,
  outlook_draft_id text,
  outlook_web_link text,
  sent_at timestamptz,
  replied_at timestamptz,
  last_action_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.outreach_threads enable row level security;

drop policy if exists outreach_owner on public.outreach_threads;
create policy outreach_owner on public.outreach_threads
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_outreach_user on public.outreach_threads(user_id);
create index if not exists idx_outreach_contact on public.outreach_threads(contact_id);
create index if not exists idx_outreach_supplier on public.outreach_threads(supplier_id);
create index if not exists idx_outreach_opportunity on public.outreach_threads(opportunity_id);

COMMIT;
