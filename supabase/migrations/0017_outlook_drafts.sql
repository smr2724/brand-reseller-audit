-- =============================================================
-- 0017 — Outlook drafts for Phase 6.5
--
-- Adds Microsoft Graph draft-tracking columns on outreach_threads so the
-- "Send to Outlook Drafts" + "Email the Report" buttons can persist the
-- created draft's id / web link, and a report_id back-reference for
-- report-followup threads.
--
-- Idempotent: safe to re-run.
-- =============================================================

BEGIN;

alter table public.outreach_threads
  add column if not exists outlook_message_id text;

alter table public.outreach_threads
  add column if not exists outlook_web_link text;

alter table public.outreach_threads
  add column if not exists drafted_in_outlook_at timestamptz;

-- Back-reference the report a follow-up draft is attached to, so the UI can
-- find the report-followup thread for a given report.
alter table public.outreach_threads
  add column if not exists report_id uuid references public.reports(id) on delete set null;

create index if not exists outreach_threads_report_idx
  on public.outreach_threads(report_id)
  where report_id is not null;

-- `status` is a free-form text column (no check constraint), so the new
-- value `drafted_in_outlook` is allowed without further DDL.

COMMIT;
