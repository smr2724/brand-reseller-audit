/**
 * Phase 66 follow-up — orchestrator catch-path tests for enrichBrandWithKeepa.
 *
 * Both reviewers flagged that the substring routing
 *   `msg.includes("[phase66]")` → status='error' vs 'failed'
 * in keepa-brand.ts's catch block was untested. This file fixes that by:
 *
 *   1. Unit-testing the extracted `classifyTerminalStatus` helper that
 *      keepa-brand.ts now delegates to. Direct, fast, no Supabase or
 *      network dependency.
 *
 *   2. Integration-testing the catch path end-to-end: a fake Supabase
 *      captures writes, global fetch is patched to make the inner Keepa
 *      brand search throw an Error whose message contains
 *      `[phase66] wall-clock budget exceeded`, and we assert that the
 *      `enrichment_runs` row was written with status='error' and a
 *      non-empty error_message.
 *
 *   3. Companion case: a *non*-Phase 66 thrown error must route to
 *      status='failed' so the routing is provably bidirectional.
 *
 * Run with:
 *   npx tsx src/lib/enrichment/__tests__/keepa-brand-catch-path.test.ts
 */
import assert from "node:assert/strict";

// Keepa needs these set before the module loads so searchProductsByBrand
// gets past its env guard and falls into the patched fetch path below.
process.env.KEEPA_API_KEY = "test-key";
process.env.KEEPA_DOMAIN_ID = "1";
process.env.KEEPA_MAX_PAGES_PER_BRAND = "5";

import { classifyTerminalStatus } from "../keepa-run-defense";

// ---------------------------------------------------------------------------
// Test 1 — classifyTerminalStatus is the routing primitive used by the
// orchestrator catch block. It must route messages that contain the
// [phase66] tag to "error" and everything else to "failed".
// ---------------------------------------------------------------------------
function test_classifyTerminalStatus() {
  assert.equal(
    classifyTerminalStatus("[phase66] wall-clock budget exceeded after brand_search"),
    "error",
    "phase66-tagged messages route to 'error'",
  );
  assert.equal(
    classifyTerminalStatus("[phase66] withDeadline timed out after 200000ms [getProductDetails]"),
    "error",
    "withDeadline timeout messages route to 'error'",
  );
  assert.equal(
    classifyTerminalStatus("Keepa 500: server unavailable"),
    "failed",
    "generic downstream errors route to 'failed'",
  );
  assert.equal(
    classifyTerminalStatus("KEEPA_API_KEY missing"),
    "failed",
    "env-missing errors route to 'failed'",
  );
  assert.equal(
    classifyTerminalStatus(""),
    "failed",
    "empty message routes to 'failed' (defensive)",
  );
  // Substring match is intentional — withDeadline tags its message
  // mid-string, so a prefix-only check would miss it.
  assert.equal(
    classifyTerminalStatus("network: caused by [phase66] guard"),
    "error",
    "tag may appear anywhere in the message, not just the prefix",
  );
  console.log("ok: classifyTerminalStatus routes [phase66] → error, others → failed");
}

// ---------------------------------------------------------------------------
// Test 2 — integration test of the orchestrator catch path. We let the
// real enrichBrandWithKeepa run, but rig the world so it crashes at the
// brand-search step with a [phase66] error message. The catch block must
// write status='error' to enrichment_runs with a non-empty error_message
// and re-throw.
// ---------------------------------------------------------------------------

interface CapturedUpdate {
  table: string;
  patch: Record<string, unknown>;
  filters: Record<string, unknown>;
}

interface FakeSupabaseHandle {
  captured: CapturedUpdate[];
  runIdAssigned: string;
}

/**
 * A fake Supabase that records every update and supports the exact
 * call shapes keepa-brand.ts uses: insert+select+single on
 * enrichment_runs (returns a synthetic run_id), the reapStaleRuns
 * update chain, and the catch-block updates on enrichment_runs +
 * brands.
 */
function makeFakeSupabase(): { client: any; handle: FakeSupabaseHandle } {
  const handle: FakeSupabaseHandle = {
    captured: [],
    runIdAssigned: "test-run-id-phase66",
  };

  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let pendingPatch: Record<string, unknown> = {};
      let pendingInsert: Record<string, unknown> | null = null;

      const builder: any = {
        update(patch: Record<string, unknown>) {
          pendingPatch = patch;
          return builder;
        },
        insert(row: Record<string, unknown>) {
          pendingInsert = row;
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
          // For reapStaleRuns, .select("id") resolves with empty data.
          // For enrichBrandWithKeepa's run-insert, .select("id").single()
          // is awaited; we resolve below in single().
          if (pendingInsert) {
            return {
              single: () =>
                Promise.resolve({
                  data: { id: handle.runIdAssigned },
                  error: null,
                }),
            };
          }
          if (Object.keys(pendingPatch).length > 0) {
            handle.captured.push({
              table,
              patch: pendingPatch,
              filters: { ...filters },
            });
            pendingPatch = {};
          }
          return Promise.resolve({ data: [], error: null });
        },
        single() {
          if (pendingInsert) {
            return Promise.resolve({
              data: { id: handle.runIdAssigned },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        // Some call sites await `.update(...).eq(...).eq(...)` with no
        // trailing `.select(...)`. The builder needs to be thenable so
        // the awaited chain resolves and records the patch.
        then(resolve: (v: any) => void, reject?: (e: any) => void) {
          try {
            if (Object.keys(pendingPatch).length > 0) {
              handle.captured.push({
                table,
                patch: pendingPatch,
                filters: { ...filters },
              });
              pendingPatch = {};
            }
            resolve({ data: null, error: null });
          } catch (e) {
            if (reject) reject(e);
          }
        },
      };
      return builder;
    },
  };
  return { client, handle };
}

/**
 * Mocks global fetch so any Keepa /query or /search call rejects with a
 * specific error. We let token-status calls succeed with a fat token
 * bucket so ensureTokens passes through and the orchestrator actually
 * reaches the brand-search call.
 */
function installFetchThatThrowsKeepaError(errorMessage: string) {
  (globalThis as any).fetch = async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("/token?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ tokensLeft: 4000, refillIn: 0, refillRate: 0 }),
        text: async () => "",
      } as any;
    }
    // Any other Keepa endpoint throws — we want the brand-search call
    // path to propagate this exact error up into enrichBrandWithKeepa's
    // catch block so we can assert the routing.
    throw new Error(errorMessage);
  };
}

