/**
 * Job queue helpers — Vercel-friendly background processing using Supabase as the queue.
 *
 * Architecture:
 *  - Jobs are rows in `jobs` table with status pending|running|complete|failed|cancelled
 *  - A `dispatch` request fans out parallel `run` requests (one per pending job, capped at concurrency)
 *  - Each `run` invocation pulls one job, marks running, executes it, marks complete/failed
 *  - When a job completes, dispatcher is re-kicked to fire next batch
 *  - Sweeps aggregate many child jobs and roll up progress
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runScan } from "./scan";
import { runSupplierScan } from "./suppliers";

/** Service-role admin client used by background workers (bypasses RLS). */
export function createAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set — required for background jobs");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export function getInternalToken(): string {
  const t = process.env.INTERNAL_JOB_TOKEN;
  if (!t) throw new Error("INTERNAL_JOB_TOKEN not set");
  return t;
}

export type JobType = "scan" | "supplier_scan";
export type JobStatus = "pending" | "running" | "complete" | "failed" | "cancelled";

export interface JobRow {
  id: string;
  user_id: string;
  type: JobType;
  status: JobStatus;
  payload: any;
  result_summary: any;
  error: string | null;
  progress: number;
  parent_sweep_id: string | null;
  related_opportunity_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const DISPATCH_CONCURRENCY = 4;

/** Internal: get the public origin we can self-call from a server route. */
function getBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    "http://localhost:3000"
  );
}

/**
 * Dispatcher: claim up to N pending jobs for this user and fire async run() requests.
 * Returns immediately — does NOT wait for the runs to complete.
 */
export async function dispatchJobs(supabase: SupabaseClient, userId: string, internalToken: string) {
  // Find pending jobs for this user, oldest first
  const { data: pending } = await supabase
    .from("jobs")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(DISPATCH_CONCURRENCY);

  if (!pending?.length) return { kicked: 0 };

  const base = getBaseUrl();
  // Fire-and-forget — each call hits /api/jobs/run with the job_id.
  // We do NOT await these; Vercel will keep them alive long enough (up to maxDuration).
  for (const j of pending) {
    fetch(`${base}/api/jobs/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": internalToken,
      },
      body: JSON.stringify({ job_id: j.id, user_id: userId }),
    }).catch(() => {
      /* ignore — the job will still be picked up on the next dispatch */
    });
  }

  return { kicked: pending.length };
}

/**
 * Run a single job. Atomically claims it (pending → running), executes,
 * writes back complete/failed, then re-kicks the dispatcher for the next batch.
 */
export async function runJob(
  supabase: SupabaseClient,
  jobId: string,
  internalToken: string,
): Promise<{ ok: boolean; status: JobStatus; error?: string }> {
  // Claim atomically
  const { data: claimed, error: claimErr } = await supabase
    .from("jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "pending")
    .select()
    .single();

  if (claimErr || !claimed) {
    // Already claimed or doesn't exist — nothing to do
    return { ok: false, status: "running", error: claimErr?.message ?? "already claimed" };
  }

  const job = claimed as JobRow;

  try {
    let result: any;
    let opportunityId: string | null = null;

    if (job.type === "scan") {
      const seed = String(job.payload?.seed_keyword ?? "").trim();
      const depth = (job.payload?.depth ?? "standard") as "quick" | "standard" | "deep";
      if (!seed) throw new Error("scan job missing seed_keyword");

      const { data: scanRow, error: scanErr } = await supabase
        .from("scans")
        .insert({
          user_id: job.user_id,
          seed_keyword: seed,
          marketplace: "amazon_us",
          scan_depth: depth,
          status: "running",
          raw_input: { from_job: job.id, ...(job.payload ?? {}) },
        })
        .select()
        .single();
      if (scanErr || !scanRow) throw new Error(scanErr?.message ?? "failed to create scan row");

      const r = await runScan({
        scanId: scanRow.id,
        userId: job.user_id,
        seedKeyword: seed,
        depth,
        supabase,
      });
      result = { scan_id: scanRow.id, ...r };
      opportunityId = (r as any)?.opportunityId ?? null;
    } else if (job.type === "supplier_scan") {
      const oppId = String(job.payload?.opportunity_id ?? job.related_opportunity_id ?? "");
      if (!oppId) throw new Error("supplier_scan missing opportunity_id");

      // Look up opportunity
      const { data: opp } = await supabase
        .from("opportunities")
        .select("id, name, main_keyword")
        .eq("id", oppId)
        .single();
      if (!opp) throw new Error("opportunity not found");

      const { data: scanRow } = await supabase
        .from("supplier_scans")
        .insert({
          user_id: job.user_id,
          opportunity_id: opp.id,
          status: "running",
          started_at: new Date().toISOString(),
          raw_input: { from_job: job.id },
        })
        .select()
        .single();

      const r = await runSupplierScan({
        scanId: scanRow?.id ?? "",
        userId: job.user_id,
        opportunityId: opp.id,
        seedKeyword: opp.main_keyword,
        opportunityName: opp.name,
        supabase,
      });

      if (scanRow?.id) {
        await supabase
          .from("supplier_scans")
          .update({
            status: "complete",
            completed_at: new Date().toISOString(),
            candidates_found: (r as any)?.candidates_found ?? null,
            candidates_qualified: (r as any)?.candidates_qualified ?? null,
          })
          .eq("id", scanRow.id);
      }

      result = r;
      opportunityId = opp.id;
    } else {
      throw new Error(`unknown job type: ${job.type}`);
    }

    await supabase
      .from("jobs")
      .update({
        status: "complete",
        progress: 100,
        completed_at: new Date().toISOString(),
        result_summary: result ?? {},
        related_opportunity_id: opportunityId ?? job.related_opportunity_id,
      })
      .eq("id", job.id);

    if (job.parent_sweep_id) await rollupSweep(supabase, job.parent_sweep_id);

    // Kick the next batch (fire-and-forget)
    dispatchJobs(supabase, job.user_id, internalToken).catch(() => {});

    return { ok: true, status: "complete" };
  } catch (e: any) {
    const errMsg = String(e?.message ?? e).slice(0, 800);
    await supabase
      .from("jobs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error: errMsg,
      })
      .eq("id", job.id);

    if (job.parent_sweep_id) await rollupSweep(supabase, job.parent_sweep_id);
    dispatchJobs(supabase, job.user_id, internalToken).catch(() => {});

    return { ok: false, status: "failed", error: errMsg };
  }
}

/** Roll up child job counts onto the parent sweep, mark complete when all done. */
export async function rollupSweep(supabase: SupabaseClient, sweepId: string) {
  const { data: jobs } = await supabase
    .from("jobs")
    .select("status")
    .eq("parent_sweep_id", sweepId);

  if (!jobs) return;

  const total = jobs.length;
  const complete = jobs.filter((j: any) => j.status === "complete").length;
  const failed = jobs.filter((j: any) => j.status === "failed").length;
  const allDone = jobs.every((j: any) => ["complete", "failed", "cancelled"].includes(j.status));
  const anyRunning = jobs.some((j: any) => j.status === "running");

  const update: any = {
    total_jobs: total,
    complete_jobs: complete,
    failed_jobs: failed,
  };
  if (allDone) {
    update.status = failed === total ? "failed" : "complete";
    update.completed_at = new Date().toISOString();
  } else if (anyRunning) {
    update.status = "running";
  }

  await supabase.from("sweeps").update(update).eq("id", sweepId);
}
