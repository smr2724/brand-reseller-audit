-- =============================================================
-- 0018 — Backfill `reports.token` for any rows missing one.
--
-- Phase 1 made `token` nullable (0014); brand-audit reports that pre-date
-- Phase 6.7's public /r/[token] page may have been inserted without a token.
-- The new public report page keys off `token`, so every reports row needs one.
--
-- The /api/reports/generate route always inserts a fresh token going forward;
-- this migration is purely a one-time backfill. Idempotent.
-- =============================================================

BEGIN;

update public.reports
set token = encode(gen_random_bytes(18), 'base64')
where token is null;

create index if not exists reports_token_idx on public.reports (token);

COMMIT;
