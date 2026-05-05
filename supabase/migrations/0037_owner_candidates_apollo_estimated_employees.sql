-- Phase 38 — fallback "estimated employees" proxy for the Apollo
-- contact-count badge.
--
-- When Apollo's `mixed_people/search` returns null (permission gap on
-- the API key, an empty pagination block, or a fetch failure) we still
-- have `organizations/enrich.estimated_num_employees` from the org-side
-- payload. Persisting it in a SEPARATE column lets the UI render
-- "~N employees" without conflating it with `apollo_total_contacts`,
-- which represents real people-count results.
--
-- DO NOT mix the two values in one column — UI / sort / dedup logic
-- depends on a clean separation.

alter table owner_candidates
  add column if not exists apollo_estimated_employees integer null;

comment on column owner_candidates.apollo_estimated_employees is
  'Phase 38 fallback proxy: Apollo organizations/enrich estimated_num_employees, used when mixed_people/search countContacts returns null. Surfaced as "~N employees" badge — never mixed with apollo_total_contacts.';
