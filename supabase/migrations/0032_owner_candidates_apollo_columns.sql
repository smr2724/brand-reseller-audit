-- Phase 34 — Apollo-backed owner candidates with reasoning extractor.
--
-- Adds Apollo organization metadata + extractor reasoning to owner_candidates,
-- adds Apollo org id mirror to brands, extends candidate_source allowed
-- values with 'apollo' / 'apollo_no_match', and extends select_owner_candidates
-- to mirror apollo_organization_id onto brands.resolved_owner_apollo_org_id.
--
-- Safe to re-run (uses IF NOT EXISTS / DO blocks).

-- 1. owner_candidates: Apollo + extractor columns ---------------------------
ALTER TABLE owner_candidates
  ADD COLUMN IF NOT EXISTS apollo_organization_id TEXT,
  ADD COLUMN IF NOT EXISTS apollo_organization_name TEXT,
  ADD COLUMN IF NOT EXISTS apollo_domain TEXT,
  ADD COLUMN IF NOT EXISTS apollo_employee_count INTEGER,
  ADD COLUMN IF NOT EXISTS apollo_total_contacts INTEGER,
  ADD COLUMN IF NOT EXISTS apollo_hq_city TEXT,
  ADD COLUMN IF NOT EXISTS apollo_hq_country TEXT,
  ADD COLUMN IF NOT EXISTS apollo_industry TEXT,
  ADD COLUMN IF NOT EXISTS extractor_confidence NUMERIC(3,2),
  ADD COLUMN IF NOT EXISTS extractor_reasoning TEXT,
  ADD COLUMN IF NOT EXISTS evidence_urls JSONB;

CREATE INDEX IF NOT EXISTS idx_owner_candidates_apollo_org
  ON owner_candidates(apollo_organization_id)
  WHERE apollo_organization_id IS NOT NULL;

-- 2. Extend candidate_source allowed values ---------------------------------
-- The 0029 migration created the table with an inline CHECK constraint on
-- candidate_source. The constraint name is auto-generated; find and drop it
-- (any constraint that limits candidate_source) before re-creating the
-- constraint with the expanded allow-list.
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
        'apollo_no_match'
      ));
  END IF;
END $$;

-- 3. brands: mirror Apollo org id on selection ------------------------------
ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS resolved_owner_apollo_org_id TEXT;

