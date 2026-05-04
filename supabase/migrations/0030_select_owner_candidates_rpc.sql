-- Phase 33 review fix (B2 / M1 / M2 / M9)
-- Atomic owner-candidate selection via SECURITY DEFINER RPC.
--
-- Replaces the three-write sequence in /api/owner-resolver/select with a
-- single transaction so concurrent / double-click saves can't leave the
-- DB in an intermediate state.
--
-- Note on locking: ADD COLUMN with NOT NULL DEFAULT (used in migration
-- 0029) is fast-path on PostgreSQL >= 11. Supabase runs PG15+, so safe.
-- This migration only creates a function — it does not lock data tables.

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

  -- Latest resolution run for this brand (run-scoped clear, M9).
  SELECT id INTO v_latest_run
  FROM owner_resolution_runs
  WHERE brand_id = p_brand_id
  ORDER BY started_at DESC
  LIMIT 1;

  IF v_latest_run IS NULL THEN
    RAISE EXCEPTION 'brand has no resolution runs';
  END IF;

  -- Verify all picked candidates belong to the brand AND the latest run.
  -- (Selecting a candidate from an older run would be ambiguous — rerun first.)
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

  -- Step 1: clear is_selected_owner across ONLY the latest run for this brand.
  UPDATE owner_candidates
  SET is_selected_owner = FALSE,
      selected_at = NULL,
      selected_by_user_id = NULL
  WHERE brand_id = p_brand_id
    AND resolution_run_id = v_latest_run;

  -- Step 2: mark the picked candidates as selected.
  UPDATE owner_candidates
  SET is_selected_owner = TRUE,
      selected_at = NOW(),
      selected_by_user_id = p_user_id
  WHERE id = ANY(p_candidate_ids);

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Step 3: pick the brand-row primary candidate by deterministic tiebreak
  -- (M2): highest heuristic_score, then earliest created_at, then lowest UUID.
  SELECT id, candidate_company_name, candidate_domain
    INTO v_primary_id, v_primary_name, v_primary_domain
  FROM owner_candidates
  WHERE id = ANY(p_candidate_ids)
  ORDER BY heuristic_score DESC NULLS LAST, created_at ASC, id ASC
  LIMIT 1;

  -- Step 4: mirror primary candidate onto the brand row.
  UPDATE brands
  SET owner_resolution_state = 'selected',
      owner_resolved_at = NOW(),
      resolved_owner_type = p_resolved_owner_type,
      resolved_owner_company_name = v_primary_name,
      resolved_owner_domain = v_primary_domain,
      owner_resolution_error = NULL
  WHERE id = p_brand_id;

  RETURN QUERY SELECT v_count, v_primary_id, v_primary_name, v_primary_domain;
END;
$$;

-- Allow the service role to call this; anon/authenticated users will
-- continue to access via the API route under SECURITY DEFINER.
REVOKE ALL ON FUNCTION select_owner_candidates(UUID, UUID[], TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION select_owner_candidates(UUID, UUID[], TEXT, UUID)
  TO anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- B3: reject_owner_candidates — implements the "None of these" path.
-- ----------------------------------------------------------------------------
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

  -- Clear is_selected_owner brand-wide (rejection invalidates any pick).
  UPDATE owner_candidates
  SET is_selected_owner = FALSE,
      selected_at = NULL,
      selected_by_user_id = NULL
  WHERE brand_id = p_brand_id;

  -- Append a system note.
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


-- ----------------------------------------------------------------------------
-- B5: claim_owner_resolution_run — atomic CAS for state='running'.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_owner_resolution_run(p_brand_id UUID)
RETURNS TABLE(claimed BOOLEAN, brand_id UUID, brand_name TEXT, category TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_name TEXT;
  v_category TEXT;
BEGIN
  UPDATE brands
  SET owner_resolution_state = 'running',
      owner_resolution_error = NULL
  WHERE id = p_brand_id
    AND owner_resolution_state IN ('pending','candidates_ready','failed','selected')
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
