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
import { waitUntil } from "@vercel/functions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
// Phase 22 — Bumped from 300 → 800 (Vercel Pro Fluid Compute ceiling)
// to give the audit-generation pipeline real headroom while we tighten
// the per-stage budgets. The Phase 21 cron stays at 300 (with the 10-min
// stuck threshold + 5-min sweep that's plenty).
export const maxDuration = 800;

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
  let reportId = String(body?.report_id ?? "").trim();
  const tokenInput = String(body?.token ?? "").trim();
  if (!reportId && !tokenInput) {
    return NextResponse.json(
      { error: "report_id or token required" },
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
  // Phase 27 — token-based lookup so we can recover by /r/<token> URL
  // without needing the database row's UUID.
  if (!reportId && tokenInput) {
    const { data: tokenRow, error: tokenErr } = await admin
      .from("reports")
      .select("id")
      .eq("token", tokenInput)
      .maybeSingle();
    if (tokenErr || !tokenRow) {
      return NextResponse.json(
        { error: "report not found by token" },
        { status: 404 },
      );
    }
    reportId = tokenRow.id as string;
  }
  // Optional async mode: clients can post `{ async: true }` to start
  // generation and get a 202 immediately while the function continues
  // running via Vercel's waitUntil. Useful when the underlying generation
  // is bumping up against the 300s function ceiling.
  const url = new URL(req.url);
  const asyncMode =
    url.searchParams.get("async") === "1" || body?.async === true;

  if (asyncMode) {
    const promise = recoverReport(admin, reportId);
    try {
      waitUntil(promise);
    } catch (e) {
      console.warn("[admin/recover-stuck-report] waitUntil unavailable:", e);
    }
    // Don't await — return immediately so the caller doesn't block on the
    // 300s function ceiling. The function continues in the background.
    return NextResponse.json({ report_id: reportId, status: "started" }, { status: 202 });
  }

  const result = await recoverReport(admin, reportId);
  return NextResponse.json(result, { status: result.status === "recovered" ? 200 : 500 });
}

// GET returns the current set of stuck reports, OR a single report's
// math snapshot when ?token=... is provided (Phase 27 — used to verify
// the recoverable-slice fix by fetching the persisted math.lines for a
// report we don't have the UUID of).
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
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const id = url.searchParams.get("report_id");
  if (token || id) {
    const q = admin
      .from("reports")
      .select("id, token, status, brand_id, narrative_json, generated_at, error_message");
    const { data, error } = await (token
      ? q.eq("token", token).maybeSingle()
      : q.eq("id", id as string).maybeSingle());
    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? "not found" },
        { status: 404 },
      );
    }
    const narr = (data.narrative_json ?? null) as any;
    const lines = narr?.math?.lines ?? [];
    const pickLine = (key: string) =>
      lines.find((l: any) => l?.key === key)?.value ?? null;
    return NextResponse.json({
      id: data.id,
      token: data.token,
      status: data.status,
      brand_id: data.brand_id,
      generated_at: data.generated_at,
      error_message: data.error_message,
      report_mode: narr?.report_mode ?? null,
      brand_controlled_pct: narr?.brand_controlled_pct ?? null,
      recoverable_revenue_dollars: narr?.recoverable_revenue_dollars ?? null,
      math_snapshot: {
        revenue: pickLine("revenue"),
        wholesale_invoice: pickLine("wholesale_invoice"),
        current_profit: pickLine("current_profit"),
        reseller_margin: pickLine("reseller_margin"),
        recouped_shipping: pickLine("recouped_shipping"),
        labor_cost: pickLine("labor_cost"),
        new_profit: pickLine("new_profit"),
        delta_profit: pickLine("delta_profit"),
        exit_lift: pickLine("exit_lift"),
      },
      cover: {
        delta_profit: narr?.cover?.delta_profit ?? null,
        exit_lift: narr?.cover?.exit_lift ?? null,
        kpis: narr?.cover?.kpis ?? null,
      },
    });
  }
  const stuck = await findStuckReports(admin);
  return NextResponse.json({ stuck });
}
