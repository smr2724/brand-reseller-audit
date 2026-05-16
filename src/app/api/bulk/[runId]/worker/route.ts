/**
 * Phase 75 — POST /api/bulk/[runId]/worker (internal).
 *
 * Auth: requires `x-cron-secret` header to equal env CRON_SECRET (or
 * the standard Authorization: Bearer <secret> shape used by other
 * Vercel cron entrypoints). Safety belts on top of the route are the
 * same shape as the existing /api/cron/* routes.
 *
 * Each invocation:
 *   1. Sets bulk_runs.status='running' if currently 'pending'.
 *   2. Atomically claims the next 'queued' brand for this run.
 *   3. If none queued → finishes the run, builds + emails the report.
 *   4. Otherwise → runs the per-brand pipeline (worker.ts), then
 *      re-invokes itself fire-and-forget for the next brand.
 *
 * The fire-and-forget self-recursion keeps each invocation well under
 * Vercel's function timeout while processing brands sequentially.
 *
 * Safety belts (NEVER remove): runtime, dynamic, fetchCache, revalidate, maxDuration.
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { claimNextQueuedBrand, processBulkBrand } from "@/lib/bulk/worker";
import { renderBulkRunReportHtml, type BulkReportBrand } from "@/lib/bulk/report";
import { sendTransactionalEmail } from "@/lib/email/resend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 300;

const STEVE_TO = "steve@rollemanagementgroup.com";

function authorize(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Phase 75 safety belt: in production, missing CRON_SECRET MUST be a hard 401.
    // Only allow the dev bypass when not running in production.
    if (process.env.NODE_ENV === 'production') {
      return false;
    }
    return true;
  }
  const direct = req.headers.get("x-cron-secret");
  if (direct && direct === expected) return true;
  const auth = req.headers.get("authorization") ?? "";
  if (auth === `Bearer ${expected}`) return true;
  const vercelCron = req.headers.get("x-vercel-cron-signature");
  if (vercelCron && vercelCron === expected) return true;
  return false;
}

function resolveOrigin(req: Request): string {
  const envBase = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

function kickSelf(req: Request, runId: string): void {
  const origin = resolveOrigin(req);
  const url = `${origin}/api/bulk/${runId}/worker`;
  const secret = process.env.CRON_SECRET;
  fetch(url, {
    method: "POST",
    headers: secret ? { "x-cron-secret": secret } : {},
    cache: "no-store",
  }).catch((e) => {
    console.warn(
      `[bulk-worker] self-kick failed for run ${runId}:`,
      String(e?.message ?? e),
    );
  });
}

async function finalize(req: Request, runId: string): Promise<NextResponse> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  const { data: run } = await admin
    .from("bulk_runs")
    .select(
      "id, user_id, status, total_brands, started_at, completed_at, report_email_sent_at",
    )
    .eq("id", runId)
    .maybeSingle();
  if (!run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  // Already finalized? Bail out idempotently.
  if (run.status === "completed" && run.report_email_sent_at) {
    return NextResponse.json({ done: true, already_finalized: true });
  }

  const nowIso = new Date().toISOString();
  if (run.status !== "completed") {
    await admin
      .from("bulk_runs")
      .update({
        status: "completed",
        completed_at: nowIso,
        current_brand_id: null,
        current_brand_name: null,
        updated_at: nowIso,
      })
      .eq("id", runId);
  }

  // Build + send the email.
  const { data: brandsRaw } = await admin
    .from("bulk_run_brands")
    .select(
      "position, input_name, brand_id, status, qualified, disqualification_reason, selected_entity_name, resolved_owner_domain, contact_name, contact_email, email_verifier, email_status, outlook_draft_id, outlook_draft_web_link, brand_seven_x_value, legion_opportunity, error_message, error_step",
    )
    .eq("bulk_run_id", runId)
    .order("position", { ascending: true });

  const brands = (brandsRaw ?? []) as BulkReportBrand[];

  const origin = resolveOrigin(req);
  const report = renderBulkRunReportHtml({
    runId,
    totalBrands: run.total_brands as number,
    startedAt: (run.started_at as string | null) ?? null,
    completedAt: (run.completed_at as string | null) ?? nowIso,
    appBaseUrl: origin,
    brands,
  });

  let emailOk = false;
  let emailError: string | null = null;
  try {
    const sendRes = await sendTransactionalEmail({
      to: STEVE_TO,
      subject: report.subject,
      html: report.html,
      text: report.text,
    });
    emailOk = sendRes.ok;
    if (!emailOk) emailError = sendRes.error ?? "send failed";
  } catch (e) {
    emailError = e instanceof Error ? e.message : String(e);
  }

  if (emailOk) {
    await admin
      .from("bulk_runs")
      .update({
        report_email_sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId);
  } else {
    console.warn(
      `[bulk-worker] report email send failed for run ${runId}: ${emailError}`,
    );
  }

  return NextResponse.json({
    done: true,
    email_sent: emailOk,
    email_error: emailError,
  });
}

export async function POST(
  req: Request,
  { params }: { params: { runId: string } },
) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const runId = params.runId;
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  // Flip pending → running, idempotently.
  const { data: existingRun } = await admin
    .from("bulk_runs")
    .select("id, status")
    .eq("id", runId)
    .maybeSingle<{ id: string; status: string }>();
  if (!existingRun) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  if (existingRun.status === "pending") {
    await admin
      .from("bulk_runs")
      .update({
        status: "running",
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId)
      .eq("status", "pending");
  }

  // Claim the next queued brand. If none — finalize the run.
  const claimed = await claimNextQueuedBrand(admin, runId);
  if (!claimed) {
    return finalize(req, runId);
  }

  // Process this brand end-to-end. processBulkBrand never throws; on
  // failure it leaves the row in status='error' so the next claim
  // moves on.
  let processError: string | undefined;
  try {
    const result = await processBulkBrand(claimed.id);
    if (!result.ok) processError = result.error;
  } catch (e) {
    processError = e instanceof Error ? e.message : String(e);
    console.error(
      `[bulk-worker] unexpected throw processing ${claimed.id}:`,
      processError,
    );
  }

  // Fire-and-forget kick the next iteration.
  kickSelf(req, runId);

  return NextResponse.json({
    processed: claimed.id,
    next: "kicked",
    process_error: processError ?? null,
  });
}
