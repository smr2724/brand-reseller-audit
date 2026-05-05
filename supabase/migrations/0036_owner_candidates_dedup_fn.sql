-- Phase 34.7 — Bulk owner_candidates insert that tolerates the expression
-- unique index `idx_owner_candidates_unique_per_run`.
--
-- Phase 34.4 created the unique index over expressions:
--   (resolution_run_id,
--    lower(candidate_company_name),
--    COALESCE(lower(candidate_domain), ''),
--    COALESCE(candidate_source, 'unknown'))
--
-- Postgres requires `ON CONFLICT (col, col, ...)` to match index
-- columns/expressions exactly, so the supabase-js `.upsert(rows, {
-- onConflict: 'resolution_run_id,candidate_company_name,...' })` call
-- fails with SQLSTATE 42P10 ("there is no unique or exclusion
-- constraint matching the ON CONFLICT specification").
--
-- supabase-js doesn't pass through ON CONFLICT expression targets, but
-- raw SQL inside a SECURITY DEFINER function can spell out the same
-- expressions the index uses, which is what Postgres requires for
-- partial / expression indexes (`CREATE UNIQUE INDEX` creates an index,
-- not a true CONSTRAINT, so the `ON CONFLICT ON CONSTRAINT <name>`
-- form is rejected for it). Listing the expressions verbatim works.
--
-- Both the auto-resolver (`enrichSelectedCandidatesWithApollo` in
-- src/lib/owner-resolver/resolve.ts) and the manual Apollo override
-- route (POST /api/owner-resolver/manual-apollo-search) call this RPC
-- via `supabase.rpc('insert_owner_candidates_dedup', { rows })`.
--
-- The function takes a single JSONB array argument so the supabase-js
-- caller can pass the same row objects it built before, without having
-- to project them into individual SQL parameters.
--
-- Idempotent (CREATE OR REPLACE FUNCTION).

CREATE OR REPLACE FUNCTION public.insert_owner_candidates_dedup(rows jsonb)
RETURNS TABLE(
  id uuid,
  apollo_organization_name text,
  apollo_organization_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF rows IS NULL OR jsonb_typeof(rows) <> 'array' THEN
    RAISE EXCEPTION 'insert_owner_candidates_dedup: rows must be a JSONB array';
  END IF;

  RETURN QUERY
  INSERT INTO owner_candidates (
    brand_id,
    resolution_run_id,
    candidate_company_name,
    candidate_domain,
    candidate_source,
    evidence_text,
    evidence_url,
    match_reason,
    trademark_serial_number,
    trademark_status,
    trademark_registration_date,
    trademark_owner_address,
    goods_services_text,
    heuristic_score,
    heuristic_label,
    needs_manual_review,
    is_manual_apollo,
    raw_payload,
    apollo_organization_id,
    apollo_organization_name,
    apollo_domain,
    apollo_employee_count,
    apollo_total_contacts,
    apollo_hq_city,
    apollo_hq_country,
    apollo_industry,
    extractor_confidence,
    extractor_reasoning,
    evidence_urls,
    derived_from_candidate_id
  )
  SELECT
    r.brand_id,
    r.resolution_run_id,
    r.candidate_company_name,
    r.candidate_domain,
    r.candidate_source,
    r.evidence_text,
    r.evidence_url,
    r.match_reason,
    r.trademark_serial_number,
    r.trademark_status,
    r.trademark_registration_date,
    r.trademark_owner_address,
    r.goods_services_text,
    COALESCE(r.heuristic_score, 0),
    COALESCE(r.heuristic_label, 'unscored'),
    COALESCE(r.needs_manual_review, FALSE),
    COALESCE(r.is_manual_apollo, FALSE),
    r.raw_payload,
    r.apollo_organization_id,
    r.apollo_organization_name,
    r.apollo_domain,
    r.apollo_employee_count,
    r.apollo_total_contacts,
    r.apollo_hq_city,
    r.apollo_hq_country,
    r.apollo_industry,
    r.extractor_confidence,
    r.extractor_reasoning,
    r.evidence_urls,
    r.derived_from_candidate_id
  FROM jsonb_to_recordset(rows) AS r(
    brand_id uuid,
    resolution_run_id uuid,
    candidate_company_name text,
    candidate_domain text,
    candidate_source text,
    evidence_text text,
    evidence_url text,
    match_reason text,
    trademark_serial_number text,
    trademark_status text,
    trademark_registration_date date,
    trademark_owner_address text,
    goods_services_text text,
    heuristic_score integer,
    heuristic_label text,
    needs_manual_review boolean,
    is_manual_apollo boolean,
    raw_payload jsonb,
    apollo_organization_id text,
    apollo_organization_name text,
    apollo_domain text,
    apollo_employee_count integer,
    apollo_total_contacts integer,
    apollo_hq_city text,
    apollo_hq_country text,
    apollo_industry text,
    extractor_confidence numeric,
    extractor_reasoning text,
    evidence_urls jsonb,
    derived_from_candidate_id uuid
  )
  ON CONFLICT (
    resolution_run_id,
    lower(candidate_company_name),
    COALESCE(lower(candidate_domain), ''::text),
    COALESCE(candidate_source, 'unknown')
  ) DO NOTHING
  RETURNING
    owner_candidates.id,
    owner_candidates.apollo_organization_name,
    owner_candidates.apollo_organization_id;
END;
$$;

REVOKE ALL ON FUNCTION public.insert_owner_candidates_dedup(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.insert_owner_candidates_dedup(jsonb)
  TO anon, authenticated, service_role;
