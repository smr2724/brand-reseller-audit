import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const jobId = url.searchParams.get("job_id");
  if (!jobId) return NextResponse.json({ error: "job_id required" }, { status: 400 });

  const { data: job } = await supabase
    .from("jobs")
    .select("id, type, status, progress, error, related_opportunity_id, started_at, completed_at, result_summary")
    .eq("id", jobId)
    .single();
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json(job);
}
