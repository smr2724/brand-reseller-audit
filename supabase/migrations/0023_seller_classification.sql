-- Phase 23 — Smarter seller-to-brand classification.
--
-- Adds per-seller classification fields so we can mark Fantaswick LLC
-- as brand_controlled (it's the brand's own selling entity) without
-- relying on exact-string matches against the brand name.

alter table public.brand_sellers
  add column if not exists is_brand_controlled boolean;

alter table public.brand_sellers
  add column if not exists classification_reason text;

-- Phase 23 — Amazon-1P disqualifier short-circuits report generation,
-- producing a "not a fit" page instead of the standard audit. We treat
-- this as a distinct report status so the recovery cron skips it.
-- (No enum constraint on reports.status today — it's plain text — so
-- no DDL change is required for the new value. This comment is the
-- source of truth.)
