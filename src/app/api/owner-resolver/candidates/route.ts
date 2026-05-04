/**
 * Phase 33 — GET /api/owner-resolver/candidates?brand_id=...
 *
 * Returns the latest run + candidates for a brand. Candidates are ordered
 * by `heuristic_score DESC, created_at DESC`. The brand row's resolution
 * fields are echoed back so the UI doesn't need a second round-trip.
 *
 * Auth: same scheme as the trigger route (CRON_SECRET / service-role bearer).
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 300;

function authorize(req: Request): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true;
  const sr = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (sr && auth === `Bearer ${sr}`) return true;
  return false;
}

export async function GET(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const brandId = url.searchParams.get("brand_id")?.trim() ?? "";
  if (!brandId) {
    return NextResponse.json({ error: "brand_id required" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  const { data: brand, error: brandErr } = await admin
    .from("brands")
    .select(
      "id, name, category, owner_resolution_state, owner_resolution_error, owner_resolved_at, resolved_owner_company_name, resolved_owner_domain, resolved_owner_type, owner_resolution_notes",
    )
    .eq("id", brandId)
    .maybeSingle();
  if (brandErr || !brand) {
    return NextResponse.json(
      { error: brandErr?.message ?? "brand not found" },
      { status: 404 },
    );
  }

  const { data: runs } = await admin
    .from("owner_resolution_runs")
    .select(
      "id, brand_id, triggered_by, started_at, completed_at, status, error_message, uspto_query, uspto_results_count, web_search_queries, web_search_results_count, candidates_inserted",
    )
    .eq("brand_id", brandId)
    .order("started_at", { ascending: false })
    .limit(1);
  const latestRun = (runs ?? [])[0] ?? null;

  let candidates: unknown[] = [];
  if (latestRun) {
    const { data: cands } = await admin
      .from("owner_candidates")
      .select(
        "id, brand_id, resolution_run_id, candidate_company_name, candidate_domain, candidate_source, evidence_text, evidence_url, match_reason, trademark_serial_number, trademark_status, trademark_registration_date, trademark_owner_address, goods_services_text, heuristic_score, heuristic_label, is_selected_owner, needs_manual_review, selected_at, created_at",
      )
      .eq("resolution_run_id", (latestRun as { id: string }).id)
      .order("heuristic_score", { ascending: false })
      .order("created_at", { ascending: false });
    candidates = cands ?? [];
  }

  return NextResponse.json({
    brand,
    run: latestRun,
    candidates,
  });
}
