/**
 * Phase 66 — Keepa enrichment hang defense.
 *
 * Helpers that make the Keepa enrichment pipeline self-terminating and
 * fully observable. They exist as a small standalone module so they can
 * be unit-tested without dragging in the full Supabase client surface.
 *
 * Background:
 *   - Sport-Tek (1,631 products) hung 4 consecutive enrichment runs on
 *     2026-05-11 between 03:11–03:45 UTC. Each row stayed at status
 *     `running` with `tokens_used=null` and `asins_found=null` for
 *     3, 13, 23, and 37 minutes respectively. Realspace (72 ASINs) and
 *     Shearwater (57 ASINs) completed in 1m39s on the same key/domain.
 *   - Root cause was a wall-clock budget overrun: the function got killed
 *     by Vercel before the catch block could flip the row to
 *     `failed`/`error`. The DB stayed wedged at `running` forever.
 *
 * What this module ships:
 *   - {@link reapStaleRuns}: any new run flips prior rows for the same
 *     brand that have been `running` longer than a threshold to status
 *     `error` with a populated `error_message` and `completed_at`.
 *   - {@link KEEPA_HARD_ASIN_CAP}: hard ceiling on accumulated ASINs
 *     during pagination so a future runaway brand can't trash the budget.
 *   - {@link KEEPA_ENRICHMENT_WALL_CLOCK_MS}: per-run wall-clock budget
 *     so the orchestrator can self-terminate before Vercel kills it,
 *     guaranteeing a terminal DB write.
 *   - {@link shouldAbortForWallClock}: pure predicate used by the
 *     orchestrator's internal checkpoints.
 *
 * None of these helpers depend on a running Supabase instance; the
 * orchestrator passes a thin client surface so tests can use a fake.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Maximum accumulated ASINs we will pull through Keepa brand search +
 * variation expansion before forcing the loop to terminate. Even a
 * 10,000-ASIN catalog (Yeti, OXO) can't justify burning the whole
 * function budget — the long tail contributes essentially zero TTM
 * revenue once the rank ceiling has filtered the active SKUs. 5,000
 * gives us plenty of headroom over the current 500-parent target.
 */
export const KEEPA_HARD_ASIN_CAP = (() => {
  const raw = Number(process.env.KEEPA_HARD_ASIN_CAP ?? "5000");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5000;
})();

/**
 * Hard wall-clock cap for a single Keepa enrichment run. Vercel's
 * function `maxDuration` is 300s on the user-facing keepa + verify-brand
 * routes and on the create-from-lookup / recovery paths (bumped from 60s
 * in the Phase 66 follow-up after both reviewers flagged that the 240s
 * budget was dead code under a 60s ceiling). The conservative default
 * of 240s keeps a safety margin under the 300s ceiling so the
 * orchestrator's terminal DB write always lands before the platform
 * kills the function. Override via env for one-off large brands.
 */
export const KEEPA_ENRICHMENT_WALL_CLOCK_MS = (() => {
  const raw = Number(process.env.KEEPA_ENRICHMENT_WALL_CLOCK_MS ?? "240000");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 240_000;
})();

/**
 * A "stale" running run is one that started more than this many minutes
 * ago. Healthy runs finish in 1–9 minutes (Realspace 1m39s, Shearwater
 * 1m39s, Snoop 4.8s). 10 minutes leaves plenty of room for the largest
 * legitimate run while still cleaning up zombies before the next user
 * retry adds another wedged row.
 */
export const STALE_RUN_THRESHOLD_MIN = 10;
export const STALE_RUN_THRESHOLD_MS = STALE_RUN_THRESHOLD_MIN * 60 * 1000;

export interface StaleReapResult {
  reaped: number;
  threshold_ms: number;
  error?: string;
}

/**
 * Find any `enrichment_runs` rows for this brand that are still
 * `status='running'` past the stale threshold and mark them as
 * `status='error'` with `completed_at=now()` and an `error_message`
 * explaining that they were superseded by a newer run.
 *
 * Best-effort: a DB error returns a populated `error` field but does
 * not throw. The new run should proceed regardless.
 *
 * Phase 66 — added because hung Sport-Tek runs were left at `running`
 * indefinitely (Vercel function killed mid-flight before the catch
 * block could write a terminal state). Without this sweep, the
 * `enrichment_runs` table accumulates orphaned `running` rows that
 * confuse ops dashboards and any future "what's actively running"
 * check.
 */
