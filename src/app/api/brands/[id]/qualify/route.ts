/**
 * Phase 47 — POST /api/brands/[id]/qualify
 *
 * Triggers Module 1 (or returns the existing verdict if `?force=false`
 * and `qualification_state='complete'`).
 *
 * Auth: gated behind brand ownership (`brands.user_id = auth.user.id`).
 */
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getQualification, runQualification } from "@/lib/qualification/orchestrate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: { id: string } }) {
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
  const force = body?.force === true;

  const result = await runQualification(params.id, { force });
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error ?? "qualification failed",
        state: result.state,
      },
      { status: 500 },
    );
  }
  const row = await getQualification(params.id);
  return NextResponse.json({
    qualification_id: result.qualification_id,
    state: result.state,
    verdict: row?.icp_verdict ?? result.verdict,
    reasoning: row?.icp_reasoning ?? null,
    disqualification_pattern: row?.disqualification_pattern ?? null,
    selected_entity: row?.selected_entity ?? null,
    candidate_hooks: row?.candidate_hooks ?? [],
    cost_usd: row?.total_cost_usd ?? null,
  });
}
