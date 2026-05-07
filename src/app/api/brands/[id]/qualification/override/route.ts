/**
 * Phase 47 — POST /api/brands/[id]/qualification/override
 *
 * Manual override (warn-and-allow). Sets `manual_override=true`,
 * captures reason. Does NOT change `icp_verdict` — the override only
 * unlocks downstream actions; the disqualification banner stays visible
 * with the override-active variant.
 */
import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MIN_REASON_LEN = 10;

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data: brand } = await supabase
    .from("brands")
    .select("id")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!brand) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  const reason = String(body?.reason ?? "").trim();
  if (reason.length < MIN_REASON_LEN) {
    return NextResponse.json(
      { error: `reason must be at least ${MIN_REASON_LEN} characters` },
      { status: 400 },
    );
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }
  const nowIso = new Date().toISOString();
  const { data, error } = await admin
    .from("brand_qualifications")
    .update({
      manual_override: true,
      manual_override_reason: reason,
      manual_override_by: user.id,
      manual_override_at: nowIso,
      updated_at: nowIso,
    })
    .eq("brand_id", params.id)
    .select("id, manual_override, manual_override_reason, manual_override_at")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json(
      { error: "no qualification row to override yet" },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true, override: data });
}
