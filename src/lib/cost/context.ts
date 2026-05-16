/**
 * Phase 81 — AsyncLocalStorage-backed bulk-run cost context.
 *
 * The spec recommended explicit `ctx` arg propagation, but threading a
 * 3-field tuple through every Apollo/Hunter/MV/OpenAI leaf call site
 * (some 6 layers deep into qualification hard-gates) was deemed too
 * invasive for one phase. ALS lets the bulk worker establish the
 * { bulkRunId, bulkRunBrandId, brandId } context once at the per-brand
 * boundary; every provider call inside that scope sees it via
 * `getBulkCtx()` without code-path plumbing.
 *
 * Non-bulk scans never call `withBulkCtx`, so `getBulkCtx()` returns
 * null defaults — costs still log to `api_costs` with brandId only,
 * and no run-level rollup is touched.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface BulkCtx {
  bulkRunId: string | null;
  bulkRunBrandId: string | null;
  brandId: string | null;
}

/**
 * Internal cell shape: ALS stores a mutable ref so the worker can update
 * `brandId` after Keepa enrichment without re-entering `storage.run()`.
 */
interface BulkCtxCell {
  ref: BulkCtx;
}

const storage = new AsyncLocalStorage<BulkCtxCell>();

export function withBulkCtx<T>(ctx: BulkCtx, fn: () => Promise<T>): Promise<T> {
  return storage.run({ ref: { ...ctx } }, fn);
}

export function getBulkCtx(): BulkCtx {
  const cell = storage.getStore();
  if (!cell) {
    return { bulkRunId: null, bulkRunBrandId: null, brandId: null };
  }
  return { ...cell.ref };
}

export function setBulkCtxBrandId(brandId: string | null): void {
  const cell = storage.getStore();
  if (cell) cell.ref.brandId = brandId;
}
