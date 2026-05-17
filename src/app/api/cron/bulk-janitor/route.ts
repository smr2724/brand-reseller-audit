/**
 * Phase 82 — Bulk Pipeline Janitor.
 *
 * Runs every 2 minutes (see vercel.json). Detects bulk runs whose
 * worker self-kick was dropped or evicted by Vercel, marks the stuck
 * brand row as `error` with a clear step + message, then re-kicks the
 * worker so the run advances to the next queued brand.
 *
 * The fire-and-forget worker self-kick chain is fast enough on the
 * happy path that a 90s threshold on `bulk_runs.updated_at` is well
 * past Phase 79's longest legitimate Keepa wait. We do NOT touch runs
 * younger than that.
 *
 * Soft caps (per-step), keyed off the stuck brand's `updated_at`:
 *   keepa_searching        90s
 *   keepa_enriching       240s   (covers Phase 79 90s timeout + 2s retry + slack)
 *   qualifying             60s
 *   resolving_owner        90s
 *   discovering_contacts  120s   (Apollo + Hunter cascade)
 *   verifying_email        60s   (MV is fast)
 *   drafting               60s
 *   everything else        90s
 *
 * After 10 consecutive kicks on the same run we mark the run itself
 * `error` and stop — prevents an infinite-kick loop on a broken row.
 *
 * Phase 82 review fix: the run-level `updated_at < now() - 90s` filter
 * is only a candidate gate — the kick/increment decision depends on
 * whether the CURRENT in-flight brand row has actually exceeded its
 * per-step soft cap. A long-running but healthy brand (e.g. 240s in
 * keepa_enriching) no longer accumulates noop kicks toward the 10-kick
 * abandon ceiling.
 *
 * Safety belts (NEVER remove):
 *   • Authorization: Bearer ${CRON_SECRET} header — mandatory per project rule
 *   • runtime = nodejs
 *   • dynamic = force-dynamic
 *   • fetchCache = force-no-store
 *   • revalidate = 0
 *   • maxDuration = 60
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 60;

const RUN_STUCK_THRESHOLD_MS = 90_000;
const KICK_ABANDON_THRESHOLD = 10;

// Per-step soft caps on `bulk_run_brands.updated_at`. If the brand row
// hasn't been touched for longer than this, mark it `error` and move on.
//
// Phase 82 R2 review fix B1 — aligned with the actual worker statuses
// written by `src/lib/bulk/worker.ts`. The prior list watched two names
// that the worker never writes (`enriching`, `contact_discovery`) and
// missed the real-world stall points (Apollo / Hunter / MillionVerifier
// hangs in `discovering_contacts` / `verifying_email`).
const STEP_SOFT_CAP_MS: Record<string, number> = {
  keepa_searching: 90_000,
  keepa_enriching: 240_000,
  qualifying: 60_000,
  resolving_owner: 90_000,
  discovering_contacts: 120_000,
  verifying_email: 60_000,
  drafting: 60_000,
};
const DEFAULT_STEP_SOFT_CAP_MS = 90_000;

const STUCK_BRAND_STATUSES = [
  "keepa_searching",
  "keepa_enriching",
  "qualifying",
  "resolving_owner",
  "discovering_contacts",
  "verifying_email",
  "drafting",
] as const;

function authorize(req: Request): boolean {
  // Phase 82 safety belt: CRON_SECRET auth is MANDATORY. Unlike some
  // recovery routes, the janitor never permits a missing-secret dev
  // bypass — a janitor mis-fire could mark live brand rows as `error`,
  // so we hard-401 if the header doesn't match.
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
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

async function kickWorker(req: Request, runId: string): Promise<void> {
  const origin = resolveOrigin(req);
  const url = `${origin}/api/bulk/${runId}/worker`;
  const secret = process.env.CRON_SECRET;
  // Fire-and-forget with a 3s ceiling — Vercel routes accept the request
  // and continue running after we abort, which is exactly the behavior
  // we want. Phase 83 — bumped from 2s to 3s to match the worker's
  // self-kick window; under load the worker handshake occasionally took
  // longer than 2s to land. Swallowing the abort here is the success path.
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 3_000);
  try {
    await fetch(url, {
      method: "POST",
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    // Expected — fire-and-forget kick. AbortError or any transient
    // error is acceptable; the worker has already accepted the request.
  } finally {
    clearTimeout(t);
  }
}

interface StuckRun {
  id: string;
  janitor_kick_count: number;
}

interface StuckBrand {
  id: string;
  bulk_run_id: string;
  status: string;
  updated_at: string;
}

interface ActionResult {
  run_id: string;
  action: "kicked" | "abandoned" | "noop" | "safety_kicked";
  brands_marked_error?: string[];
  error_steps?: string[];
  kick_count?: number;
}

/**
 * Phase 83 — Bug #4 helper. Atomically bumps `janitor_kick_count` via
 * the SECURITY DEFINER RPC (migration 0065). Falls back to a non-atomic
 * write when the RPC throws so the janitor still functions pre-migration.
 * Returns the post-increment kick count.
 */
