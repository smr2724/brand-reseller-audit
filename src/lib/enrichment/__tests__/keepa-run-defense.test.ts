/**
 * Phase 66 — Tests for Keepa enrichment hang defenses.
 *
 * Covers the matrix from the Phase 66 spec:
 *
 *   1. reapStaleRuns marks prior `running` rows past the stale threshold
 *      as `status='error'` with a populated error_message + completed_at.
 *   2. reapStaleRuns is a no-op when no stale rows exist.
 *   3. shouldAbortForWallClock returns true past the budget, false before.
 *   4. withDeadline rejects with a labeled error when the inner promise
 *      stalls past the deadline.
 *   5. withDeadline resolves cleanly when the inner promise lands in time.
 *   6. KEEPA_HARD_ASIN_CAP and KEEPA_ENRICHMENT_WALL_CLOCK_MS expose
 *      finite, positive defaults (so future env misconfiguration can't
 *      silently disable the defenses).
 *
 * Run with:
 *   npx tsx src/lib/enrichment/__tests__/keepa-run-defense.test.ts
 */
import assert from "node:assert/strict";
import {
  reapStaleRuns,
  shouldAbortForWallClock,
  withDeadline,
  KEEPA_HARD_ASIN_CAP,
  KEEPA_ENRICHMENT_WALL_CLOCK_MS,
  STALE_RUN_THRESHOLD_MS,
} from "../keepa-run-defense";

interface CapturedUpdate {
  table: string;
  patch: Record<string, unknown>;
  filters: Record<string, unknown>;
}

function makeFakeSupabase(matchedRows: { id: string }[]) {
  const captured: CapturedUpdate[] = [];
  return {
    captured,
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let pendingPatch: Record<string, unknown> = {};
      const builder: any = {
        update(patch: Record<string, unknown>) {
          pendingPatch = patch;
          return builder;
        },
        eq(col: string, val: unknown) {
          filters[`eq:${col}`] = val;
          return builder;
        },
        lte(col: string, val: unknown) {
          filters[`lte:${col}`] = val;
          return builder;
        },
        select(_cols?: string) {
          captured.push({ table, patch: pendingPatch, filters: { ...filters } });
          return Promise.resolve({ data: matchedRows, error: null });
        },
      };
      return builder;
    },
  };
}

async function test_reapStaleRuns_marksAndLogs() {
  const fake = makeFakeSupabase([{ id: "stale-1" }, { id: "stale-2" }]);
  const res = await reapStaleRuns(fake as any, "brand-xyz", "keepa");
  assert.equal(res.reaped, 2, "should report two reaped rows");
  assert.equal(res.threshold_ms, STALE_RUN_THRESHOLD_MS, "exposes threshold");
  assert.ok(!res.error, "no error on success path");

  assert.equal(fake.captured.length, 1, "exactly one update call");
  const call = fake.captured[0];
  assert.equal(call.table, "enrichment_runs");
  assert.equal(call.patch.status, "error", "status must be 'error', not 'running' or 'failed'");
  assert.ok(typeof call.patch.completed_at === "string", "completed_at populated");
  assert.ok(
    typeof call.patch.error_message === "string" &&
      (call.patch.error_message as string).includes("[phase66]"),
    "error_message tagged with [phase66]",
  );
  assert.equal(call.filters["eq:brand_id"], "brand-xyz");
  assert.equal(call.filters["eq:source"], "keepa");
  assert.equal(call.filters["eq:status"], "running");
  assert.ok(call.filters["lte:started_at"], "filters by started_at cutoff");
  console.log("ok: reapStaleRuns marks stuck rows error + populates error_message + completed_at");
}

async function test_reapStaleRuns_noOpOnEmpty() {
  const fake = makeFakeSupabase([]);
  const res = await reapStaleRuns(fake as any, "brand-fresh");
  assert.equal(res.reaped, 0, "nothing to reap");
  assert.ok(!res.error, "still no error");
  console.log("ok: reapStaleRuns is a clean no-op when no stale rows match");
}

async function test_reapStaleRuns_softFailsOnDbError() {
  const fake = {
    from() {
      const b: any = {
        update() { return b; },
        eq() { return b; },
        lte() { return b; },
        select() {
          return Promise.resolve({ data: null, error: { message: "boom" } });
        },
      };
      return b;
    },
  };
  const res = await reapStaleRuns(fake as any, "brand-bad");
  assert.equal(res.reaped, 0);
  assert.equal(res.error, "boom", "surface the db error but don't throw");
  console.log("ok: reapStaleRuns soft-fails on DB error so the new run can proceed");
}

function test_shouldAbortForWallClock() {
  const startedAt = 1_000_000;
  // Before the budget elapses → don't abort
  assert.equal(shouldAbortForWallClock(startedAt, 30_000, startedAt + 10_000), false);
  // Right at the budget → abort
  assert.equal(shouldAbortForWallClock(startedAt, 30_000, startedAt + 30_000), true);
  // Past the budget → abort
  assert.equal(shouldAbortForWallClock(startedAt, 30_000, startedAt + 60_000), true);
  console.log("ok: shouldAbortForWallClock crosses the budget cleanly");
}

async function test_withDeadline_timesOut() {
  const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200));
  let thrown: Error | null = null;
  try {
    await withDeadline(slow, 50, "test-slow");
  } catch (e) {
    thrown = e as Error;
  }
  assert.ok(thrown, "should throw on deadline");
  assert.match(thrown!.message, /phase66.*timed out.*test-slow/);
  console.log("ok: withDeadline rejects with a labeled error past the deadline");
}

async function test_withDeadline_resolvesInTime() {
  const fast = new Promise<number>((resolve) => setTimeout(() => resolve(42), 10));
  const result = await withDeadline(fast, 200, "test-fast");
  assert.equal(result, 42);
  console.log("ok: withDeadline forwards the resolved value when in time");
}

function test_envDefaultsAreSafe() {
  assert.ok(
    Number.isFinite(KEEPA_HARD_ASIN_CAP) && KEEPA_HARD_ASIN_CAP > 0,
    "KEEPA_HARD_ASIN_CAP must be a finite positive integer",
  );
  assert.ok(
    Number.isFinite(KEEPA_ENRICHMENT_WALL_CLOCK_MS) && KEEPA_ENRICHMENT_WALL_CLOCK_MS > 0,
    "KEEPA_ENRICHMENT_WALL_CLOCK_MS must be a finite positive integer",
  );
  // Defaults documented in the source: 5000 ASINs / 240s budget.
  assert.equal(KEEPA_HARD_ASIN_CAP, 5000, "default ASIN cap = 5000");
  assert.equal(KEEPA_ENRICHMENT_WALL_CLOCK_MS, 240_000, "default budget = 240s");
  console.log("ok: env-driven defaults are finite, positive, and match the spec");
}

(async () => {
  test_envDefaultsAreSafe();
  test_shouldAbortForWallClock();
  await test_reapStaleRuns_marksAndLogs();
  await test_reapStaleRuns_noOpOnEmpty();
  await test_reapStaleRuns_softFailsOnDbError();
  await test_withDeadline_timesOut();
  await test_withDeadline_resolvesInTime();
  console.log("\nPhase 66 keepa-run-defense tests: ALL GREEN");
})().catch((e) => {
  console.error("test failure:", e);
  process.exit(1);
});
