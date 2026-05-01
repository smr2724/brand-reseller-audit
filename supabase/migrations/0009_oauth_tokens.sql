-- =============================================================
-- 0009 — oauth_tokens
-- Stores per-user OAuth tokens (e.g. Microsoft Graph for Outlook).
-- Idempotent: safe to re-run.
-- =============================================================

BEGIN;

create table if not exists public.oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  account_email text,
  access_token text not null,
  refresh_token text not null,
  scope text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint oauth_tokens_user_id_provider_key unique (user_id, provider)
);

alter table public.oauth_tokens enable row level security;

drop policy if exists oauth_tokens_owner_all on public.oauth_tokens;
create policy oauth_tokens_owner_all on public.oauth_tokens
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_oauth_tokens_user on public.oauth_tokens(user_id);

drop trigger if exists trg_oauth_tokens_updated on public.oauth_tokens;
create trigger trg_oauth_tokens_updated before update on public.oauth_tokens
  for each row execute function public.set_updated_at();

COMMIT;
