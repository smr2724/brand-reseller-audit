import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sweepId = ctx.params.id;
  const { data: sweep } = await supabase.from("sweeps").select("*").eq("id", sweepId).single();
  if (!sweep) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, status, payload, result_summary, error, related_opportunity_id, started_at, completed_at")
    .eq("parent_sweep_id", sweepId)
    .order("created_at", { ascending: true });

  return NextResponse.json({ sweep, jobs: jobs ?? [] });
}
