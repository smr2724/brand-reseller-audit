-- Phase 34.4 — Relax owner_candidates unique-per-run index + extend
-- candidate_source allow-list with the new Apollo CRM variants.
--
-- Phase 34.3 added a fourth Apollo tier and started calling both
-- `mixed_companies/search` (public) and `accounts/search` (CRM) per
-- tier. Both endpoints can return the same organization for the same
-- (run_id, name, domain) tuple — the existing unique index
-- `idx_owner_candidates_unique_per_run` rejected the second insert and
-- crashed the run with `duplicate key value violates unique constraint`.
--
-- 34.4 fix:
--   1. Recreate the unique index with `candidate_source` appended to the
--      key. Same-source dupes still rejected; CRM-vs-public dupes are
--      now allowed because they live under different `candidate_source`
--      values.
--   2. Extend the candidate_source CHECK constraint to allow the new
--      variants written by the resolver (`apollo_crm`,
--      `apollo_manual_crm`).
--
-- Idempotent — uses DROP IF EXISTS / DO blocks throughout.

-- 1. Recreate the unique index with candidate_source in the key --------------
DROP INDEX IF EXISTS public.idx_owner_candidates_unique_per_run;

CREATE UNIQUE INDEX idx_owner_candidates_unique_per_run
  ON public.owner_candidates
  USING btree (
    resolution_run_id,
    lower(candidate_company_name),
    COALESCE(lower(candidate_domain), ''::text),
    COALESCE(candidate_source, 'unknown')
  );

-- 2. Extend candidate_source allow-list with CRM variants -------------------
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
        'apollo_crm',
        'apollo_no_match',
        'apollo_manual',
        'apollo_manual_crm',
        'extractor',
        'extractor_manual'
      ));
  END IF;
END $$;
