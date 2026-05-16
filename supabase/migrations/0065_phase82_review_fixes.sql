-- Phase 82 review fixes — atomic janitor kick increment.
--
-- Reviewer flagged the read-modify-write pattern on bulk_runs.janitor_kick_count
-- as drift-prone if two janitor invocations overlap. This RPC performs the
-- increment atomically and stamps last_janitor_kick_at + updated_at in a
-- single UPDATE, returning the post-increment kick count.
--
-- Already applied to Supabase project qbgchatkwaqpbvxsramw on 2026-05-16.
-- Idempotent via `create or replace`.

create or replace function increment_janitor_kick(p_run_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  update bulk_runs
     set janitor_kick_count = coalesce(janitor_kick_count, 0) + 1,
         last_janitor_kick_at = now(),
         updated_at = now()
   where id = p_run_id
  returning janitor_kick_count into new_count;
  return coalesce(new_count, 0);
end;
$$;

grant execute on function increment_janitor_kick(uuid) to service_role;

-- Phase 82 review fix #7 — merge into brands.enrichment_metadata atomically
-- via jsonb `||` instead of read-merge-write. Prevents future writers from
-- silently dropping keys.
create or replace function merge_brand_enrichment_metadata(
  p_brand_id uuid,
  p_patch jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update brands
     set enrichment_metadata = coalesce(enrichment_metadata, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb),
         updated_at = now()
   where id = p_brand_id;
end;
$$;

grant execute on function merge_brand_enrichment_metadata(uuid, jsonb) to service_role;
