/**
 * Phase 21 — Manual stuck-report recovery, gated by CRON_SECRET.
 *
 * POST /api/admin/recover-stuck-report  body: { report_id: string }
 *
 * Re-runs generation against the existing report row so the public
 * `/r/<token>` URL keeps working. Used to unblock specific stuck reports
 * (e.g. Nutri Bites, Fantaswick) without waiting for the 5-min cron sweep.
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { recoverReport, findStuckReports } from "@/lib/report/recover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 300;

function authorize(req: Request): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const cronHeader = req.headers.get("x-vercel-cron-signature");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    if (auth === `Bearer ${cronSecret}`) return true;
    if (cronHeader && cronHeader === cronSecret) return true;
  }
  // Phase 21 stuck-recovery: also accept the service-role key as a bearer.
  // Anyone holding it already has full DB access via PostgREST, so this is
  // not an escalation — it just lets us trigger generation from a script
  // when CRON_SECRET isn't reachable. Remove with the rest of this admin
  // route once the cron has had a couple of clean recovery cycles.
  const sr = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (sr && auth === `Bearer ${sr}`) return true;
  return false;
}

export async function POST(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const reportId = String(body?.report_id ?? "").trim();
  if (!reportId) {
    return NextResponse.json({ error: "report_id required" }, { status: 400 });
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }
  const result = await recoverReport(admin, reportId);
  return NextResponse.json(result, { status: result.status === "recovered" ? 200 : 500 });
}

// GET returns the current set of stuck reports without recovering — useful
// for quick health checks.
export async function GET(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }
  const stuck = await findStuckReports(admin);
  return NextResponse.json({ stuck });
}
