-- =============================================================
-- 0011 — leads
-- Captures public form submissions from the marketing site
-- (Channel Ownership Audit requests, contact form, etc.).
-- Idempotent: safe to re-run.
-- =============================================================

BEGIN;

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  brand_name text not null,
  contact_name text,
  email text not null,
  website text,
  wholesale_price numeric,
  note text,
  source_page text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  status text not null default 'new',
  created_at timestamptz not null default now()
);

create index if not exists idx_leads_created_at on public.leads (created_at desc);
create index if not exists idx_leads_status on public.leads (status);
create index if not exists idx_leads_email on public.leads (email);

alter table public.leads enable row level security;

-- No public read or write. The /api/leads route uses the service role
-- key to insert on behalf of unauthenticated visitors. Service role
-- bypasses RLS, so we deliberately do NOT define any policies that
-- grant access to anon or authenticated roles here.
drop policy if exists leads_no_public_read on public.leads;
drop policy if exists leads_no_public_write on public.leads;

COMMIT;
