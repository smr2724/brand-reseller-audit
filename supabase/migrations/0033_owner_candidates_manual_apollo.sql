-- Phase 34.1 — Manual Apollo override.
--
-- Adds `apollo_manual` as an allowed value of owner_candidates.candidate_source
-- so user-driven Apollo searches (POST /api/owner-resolver/manual-apollo-search)
-- can persist their hits as candidates. Also adds an `is_manual_apollo`
-- boolean for clear UI badging without re-checking the source string.
--
-- Safe to re-run (uses IF NOT EXISTS / DO blocks). The previous migration
-- (0032) drops any prior candidate_source CHECK constraint and re-creates a
-- single canonical one named `owner_candidates_source_chk`. We follow the
-- same dance here so re-running is idempotent regardless of which prior
-- migration created the live constraint.

-- 1. is_manual_apollo flag --------------------------------------------------
ALTER TABLE owner_candidates
  ADD COLUMN IF NOT EXISTS is_manual_apollo BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_owner_candidates_manual_apollo
  ON owner_candidates(brand_id)
  WHERE is_manual_apollo = TRUE;

-- 2. Extend candidate_source allow-list to include `apollo_manual` ----------
DO $$
DECLARE
  conrec RECORD;
BEGIN
  FOR conrec IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'owner_candidates'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%candidate_source%'
  LOOP
    EXECUTE 'ALTER TABLE owner_candidates DROP CONSTRAINT ' || quote_ident(conrec.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'owner_candidates_source_chk'
  ) THEN
    ALTER TABLE owner_candidates
      ADD CONSTRAINT owner_candidates_source_chk
      CHECK (candidate_source IN (
        'uspto',
        'web_search',
        'seller_name_heuristic',
        'manual',
        'apollo',
        'apollo_no_match',
        'apollo_manual'
      ));
  END IF;
END $$;
