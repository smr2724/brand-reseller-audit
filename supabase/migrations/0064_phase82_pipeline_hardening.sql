-- Phase 82 — Bulk Pipeline Hardening + Keepa Batching
--
-- Schema additions for:
--   • Bulk pipeline janitor (counts re-kicks, last-kick timestamp, and a
--     partial index that keeps the janitor's "running > 90s" sweep cheap).
--   • Keepa enrichment hardening — brands.enrichment_metadata jsonb stores
--     `enrichment_truncated_at` (and `total_asins_seen`) when a brand's
--     catalog exceeds the 500-ASIN cap.
--
-- Already applied to Supabase project qbgchatkwaqpbvxsramw on 2026-05-16.
-- This file is committed for parity with the applied DDL; every statement
-- uses `if not exists` so re-running is safe.

alter table bulk_runs
  add column if not exists janitor_kick_count integer not null default 0,
  add column if not exists last_janitor_kick_at timestamptz;

create index if not exists bulk_runs_running_idx
  on bulk_runs(updated_at)
  where status = 'running';

alter table brands
  add column if not exists enrichment_metadata jsonb default '{}'::jsonb;