async function runOrchestratorAndCapture(errorMessage: string) {
  // Late import so process.env is populated before keepa.ts loads.
  const { enrichBrandWithKeepa } = await import("../keepa-brand");
  const { client, handle } = makeFakeSupabase();
  installFetchThatThrowsKeepaError(errorMessage);

  let thrown: Error | null = null;
  try {
    await enrichBrandWithKeepa(client as any, {
      brand_id: "brand-under-test",
      brand_name: "Test Brand",
      user_id: "user-under-test",
    });
  } catch (e) {
    thrown = e as Error;
  }
  return { thrown, captured: handle.captured, runId: handle.runIdAssigned };
}

async function test_phase66_taggedError_routesToErrorStatus() {
  const { thrown, captured, runId } = await runOrchestratorAndCapture(
    "[phase66] wall-clock budget exceeded after brand_search; aborting before product fetch",
  );

  assert.ok(thrown, "orchestrator must rethrow the inner error");
  assert.match(
    thrown!.message,
    /\[phase66\]/,
    "the thrown error preserves the [phase66] tag",
  );

  // The catch block writes two updates: one to enrichment_runs, one to
  // brands. We only need the enrichment_runs one to prove the routing.
  const runUpdate = captured.find(
    (c) => c.table === "enrichment_runs" && c.filters["eq:id"] === runId,
  );
  assert.ok(
    runUpdate,
    `expected an enrichment_runs update for run_id=${runId}; got ${JSON.stringify(
      captured.map((c) => ({ table: c.table, filters: c.filters })),
    )}`,
  );
  assert.equal(
    runUpdate!.patch.status,
    "error",
    "phase66-tagged errors must write status='error', not 'failed'",
  );
  assert.ok(
    typeof runUpdate!.patch.error_message === "string" &&
      (runUpdate!.patch.error_message as string).length > 0,
    "error_message must be populated and non-empty",
  );
  assert.match(
    runUpdate!.patch.error_message as string,
    /\[phase66\]/,
    "error_message preserves the [phase66] tag",
  );
  assert.ok(
    typeof runUpdate!.patch.completed_at === "string",
    "completed_at must be set so the row leaves status='running'",
  );

  // Also confirm a parallel write to the brands table mirrors the error.
  const brandUpdate = captured.find(
    (c) => c.table === "brands" && c.filters["eq:id"] === "brand-under-test",
  );
  assert.ok(brandUpdate, "brands.enrichment_error must also be updated");
  assert.match(
    String(brandUpdate!.patch.enrichment_error),
    /\[phase66\]/,
    "brand-level enrichment_error mirrors the tagged message",
  );

  console.log(
    "ok: orchestrator catch path writes status='error' + error_message for [phase66] aborts",
  );
}

async function test_nonPhase66_error_routesToFailedStatus() {
  const { thrown, captured, runId } = await runOrchestratorAndCapture(
    "Keepa 500: backend unavailable",
  );

  assert.ok(thrown, "orchestrator rethrows on plain downstream failures too");

  const runUpdate = captured.find(
    (c) => c.table === "enrichment_runs" && c.filters["eq:id"] === runId,
  );
  assert.ok(runUpdate, "enrichment_runs catch-path update must run");
  assert.equal(
    runUpdate!.patch.status,
    "failed",
    "untagged downstream errors route to status='failed' (not 'error')",
  );
  assert.ok(
    typeof runUpdate!.patch.error_message === "string" &&
      (runUpdate!.patch.error_message as string).length > 0,
    "error_message is still populated for non-Phase-66 errors",
  );

  console.log(
    "ok: orchestrator catch path writes status='failed' for non-[phase66] errors",
  );
}

(async () => {
  test_classifyTerminalStatus();
  await test_phase66_taggedError_routesToErrorStatus();
  await test_nonPhase66_error_routesToFailedStatus();
  console.log("\nPhase 66 follow-up keepa-brand catch-path tests: ALL GREEN");
})().catch((e) => {
  console.error("test failure:", e);
  process.exit(1);
});
