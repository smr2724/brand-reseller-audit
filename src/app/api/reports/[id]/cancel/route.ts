import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseAdminClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/reports/:id/cancel — flip a stuck `generating` row to `failed`
 * with reason "manually cancelled". Useful when a lambda dies mid-render
 * and the row never gets finalized. Only the report owner can cancel; only
 * `generating` rows are eligible.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: report, error: readErr } = await supabase
    .from("reports")
    .select("id, status")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (report.status !== "generating") {
    return NextResponse.json(
      { error: `report is ${report.status}, not generating — nothing to cancel` },
      { status: 409 },
    );
  }

  // Use admin client so we can update regardless of RLS write policy on this column.
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  const { error: updErr } = await admin
    .from("reports")
    .update({
      status: "failed",
      error_message: "manually cancelled",
    })
    .eq("id", params.id)
    .eq("user_id", user.id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  console.log("[api/reports/cancel] cancelled", { reportId: params.id, userId: user.id });
  return NextResponse.json({ ok: true, report_id: params.id, status: "failed" });
}
