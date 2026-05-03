/**
 * Phase 21 — Stuck-scan recovery cron.
 *
 * Runs every 5 minutes (see vercel.json). For every channel-ownership-audit
 * report that has been sitting at `status='generating'` for more than 10
 * minutes, re-runs `generateAuditReport` against the existing report id.
 *
 * Also flips any matching `leads` row from `audit_status='generating_report'`
 * to `audit_status='pending'` once the report finishes — so the existing
 * /api/cron/process-audit-queue tick can re-pick it for the email + Outlook
 * draft side effects. This handles the Fantaswick-style case where the
 * lead path stalled mid-flight.
 *
 * Safety belts (NEVER remove):
 *   runtime = nodejs
 *   dynamic = force-dynamic
 *   fetchCache = force-no-store
 *   revalidate = 0
 *   maxDuration = 300
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { findStuckReports, recoverReport } from "@/lib/report/recover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 300;

function authorize(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true; // dev: permit when not configured
  const auth = req.headers.get("authorization") ?? "";
  if (auth === `Bearer ${expected}`) return true;
  const cronHeader = req.headers.get("x-vercel-cron-signature");
  if (cronHeader && cronHeader === expected) return true;
  return false;
}

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
  console.log("[cron/recover-stuck-reports] candidates", {
    count: stuck.length,
    ids: stuck.map((s) => s.id),
  });

  if (stuck.length === 0) {
    return NextResponse.json({ processed: 0 });
  }

  const results: Array<{ report_id: string; status: string; error?: string }> = [];
  for (const r of stuck) {
    const res = await recoverReport(admin, r.id);
    results.push(res);

    // If recovery succeeded and a lead was attached at status
    // generating_report (Fantaswick case), bump it back to pending so the
    // queue cron picks it up for the email + Outlook draft on its next tick.
    if (res.status === "recovered") {
      const { error: leadErr } = await admin
        .from("leads")
        .update({ audit_status: "pending" })
        .eq("report_id", r.id)
        .eq("audit_status", "generating_report");
      if (leadErr) {
        console.warn("[cron/recover-stuck-reports] lead reset failed", {
          report_id: r.id,
          error: leadErr.message,
        });
      }
    }
  }

  return NextResponse.json({ processed: results.length, results });
}
