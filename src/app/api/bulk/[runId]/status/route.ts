/**
 * Phase 75 — GET /api/bulk/[runId]/status.
 *
 * Returns the full bulk_runs row + every bulk_run_brands row (sorted
 * by position) for the in-app live progress page. Auth is the same as
 * other admin routes — the user must own the run.
 */
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { runId: string } },
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data: run, error: runErr } = await supabase
    .from("bulk_runs")
    .select(
      "id, user_id, status, total_brands, brands_completed, current_brand_id, current_brand_name, started_at, completed_at, report_email_sent_at, error_message, created_at, updated_at, cost_total_usd, janitor_kick_count, last_janitor_kick_at",
    )
    .eq("id", params.runId)
    .maybeSingle();
  if (runErr) {
    return NextResponse.json({ error: runErr.message }, { status: 500 });
  }
  if (!run) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (run.user_id !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { data: brands, error: brandsErr } = await supabase
    .from("bulk_run_brands")
    .select(
      "id, bulk_run_id, position, input_name, brand_id, status, progress_percent, current_step_label, qualified, disqualification_reason, selected_entity_name, resolved_owner_domain, contact_name, contact_email, email_verifier, email_status, outlook_draft_id, outlook_draft_web_link, brand_seven_x_value, legion_opportunity, economics_status, error_message, error_step, started_at, completed_at, cost_total_usd, cost_breakdown",
    )
    .eq("bulk_run_id", params.runId)
    .order("position", { ascending: true });
  if (brandsErr) {
    return NextResponse.json({ error: brandsErr.message }, { status: 500 });
  }

  return NextResponse.json({ run, brands: brands ?? [] });
}
