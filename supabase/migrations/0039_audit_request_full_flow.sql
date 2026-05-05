-- Phase 43 — Client-facing audit-request 4-step flow.
--
-- Adds the columns needed to support the wizard (verify brand → classify
-- sellers → contact → auto-generate → email with cc):
--
-- 1. leads — extra contact fields, classification timing, email-send
--    confirmation (Resend message id + cc capture).
-- 2. leads — flow_version flag so admin app can distinguish public-flow
--    leads from legacy single-submit leads.
-- 3. brand_sellers — `classified_by_audit_request_id` so public-flow
--    classifications don't get conflated with the admin-side
--    `classified_by_user_id` attribution.
--
-- IMPORTANT: This migration is created but NOT applied here. Parent
-- agent applies via Supabase MCP after PR review.

-- ---------------------------------------------------------------------
-- leads — public-flow contact + email-confirmation columns.
-- ---------------------------------------------------------------------
alter table public.leads
  add column if not exists website text null;

alter table public.leads
  add column if not exists approx_amazon_revenue text null;

alter table public.leads
  add column if not exists classification_completed_at timestamp with time zone null;

alter table public.leads
  add column if not exists email_sent_at timestamp with time zone null;

alter table public.leads
  add column if not exists resend_message_id text null;

alter table public.leads
  add column if not exists email_cc text null;

alter table public.leads
  add column if not exists flow_version text null;

-- Lead-side public-flow token (separate from email_verify_token_hash so
-- the wizard's API calls can authenticate against an in-progress lead
-- without burning the email-verify token). Stored as the SHA-256 hex of
-- the random secret; the plain token only lives on the wizard client.
alter table public.leads
  add column if not exists flow_token_hash text null;

create index if not exists leads_flow_token_hash_idx
  on public.leads (flow_token_hash);

-- ---------------------------------------------------------------------
-- brand_sellers — track public-flow classification attribution.
-- ---------------------------------------------------------------------
alter table public.brand_sellers
  add column if not exists classified_by_audit_request_id uuid null
    references public.leads(id) on delete set null;

create index if not exists brand_sellers_classified_by_audit_request_id_idx
  on public.brand_sellers (classified_by_audit_request_id);