async function incrementJanitorKick(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  runId: string,
  currentCount: number,
): Promise<number> {
  if (!admin) return currentCount;
  let nextCount = currentCount + 1;
  try {
    const { data: rpcCount } = await admin.rpc("increment_janitor_kick", {
      p_run_id: runId,
    });
    if (typeof rpcCount === "number") {
      nextCount = rpcCount;
    }
  } catch (e) {
    console.warn(
      `[bulk-janitor] increment_janitor_kick RPC failed for ${runId}:`,
      String((e as Error)?.message ?? e),
    );
    const nowIso = new Date().toISOString();
    await admin
      .from("bulk_runs")
      .update({
        janitor_kick_count: nextCount,
        last_janitor_kick_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", runId);
  }
  return nextCount;
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

  const cutoff = new Date(Date.now() - RUN_STUCK_THRESHOLD_MS).toISOString();

  const { data: stuckRunsRaw, error: runsErr } = await admin
    .from("bulk_runs")
    .select("id, janitor_kick_count")
    .eq("status", "running")
    .lt("updated_at", cutoff);

  if (runsErr) {
    return NextResponse.json(
      { error: `bulk_runs select: ${runsErr.message}` },
      { status: 500 },
    );
  }

  const stuckRuns = (stuckRunsRaw ?? []) as StuckRun[];
  if (!stuckRuns.length) {
    return NextResponse.json({ processed: 0, results: [] });
  }

  const results: ActionResult[] = [];
  const nowMs = Date.now();

  for (const run of stuckRuns) {
    const kickCount = Number(run.janitor_kick_count ?? 0);

    // Abandon-the-run gate. Once we've kicked 10 times without the run
    // either completing or making progress past the 90s window, mark
    // the whole run errored and stop. Prevents an infinite-kick loop.
    if (kickCount >= KICK_ABANDON_THRESHOLD) {
      const nowIso = new Date().toISOString();
      await admin
        .from("bulk_runs")
        .update({
          status: "error",
          error_message: "janitor abandoned after 10 kicks",
          completed_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", run.id)
        .eq("status", "running");
      results.push({
        run_id: run.id,
        action: "abandoned",
        kick_count: kickCount,
      });
      continue;
    }

    // Identify the currently-processing brand(s) for this run.
    const { data: brandsRaw } = await admin
      .from("bulk_run_brands")
      .select("id, bulk_run_id, status, updated_at")
      .eq("bulk_run_id", run.id)
      .in("status", [...STUCK_BRAND_STATUSES]);

    const brands = (brandsRaw ?? []) as StuckBrand[];

    // Phase 82 review fix #1: only mark-error a brand row when it has
    // actually exceeded its per-step soft cap. Iterate all such rows
    // (review fix #9 — drop the single-brand `break;` so multiple
    // orphans in the same run are cleaned up in one pass).
    const markedErrorBrands: string[] = [];
    const markedErrorSteps: string[] = [];

    for (const brand of brands) {
      const stepCap =
        STEP_SOFT_CAP_MS[brand.status] ?? DEFAULT_STEP_SOFT_CAP_MS;
      const brandUpdatedAt = brand.updated_at
        ? new Date(brand.updated_at).getTime()
        : 0;
      const stuckMs = nowMs - brandUpdatedAt;
      if (!Number.isFinite(brandUpdatedAt) || stuckMs <= stepCap) continue;

      const stuckSeconds = Math.round(stuckMs / 1000);
      const nowIso = new Date().toISOString();
      // Phase 82 review fix #3: status-conditional update so we don't
      // overwrite a row that has already been moved on by the worker
      // (the row may still appear stuck in our SELECT snapshot but a
      // late patchRow could have just landed it in qualifying/etc.).
      const { data: updatedRows } = await admin
        .from("bulk_run_brands")
        .update({
          status: "error",
          error_step: brand.status,
          error_message: `janitor: stuck after ${stuckSeconds}s`,
          completed_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", brand.id)
        .eq("status", brand.status)
        .select("id");
      if (updatedRows && updatedRows.length > 0) {
        markedErrorBrands.push(brand.id);
        markedErrorSteps.push(brand.status);
      }
    }

    // Phase 83 — Bug #4 + Bug #3 shared post-action path. We kick the
    // worker (and increment the counter) in two cases:
    //   • mark-error path: a stuck brand was just transitioned to error
    //     so the worker chain needs a re-kick to advance.
    //   • safety-net path (NEW): no brand is in a stuck status, but the
    //     run is stale >90s AND at least one brand is still `queued`.
    //     This catches the "worker dropped its self-kick after a
    //     terminal brand transition" failure mode that left run b6341dd2
    //     idle for 152s between Milbon's 429 error and Minimalist's
    //     pickup. A manual curl re-kick at 10:21 PDT proved a kick was
    //     all that was needed.
    let actedThisCron = false;
    let action: ActionResult["action"] = "noop";

    if (markedErrorBrands.length > 0) {
      actedThisCron = true;
      action = "kicked";
    } else {
      // Bug #3 safety net — only check when there is no stuck brand.
      const { data: queuedRows } = await admin
        .from("bulk_run_brands")
        .select("id")
        .eq("bulk_run_id", run.id)
        .eq("status", "queued")
        .limit(1);
      if (queuedRows && queuedRows.length > 0) {
        actedThisCron = true;
        action = "safety_kicked";
      }
    }

    if (!actedThisCron) {
      // Healthy long-running brand — record a noop. Do NOT increment
      // kick_count, do NOT re-kick. This keeps healthy brands from
      // pushing the run toward the 10-kick abandon ceiling.
      results.push({
        run_id: run.id,
        action: "noop",
        kick_count: kickCount,
      });
      continue;
    }

    // Bug #4 — increment counter on EVERY acted-on cron pass (both the
    // mark-error path and the new safety-net path) via the shared
    // atomic RPC. Then read the abandon check against the post-increment
    // count so the abandon threshold is crossed cleanly at exactly 10.
    const nextKickCount = await incrementJanitorKick(admin, run.id, kickCount);

    if (nextKickCount > KICK_ABANDON_THRESHOLD) {
      // Crossed the ceiling on THIS increment — abandon now so we don't
      // fire another doomed kick. The earlier kickCount >= threshold
      // gate at the top of the loop catches subsequent cron passes.
      const nowIso = new Date().toISOString();
      await admin
        .from("bulk_runs")
        .update({
          status: "error",
          error_message: "janitor abandoned after 10 kicks",
          completed_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", run.id)
        .eq("status", "running");
      results.push({
        run_id: run.id,
        action: "abandoned",
        kick_count: nextKickCount,
        brands_marked_error: markedErrorBrands,
        error_steps: markedErrorSteps,
      });
      continue;
    }

    await kickWorker(req, run.id);

    results.push({
      run_id: run.id,
      action,
      brands_marked_error: markedErrorBrands,
      error_steps: markedErrorSteps,
      kick_count: nextKickCount,
    });
  }

  return NextResponse.json({ processed: results.length, results });
}
