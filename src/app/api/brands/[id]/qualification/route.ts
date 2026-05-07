/**
 * Phase 47 — GET /api/brands/[id]/qualification
 *
 * Returns the persisted verdict + full hook list + entity data. Used by
 * the QualificationReview component on the brand page.
 */
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getQualification } from "@/lib/qualification/orchestrate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
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
    .select("id, qualification_state")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle<{ id: string; qualification_state: string | null }>();
  if (!brand) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const row = await getQualification(params.id);
  return NextResponse.json({
    qualification_state: brand.qualification_state ?? "pending",
    qualification: row,
  });
}
