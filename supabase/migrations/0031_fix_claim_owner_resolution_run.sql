-- Phase 33.2 — Fix claim_owner_resolution_run RPC.
--
-- The original definition (migration 0030) declares OUT parameters via
--   RETURNS TABLE(claimed BOOLEAN, brand_id UUID, brand_name TEXT, category TEXT)
-- which puts an OUT variable named `category` in scope inside the body.
-- The body then runs:
--   UPDATE brands ... RETURNING id, name, category INTO v_id, v_name, v_category;
-- where `category` is ALSO a real column on `brands`. With the default
-- plpgsql.variable_conflict = 'error' setting, PostgreSQL refuses to
-- disambiguate and the RPC raises:
--   column reference "category" is ambiguous
--
-- The supabase-js client surfaces that as `error`, the orchestrator's
-- claimBrand helper returns null, and the trigger route reports the
-- misleading "owner-resolution already running or brand missing" — even
-- when the brand is in `pending` with no prior runs.
--
-- Fix: re-create the function with `#variable_conflict use_column` so the
-- RETURNING list is unambiguously interpreted as table columns. The
-- function's return shape (claimed/brand_id/brand_name/category) is
-- preserved so callers don't need to change.

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
