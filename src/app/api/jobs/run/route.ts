import { NextResponse } from "next/server";
import { createAdminClient, getInternalToken, runJob } from "@/lib/jobs";

// Single job execution can take 60-180s (full scan or supplier scan).
// Vercel Pro caps at 300s for serverless functions.
export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const token = req.headers.get("x-internal-token");
  let internal: string;
  try {
    internal = getInternalToken();
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "missing token" }, { status: 500 });
  }
  if (token !== internal) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const jobId = String(body?.job_id ?? "");
  if (!jobId) return NextResponse.json({ error: "job_id required" }, { status: 400 });

  const supabase = createAdminClient();
  const result = await runJob(supabase, jobId, internal);
  return NextResponse.json(result);
}