-- 4. select_owner_candidates RPC: also mirror apollo_organization_id ---------
-- Re-create with the same signature; SECURITY DEFINER + grants preserved.
CREATE OR REPLACE FUNCTION select_owner_candidates(
  p_brand_id UUID,
  p_candidate_ids UUID[],
  p_resolved_owner_type TEXT,
  p_user_id UUID
)
RETURNS TABLE(
  selected_count INTEGER,
  primary_candidate_id UUID,
  primary_candidate_name TEXT,
  primary_candidate_domain TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_latest_run UUID;
  v_primary_id UUID;
  v_primary_name TEXT;
  v_primary_domain TEXT;
  v_primary_apollo_id TEXT;
  v_count INTEGER;
BEGIN
  IF p_brand_id IS NULL THEN
    RAISE EXCEPTION 'brand_id is required';
  END IF;
  IF p_candidate_ids IS NULL OR array_length(p_candidate_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'candidate_ids must be a non-empty array';
  END IF;
  IF p_resolved_owner_type NOT IN (
    'manufacturer','brand_owner','licensee','distributor','dba','holding_co','unknown'
  ) THEN
    RAISE EXCEPTION 'invalid resolved_owner_type: %', p_resolved_owner_type;
  END IF;

  SELECT id INTO v_latest_run
  FROM owner_resolution_runs
  WHERE brand_id = p_brand_id
  ORDER BY started_at DESC
  LIMIT 1;

  IF v_latest_run IS NULL THEN
    RAISE EXCEPTION 'brand has no resolution runs';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(p_candidate_ids) cid
    WHERE NOT EXISTS (
      SELECT 1 FROM owner_candidates oc
      WHERE oc.id = cid
        AND oc.brand_id = p_brand_id
        AND oc.resolution_run_id = v_latest_run
    )
  ) THEN
    RAISE EXCEPTION 'one or more candidate_ids do not belong to brand % latest run', p_brand_id;
  END IF;

  UPDATE owner_candidates
  SET is_selected_owner = FALSE,
      selected_at = NULL,
      selected_by_user_id = NULL
  WHERE brand_id = p_brand_id
    AND resolution_run_id = v_latest_run;

  UPDATE owner_candidates
  SET is_selected_owner = TRUE,
      selected_at = NOW(),
      selected_by_user_id = p_user_id
  WHERE id = ANY(p_candidate_ids);

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Pick the primary candidate. Prefer Apollo-matched picks (they carry an
  -- organization id that powers the next phase); among those, prefer ones
  -- with more contacts, then larger employee count, then earliest created_at.
  -- Fall back to extractor_confidence / heuristic_score for non-Apollo picks.
  SELECT id, candidate_company_name, candidate_domain, apollo_organization_id
    INTO v_primary_id, v_primary_name, v_primary_domain, v_primary_apollo_id
  FROM owner_candidates
  WHERE id = ANY(p_candidate_ids)
  ORDER BY
    (apollo_organization_id IS NOT NULL) DESC,
    COALESCE(apollo_total_contacts, -1) DESC,
    COALESCE(apollo_employee_count, -1) DESC,
    COALESCE(extractor_confidence, 0) DESC,
    heuristic_score DESC NULLS LAST,
    created_at ASC,
    id ASC
  LIMIT 1;

  UPDATE brands
  SET owner_resolution_state = 'selected',
      owner_resolved_at = NOW(),
      resolved_owner_type = p_resolved_owner_type,
      resolved_owner_company_name = v_primary_name,
      resolved_owner_domain = v_primary_domain,
      resolved_owner_apollo_org_id = v_primary_apollo_id,
      owner_resolution_error = NULL
  WHERE id = p_brand_id;

  RETURN QUERY SELECT v_count, v_primary_id, v_primary_name, v_primary_domain;
END;
$$;

REVOKE ALL ON FUNCTION select_owner_candidates(UUID, UUID[], TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION select_owner_candidates(UUID, UUID[], TEXT, UUID)
  TO anon, authenticated, service_role;

-- 5. reject_owner_candidates: also clear resolved_owner_apollo_org_id --------
CREATE OR REPLACE FUNCTION reject_owner_candidates(
  p_brand_id UUID,
  p_user_id UUID,
  p_note TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_latest_run UUID;
  v_now TIMESTAMPTZ := NOW();
  v_existing_notes TEXT;
  v_appended TEXT;
BEGIN
  IF p_brand_id IS NULL THEN
    RAISE EXCEPTION 'brand_id is required';
  END IF;

  SELECT id INTO v_latest_run
  FROM owner_resolution_runs
  WHERE brand_id = p_brand_id
  ORDER BY started_at DESC
  LIMIT 1;

  UPDATE owner_candidates
  SET is_selected_owner = FALSE,
      selected_at = NULL,
      selected_by_user_id = NULL
  WHERE brand_id = p_brand_id;

  SELECT owner_resolution_notes INTO v_existing_notes
  FROM brands WHERE id = p_brand_id;
  v_appended := COALESCE(v_existing_notes, '');
  IF length(v_appended) > 0 THEN
    v_appended := v_appended || E'\n';
  END IF;
  v_appended := v_appended ||
    '[' || to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') ||
    '] User rejected all candidates' ||
    CASE WHEN p_user_id IS NOT NULL THEN ' (user ' || p_user_id::text || ')' ELSE '' END ||
    CASE WHEN p_note IS NOT NULL AND length(p_note) > 0 THEN ': ' || p_note ELSE '' END;

  UPDATE brands
  SET owner_resolution_state = 'failed',
      owner_resolved_at = NULL,
      resolved_owner_company_name = NULL,
      resolved_owner_domain = NULL,
      resolved_owner_type = NULL,
      resolved_owner_apollo_org_id = NULL,
      owner_resolution_error = 'User rejected all candidates',
      owner_resolution_notes = v_appended
  WHERE id = p_brand_id;

  IF v_latest_run IS NOT NULL THEN
    UPDATE owner_resolution_runs
    SET status = 'failed',
        completed_at = v_now,
        error_message = COALESCE(error_message, 'User rejected all candidates')
    WHERE id = v_latest_run;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION reject_owner_candidates(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reject_owner_candidates(UUID, UUID, TEXT)
  TO anon, authenticated, service_role;
