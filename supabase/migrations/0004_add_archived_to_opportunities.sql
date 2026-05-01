-- =============================================================
-- 0004 — add archived_at to opportunities
-- Idempotent: safe to re-run.
-- =============================================================

BEGIN;

alter table public.opportunities
  add column if not exists archived_at timestamptz;

create index if not exists idx_opportunities_archived_at on public.opportunities(archived_at);

COMMIT;
