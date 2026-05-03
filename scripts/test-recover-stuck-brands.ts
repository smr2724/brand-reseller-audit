/**
 * Phase 29 — stuck-brand recovery sweep + null-safety smoke tests.
 * Phase 30 — Updated to assert the new `enrichment_state IN
 * ('pending','failed')` filter (was `keepa_last_enriched_at IS NULL`).
 *
 * Verifies:
 *  1. resolveBrandRevenue is null-safe across the full grid of inputs
 *     a freshly-inserted brand row could present (mirrors the H2O Therapy
 *     bug context — Phase 28 added resolveBrandRevenue and we want to
 *     prove it never throws on missing fields).
 *  2. findStuckBrands queries by `enrichment_state IN ('pending','failed')`
 *     and a created_at cutoff.
 *  3. recoverStuckBrand calls enrichBrandWithKeepa with the right inputs
 *     and surfaces the resulting summary / error structurally.
 *
 * Run:
 *   npx tsx scripts/test-recover-stuck-brands.ts
 */
import { resolveBrandRevenue } from "../src/lib/math/resolve-brand-revenue";
import {
  findStuckBrands,
  recoverStuckBrand,
  STUCK_BRAND_THRESHOLD_MS,
  RECOVERY_BRAND_BATCH_LIMIT,
  type StuckBrand,
} from "../src/lib/brand/recover-stuck-brands";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures += 1;
  }
}

async function main() {
console.log("Case 1: resolveBrandRevenue — null-safe on H2O-Therapy-like inputs");
{
  // Freshly-inserted brand row with no confirmed_ttm_* and no enrichment yet.
  const a = resolveBrandRevenue({}, null);
  assert(a.value === null, "{} + null → value null");
  assert(a.source === "enrichment", "{} + null → enrichment source");

  const b = resolveBrandRevenue({ confirmed_ttm_revenue_dollars: null }, null);
  assert(b.value === null, "null confirmed + null enrichment → null");

  const c = resolveBrandRevenue(null, null);
  assert(c.value === null, "null brand + null enrichment → null");

  const d = resolveBrandRevenue(undefined, undefined);
  assert(d.value === null, "undefined brand + undefined enrichment → null");

  const e = resolveBrandRevenue(
    { confirmed_ttm_revenue_dollars: NaN as unknown as number },
    null,
  );
  assert(e.value === null, "NaN confirmed → falls through, no throw");

  const f = resolveBrandRevenue(
    { confirmed_ttm_revenue_dollars: -1 },
    null,
  );
  assert(f.source === "enrichment", "negative confirmed → enrichment");

  const g = resolveBrandRevenue(
    { confirmed_ttm_revenue_dollars: "abc" as unknown as number },
    null,
  );
  assert(g.value === null, "non-numeric confirmed → no throw");
}

console.log("Case 2: findStuckBrands query shape (Phase 30 — enrichment_state filter)");
{
  type Captured = {
    table?: string;
    select?: string;
    inCol?: string;
    inVal?: unknown;
    lteCol?: string;
    lteVal?: unknown;
    orderCol?: string;
    orderAsc?: boolean;
    limit?: number;
  };
  const cap: Captured = {};
  const builder: any = {
    select(s: string) {
      cap.select = s;
      return this;
    },
    in(col: string, val: unknown) {
      cap.inCol = col;
      cap.inVal = val;
      return this;
    },
    lte(col: string, val: unknown) {
      cap.lteCol = col;
      cap.lteVal = val;
      return this;
    },
    order(col: string, opts: { ascending: boolean }) {
      cap.orderCol = col;
      cap.orderAsc = opts.ascending;
      return this;
    },
    limit(n: number) {
      cap.limit = n;
      return Promise.resolve({
        data: [
          {
            id: "brand-1",
            user_id: "user-1",
            name: "Stuck Inc.",
            created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
            enrichment_state: "pending",
          },
        ],
        error: null,
      });
    },
  };
  const adminMock: any = {
    from(table: string) {
      cap.table = table;
      return builder;
    },
  };

  const rows = await findStuckBrands(adminMock);
  assert(cap.table === "brands", "queries the brands table");
  assert(cap.inCol === "enrichment_state", "filters on enrichment_state column");
  assert(
    Array.isArray(cap.inVal) &&
      (cap.inVal as string[]).includes("pending") &&
      (cap.inVal as string[]).includes("failed"),
    "includes 'pending' and 'failed' in the filter",
  );
  assert(cap.lteCol === "created_at", "filters by created_at <= cutoff");
  assert(cap.orderAsc === true, "orders oldest-first");
  assert(cap.limit === RECOVERY_BRAND_BATCH_LIMIT, "uses RECOVERY_BRAND_BATCH_LIMIT");
  assert(rows.length === 1 && rows[0].id === "brand-1", "returns mocked row");
}

console.log("Case 3: recoverStuckBrand surfaces enrichment errors safely");
{
  // We can't mock the keepa-brand module without jest-style mocking, so
  // exercise the catch path by passing a Supabase mock that throws inside
  // enrichBrandWithKeepa's first DB write. We don't actually call Keepa.
  const adminMock: any = {
    from() {
      return {
        insert() {
          return {
            select() {
              return { single: () => Promise.reject(new Error("boom")) };
            },
          };
        },
        update() {
          return {
            eq() {
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  const brand: StuckBrand = {
    id: "brand-x",
    user_id: "user-x",
    name: "Boom Brand",
    created_at: new Date().toISOString(),
    enrichment_state: "pending",
  };
  let threw = false;
  try {
    const res = await recoverStuckBrand(adminMock, brand);
    assert(
      res.brand_id === "brand-x",
      "result carries the brand id back",
    );
    assert(
      res.status === "failed" || res.status === "recovered",
      "status is one of recovered|failed (no throw)",
    );
  } catch {
    threw = true;
  }
  assert(threw === false, "recoverStuckBrand never throws");
}

console.log("Case 4: STUCK_BRAND_THRESHOLD_MS is 5 minutes");
{
  assert(
    STUCK_BRAND_THRESHOLD_MS === 5 * 60 * 1000,
    "5-minute threshold matches the brief (creates stuck for >5min)",
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll Phase 29 stuck-brand recovery tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
