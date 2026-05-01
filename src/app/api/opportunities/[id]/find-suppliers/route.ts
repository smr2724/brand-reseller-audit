import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createAdminClient, dispatchJobs, getInternalToken } from "@/lib/jobs";

export const maxDuration = 30;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Enqueue a supplier_scan job for one opportunity. Returns the job_id; polling
 * the opportunity page or jobs row will reflect status.
 */
export async function POST(_req: Request, ctx: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const oppId = ctx.params.id;
  const { data: opp } = await supabase
    .from("opportunities")
    .select("id, name, main_keyword")
    .eq("id", oppId)
    .single();
  if (!opp) return NextResponse.json({ error: "opportunity not found" }, { status: 404 });

  // Don't double-enqueue while a pending/running job exists
  const { data: existing } = await supabase
    .from("jobs")
    .select("id, status")
    .eq("user_id", user.id)
    .eq("type", "supplier_scan")
    .eq("related_opportunity_id", oppId)
    .in("status", ["pending", "running"])
    .limit(1);

  if (existing?.length) {
    return NextResponse.json({ ok: true, job_id: existing[0].id, already_running: true });
  }

  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .insert({
      user_id: user.id,
      type: "supplier_scan",
      status: "pending",
      payload: { opportunity_id: opp.id, seed_keyword: opp.main_keyword, opportunity_name: opp.name },
      related_opportunity_id: opp.id,
    })
    .select()
    .single();
  if (jobErr || !job) return NextResponse.json({ error: jobErr?.message ?? "could not create job" }, { status: 500 });

  // Kick the dispatcher (fire-and-forget — admin client to bypass RLS)
  try {
    const admin = createAdminClient();
    const internal = getInternalToken();
    dispatchJobs(admin, user.id, internal).catch(() => {});
  } catch {}

  return NextResponse.json({ ok: true, job_id: job.id });
}