export async function reapStaleRuns(
  supabase: Pick<SupabaseClient<any, any, any>, "from">,
  brand_id: string,
  source: string = "keepa",
  thresholdMs: number = STALE_RUN_THRESHOLD_MS,
): Promise<StaleReapResult> {
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();
  const reapedAt = new Date().toISOString();
  try {
    const { data, error } = await supabase
      .from("enrichment_runs")
      .update({
        status: "error",
        completed_at: reapedAt,
        error_message:
          `[phase66] superseded — run sat at status='running' past ${Math.floor(thresholdMs / 60000)}m threshold; ` +
          "likely Vercel function timeout before terminal write",
      })
      .eq("brand_id", brand_id)
      .eq("source", source)
      .eq("status", "running")
      .lte("started_at", cutoff)
      .select("id");
    if (error) {
      console.warn("[phase66] reapStaleRuns failed", {
        brand_id,
        source,
        error: error.message,
      });
      return { reaped: 0, threshold_ms: thresholdMs, error: error.message };
    }
    const reaped = Array.isArray(data) ? data.length : 0;
    if (reaped > 0) {
      console.log(
        "[phase66] stale enrichment_runs reaped",
        JSON.stringify({
          brand_id,
          source,
          reaped,
          threshold_ms: thresholdMs,
          cutoff,
        }),
      );
    }
    return { reaped, threshold_ms: thresholdMs };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[phase66] reapStaleRuns threw", { brand_id, source, error: msg });
    return { reaped: 0, threshold_ms: thresholdMs, error: msg };
  }
}

/**
 * Pure predicate: have we crossed the wall-clock budget? Callers should
 * check this at each loop iteration (pagination, per-chunk product
 * fetch) and bail out cleanly when true, marking the run `error` with
 * a populated message instead of letting Vercel kill the lambda.
 */
export function shouldAbortForWallClock(
  startedAtMs: number,
  budgetMs: number = KEEPA_ENRICHMENT_WALL_CLOCK_MS,
  nowMs: number = Date.now(),
): boolean {
  return nowMs - startedAtMs >= budgetMs;
}

/**
 * Wrap any promise with a wall-clock deadline. Resolves with the inner
 * value when it lands in time, or rejects with a labeled timeout error
 * when it doesn't. Used to bound a single `getProductDetails` chunk so
 * one stuck Keepa response can't wedge the whole pagination loop.
 *
 * Unlike `fetchWithTimeout` (which aborts the underlying request), this
 * version cannot kill the in-flight work — it just stops waiting on it
 * and surfaces an error the caller can route into the terminal-state
 * write. Node 18+'s default unhandled-rejection behavior is "warn", so
 * the stranded inner promise becomes a log line rather than a crash.
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`[phase66] withDeadline timed out after ${ms}ms [${label}]`)),
      ms,
    );
  });
  try {
    return (await Promise.race([promise, timeout])) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Phase 66 — Classify a thrown error message into the terminal
 * enrichment_runs status. Phase 66 proactive aborts (wall-clock, hard
 * cap, withDeadline timeout) tag their messages with the `[phase66]`
 * prefix so ops can distinguish "we proactively bailed out before
 * Vercel killed us" from generic downstream failures. Both outcomes
 * still flip the row out of `running`, satisfying the no-zombies
 * invariant.
 *
 * Exposed as a named helper so the substring-routing logic in the
 * orchestrator's catch block is independently unit-testable instead of
 * being a fragile inline `msg.includes("[phase66]")`.
 */
export function classifyTerminalStatus(errorMessage: string): "error" | "failed" {
  return typeof errorMessage === "string" && errorMessage.includes("[phase66]")
    ? "error"
    : "failed";
}

/**
 * Compact structured progress logger. Emits a JSON line under a known
 * event name so ops can grep Vercel logs by `event:"keepa_enrich_progress"`
 * to reconstruct exactly where any future hang got stuck.
 */
export function logKeepaProgress(
  fields: {
    brand_id: string;
    brand_name: string;
    stage: string;
    page?: number;
    chunk_index?: number;
    chunk_size?: number;
    accumulated?: number;
    response_size?: number;
    elapsed_ms: number;
    extra?: Record<string, unknown>;
  },
): void {
  const { extra, ...rest } = fields;
  console.log(
    JSON.stringify({
      event: "keepa_enrich_progress",
      ...rest,
      ...(extra ?? {}),
    }),
  );
}
