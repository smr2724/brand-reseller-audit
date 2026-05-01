-- =============================================================
-- 0006 — add archived_at to suppliers
-- Idempotent: safe to re-run.
-- =============================================================

BEGIN;

alter table public.suppliers
  add column if not exists archived_at timestamptz;

create index if not exists idx_suppliers_archived_at on public.suppliers(archived_at);

COMMIT;
