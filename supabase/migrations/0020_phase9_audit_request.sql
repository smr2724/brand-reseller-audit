-- =============================================================
-- Phase 9 — Brand Lookup by Name + Public Audit Request
-- Extends `leads` for a verified, queued audit pipeline; adds
-- `brand_lookup_cache` to keep Keepa token spend off the hot path
-- of the internal Add-Brand-by-Name flow; adds a Supabase-backed
-- `audit_request_rate_limits` store for per-email / per-IP /
-- global daily quotas; adds `public_audit_request_log` so every
-- public submission (including rejects) is persisted for monitoring.
-- Idempotent: safe to re-run.
-- =============================================================

BEGIN;

-- ---------- leads extensions ----------
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS requested_brand_name TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS audit_status TEXT DEFAULT 'pending';
  -- pending_verification | pending | matching | not_found | enriching | generating_report | report_ready | sent | failed
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS report_id UUID REFERENCES public.reports(id);
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id);
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS audit_requested_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS audit_completed_at TIMESTAMPTZ;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS audit_email_sent_at TIMESTAMPTZ;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';
  -- manual | public_audit_request | import
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS email_verify_token_hash TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS email_verify_expires_at TIMESTAMPTZ;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS pain_point TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS ip_address TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS outlook_draft_id TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_audit_status ON public.leads(audit_status);
CREATE INDEX IF NOT EXISTS idx_leads_email_verify_token ON public.leads(email_verify_token_hash);

-- ---------- Keepa brand-lookup cache (24h TTL, cross-user) ----------
CREATE TABLE IF NOT EXISTS public.brand_lookup_cache (
  query TEXT PRIMARY KEY,
  keepa_results JSONB NOT NULL,
  result_count INT NOT NULL DEFAULT 0,
  fetched_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_brand_lookup_cache_fetched ON public.brand_lookup_cache(fetched_at);

-- ---------- Public audit request rate-limits ----------
CREATE TABLE IF NOT EXISTS public.audit_request_rate_limits (
  key TEXT PRIMARY KEY,           -- "email:foo@x.com" | "ip:1.2.3.4" | "global:2026-05-01"
  count INT NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ DEFAULT NOW()
);

-- ---------- Public submission audit log (for monitoring abuse) ----------
CREATE TABLE IF NOT EXISTS public.public_audit_request_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  brand_name TEXT,
  ip_address TEXT,
  outcome TEXT NOT NULL,          -- accepted | rejected_freemail | rejected_ratelimit | rejected_captcha | rejected_invalid
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_public_audit_log_created ON public.public_audit_request_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_public_audit_log_email ON public.public_audit_request_log(email);

-- The rate-limit + log + cache tables are written exclusively via the
-- service-role key from server-side handlers. RLS is enabled with no
-- policies, mirroring the existing `leads` table pattern.
ALTER TABLE public.brand_lookup_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_request_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_audit_request_log ENABLE ROW LEVEL SECURITY;

COMMIT;
