-- 0063_phase81_cost_rpcs.sql
-- Phase 81 — Atomic cost rollup RPCs.
-- Replaces the read-modify-write rollup in src/lib/cost/track.ts with
-- SECURITY DEFINER functions that perform the add inside a single
-- UPDATE statement, eliminating the lost-update race.
-- Already applied to production via Supabase connector; this file
-- exists so the schema change is tracked in git. Idempotent.

create or replace function add_brand_cost(
  p_brand_run_id uuid,
  p_provider text,
  p_delta numeric
)
returns void
language plpgsql
security definer
as $$
begin
  update bulk_run_brands
  set cost_total_usd = cost_total_usd + p_delta,
      cost_breakdown = coalesce(cost_breakdown, '{}'::jsonb) ||
        jsonb_build_object(
          p_provider,
          round((coalesce((cost_breakdown->>p_provider)::numeric, 0) + p_delta)::numeric, 4)
        ),
      updated_at = now()
  where id = p_brand_run_id;
end;
$$;

create or replace function add_run_cost(
  p_run_id uuid,
  p_delta numeric
)
returns void
language plpgsql
security definer
as $$
begin
  update bulk_runs
  set cost_total_usd = cost_total_usd + p_delta,
      updated_at = now()
  where id = p_run_id;
end;
$$;

grant execute on function add_brand_cost(uuid, text, numeric) to service_role;
grant execute on function add_run_cost(uuid, numeric) to service_role;
