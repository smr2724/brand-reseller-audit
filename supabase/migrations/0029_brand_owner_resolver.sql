-- Phase 33 — Brand Owner Resolver
-- New tables and columns to capture candidate owner companies for each
-- Amazon brand and the human-in-the-loop selection of the resolved owner.
--
-- Append-only: do not modify existing migrations or columns.

-- Per-brand owner-resolution state.
ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS owner_resolution_state TEXT NOT NULL DEFAULT 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'brands_owner_resolution_state_chk'
  ) THEN
    ALTER TABLE brands
      ADD CONSTRAINT brands_owner_resolution_state_chk
      CHECK (owner_resolution_state IN (
        'pending','running','candidates_ready','selected','failed','skipped'
      ));
  END IF;
END $$;

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS owner_resolution_error TEXT,
  ADD COLUMN IF NOT EXISTS owner_resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_owner_company_name TEXT,
  ADD COLUMN IF NOT EXISTS resolved_owner_domain TEXT,
  ADD COLUMN IF NOT EXISTS resolved_owner_type TEXT,
  ADD COLUMN IF NOT EXISTS owner_resolution_notes TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'brands_resolved_owner_type_chk'
  ) THEN
    ALTER TABLE brands
      ADD CONSTRAINT brands_resolved_owner_type_chk
      CHECK (
        resolved_owner_type IS NULL OR resolved_owner_type IN (
          'manufacturer','brand_owner','licensee','distributor','dba','holding_co','unknown'
        )
      );
  END IF;
END $$;

-- One row per resolver run (audit trail).
CREATE TABLE IF NOT EXISTS owner_resolution_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  triggered_by TEXT NOT NULL CHECK (triggered_by IN ('auto_post_enrichment','manual','rerun')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','succeeded','failed')),
  error_message TEXT,
  uspto_query TEXT,
  uspto_results_count INTEGER,
  web_search_queries JSONB,
  web_search_results_count INTEGER,
  raw_uspto_payload JSONB,
  raw_web_search_payload JSONB,
  candidates_inserted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_owner_resolution_runs_brand
  ON owner_resolution_runs(brand_id, started_at DESC);

-- Candidate owners (multiple rows per run; we keep history across runs).
CREATE TABLE IF NOT EXISTS owner_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  resolution_run_id UUID NOT NULL REFERENCES owner_resolution_runs(id) ON DELETE CASCADE,
  candidate_company_name TEXT NOT NULL,
  candidate_domain TEXT,
  candidate_source TEXT NOT NULL
    CHECK (candidate_source IN ('uspto','web_search','seller_name_heuristic','manual')),
  evidence_text TEXT,
  evidence_url TEXT,
  match_reason TEXT,
  trademark_serial_number TEXT,
  trademark_status TEXT,
  trademark_registration_date DATE,
  trademark_owner_address TEXT,
  goods_services_text TEXT,
  heuristic_score INTEGER NOT NULL DEFAULT 0,
  heuristic_label TEXT NOT NULL DEFAULT 'unscored'
    CHECK (heuristic_label IN ('very_high','high','medium','needs_review','unscored')),
  is_selected_owner BOOLEAN NOT NULL DEFAULT FALSE,
  needs_manual_review BOOLEAN NOT NULL DEFAULT FALSE,
  selected_at TIMESTAMPTZ,
  selected_by_user_id UUID,
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_owner_candidates_brand
  ON owner_candidates(brand_id, heuristic_score DESC);
CREATE INDEX IF NOT EXISTS idx_owner_candidates_run
  ON owner_candidates(resolution_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_candidates_unique_per_run
  ON owner_candidates(
    resolution_run_id,
    LOWER(candidate_company_name),
    COALESCE(LOWER(candidate_domain), '')
  );
