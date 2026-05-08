-- Phase 53 — per-visit report view log.
--
-- The `reports` table tracks aggregate counters (`views`, `last_viewed_at`)
-- but cannot distinguish self-views from customer views, nor capture any
-- per-visit context. This adds a small append-only log so future shared
-- reports can attribute each visit (geo from Vercel headers, IP, UA) and
-- separate internal/bot traffic from real customer engagement.

CREATE TABLE IF NOT EXISTS report_views (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id    uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  viewed_at    timestamptz NOT NULL DEFAULT now(),
  ip_address   text,
  user_agent   text,
  referrer     text,
  country      text,
  city         text,
  region       text,
  is_internal  boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS report_views_report_id_idx
  ON report_views (report_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS report_views_viewed_at_idx
  ON report_views (viewed_at DESC);
