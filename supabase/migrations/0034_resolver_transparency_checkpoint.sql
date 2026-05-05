-- Phase 34.2 — Transparency checkpoint between extractor and Apollo.
--
-- 1. New brand owner-resolution states: 'awaiting_apollo_selection' (user
--    reviews extractor candidates) and 'enriching_apollo' (selected
--    candidates are being enriched against Apollo asynchronously).
-- 2. New owner_candidates.candidate_source values: 'extractor' (raw
--    extractor candidate, not yet sent to Apollo) and 'extractor_manual'
--    (user-typed candidate added at the checkpoint).
-- 3. owner_candidates.derived_from_candidate_id — links Apollo-derived
--    rows back to the originating extractor row.
-- 4. owner_candidates.apollo_search_attempted_at — so the UI can
--    distinguish "we tried Apollo and got nothing" from "we haven't
--    tried yet".
-- 5. owner_resolution_runs.raw_apollo_payload — JSONB observability
--    bucket for every Apollo request/response (the Phase-34.2 fix for
--    the silent zero-hit bug).
-- 6. claim_owner_resolution_run RPC: extend allow-list with the new
--    states so retries / restarts behave correctly.
-- 7. claim_apollo_enrichment_run RPC: small CAS that transitions
--    'awaiting_apollo_selection' -> 'enriching_apollo' atomically, so
--    a second click can't double-fire the Apollo call.
--
-- Idempotent: drop-and-recreate CHECK constraints inside DO blocks,
-- ADD COLUMN IF NOT EXISTS for new columns.

-- 1. Extend brands.owner_resolution_state allow-list -----------------------
DO $$
DECLARE
  conrec RECORD;
BEGIN
  FOR conrec IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'brands'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%owner_resolution_state%'
  LOOP
    EXECUTE 'ALTER TABLE brands DROP CONSTRAINT ' || quote_ident(conrec.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brands_owner_resolution_state_chk'
  ) THEN
    ALTER TABLE brands
      ADD CONSTRAINT brands_owner_resolution_state_chk
      CHECK (owner_resolution_state IN (
        'pending',
        'running',
        'awaiting_apollo_selection',
        'enriching_apollo',
        'candidates_ready',
        'selected',
        'failed',
        'skipped'
      ));
  END IF;
END $$;

-- 2. Extend owner_candidates.candidate_source allow-list -------------------
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
        'apollo_manual',
        'extractor',
        'extractor_manual'
      ));
  END IF;
END $$;

-- 3. owner_candidates: derived_from_candidate_id + apollo_search_attempted_at
ALTER TABLE owner_candidates
  ADD COLUMN IF NOT EXISTS derived_from_candidate_id UUID REFERENCES owner_candidates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS apollo_search_attempted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_owner_candidates_derived_from
  ON owner_candidates(derived_from_candidate_id)
  WHERE derived_from_candidate_id IS NOT NULL;

-- 4. owner_resolution_runs: raw_apollo_payload --------------------------------
ALTER TABLE owner_resolution_runs
  ADD COLUMN IF NOT EXISTS raw_apollo_payload JSONB;

-- 5. claim_owner_resolution_run RPC: include new states in allow-list -------
-- Same shape as 0031, with the awaiting/enriching states added so a re-run
-- from those states is accepted.
CREATE OR REPLACE FUNCTION claim_owner_resolution_run(p_brand_id UUID)
RETURNS TABLE(claimed BOOLEAN, brand_id UUID, brand_name TEXT, category TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_id UUID;
  v_name TEXT;
  v_category TEXT;
BEGIN
  UPDATE brands
  SET owner_resolution_state = 'running',
      owner_resolution_error = NULL
  WHERE id = p_brand_id
    AND owner_resolution_state IN (
      'pending',
      'candidates_ready',
      'failed',
      'selected',
      'awaiting_apollo_selection',
      'enriching_apollo'
    )
  RETURNING id, name, category
    INTO v_id, v_name, v_category;

  IF v_id IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, NULL::TEXT;
  ELSE
    RETURN QUERY SELECT TRUE, v_id, v_name, v_category;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION claim_owner_resolution_run(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_owner_resolution_run(UUID)
  TO anon, authenticated, service_role;

-- 6. claim_apollo_enrichment_run RPC ----------------------------------------
-- CAS-transition 'awaiting_apollo_selection' -> 'enriching_apollo'. Returns
-- (claimed, brand_id) so the route can detect a stale double-click.
CREATE OR REPLACE FUNCTION claim_apollo_enrichment_run(p_brand_id UUID)
RETURNS TABLE(claimed BOOLEAN, brand_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_id UUID;
BEGIN
  UPDATE brands
  SET owner_resolution_state = 'enriching_apollo',
      owner_resolution_error = NULL
  WHERE id = p_brand_id
    AND owner_resolution_state = 'awaiting_apollo_selection'
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::UUID;
  ELSE
    RETURN QUERY SELECT TRUE, v_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION claim_apollo_enrichment_run(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_apollo_enrichment_run(UUID)
  TO anon, authenticated, service_role;
