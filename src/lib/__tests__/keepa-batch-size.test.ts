/**
 * Phase 83 — Keepa /product batch-size regression test.
 *
 * Run directly with tsx:
 *
 *   npx tsx src/lib/__tests__/keepa-batch-size.test.ts
 *
 * Bug #2 from run b6341dd2: api_costs showed `keepa_product` calls with
 * `units` of 3, 4, or 5 — never 100. The Phase 82 spec called for
 * 100-ASIN batched calls but a caller upstream was passing tiny slices,
 * silently saturating Keepa at ~4 req/sec and dropping 6 of 11 brands
 * with HTTP 429.
 *
 * This test asserts that `getProductDetailsBatch` itself slices large
 * inputs into chunks of EXACTLY KEEPA_PRODUCT_BATCH_MAX (100) and
 * issues that many HTTP calls — never smaller. With 250 input ASINs we
 * expect 3 HTTP calls (100 + 100 + 50).
 */
import {
  getProductDetailsBatch,
  KEEPA_PRODUCT_BATCH_MAX,
  clearKeepaProductCache,
} from "../keepa";

let failures = 0;
let passes = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passes += 1;
  } else {
    failures += 1;
    console.error(`FAIL: ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

// Provide a Keepa API key so the helpers don't short-circuit.
process.env.KEEPA_API_KEY = "test-key";

interface CapturedCall {
  url: string;
  batchSize: number;
}

function mockFetchProductOnly(captured: CapturedCall[]): void {
  // @ts-expect-error — overriding global fetch for the test scope.
  global.fetch = async (url: string) => {
    const u = String(url);
    if (u.includes("/token")) {
      // ensureTokens probes /token; return plenty so we don't sleep.
      return new Response(
        JSON.stringify({ tokensLeft: 10_000, refillIn: 0, refillRate: 5 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes("/product")) {
      // Extract `asin=` query value to count input batch length.
      const m = u.match(/[?&]asin=([^&]+)/);
      const asinCsv = m ? decodeURIComponent(m[1]) : "";
      const batchSize = asinCsv ? asinCsv.split(",").filter(Boolean).length : 0;
      captured.push({ url: u, batchSize });
      // Echo each ASIN as a minimal product entry so the parser yields
      // shape but doesn't impact the call count.
      const products = (asinCsv ? asinCsv.split(",") : []).map((a) => ({
        asin: a,
        title: `t-${a}`,
        stats: { current: [], avg365: [] },
        offers: [],
      }));
      return new Response(
        JSON.stringify({ products, tokensLeft: 10_000, refillIn: 0, refillRate: 5 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  };
}

function makeAsins(n: number): string[] {
  // Synthesize n valid-looking ASINs (10 char alnum). "BB" prefix +
  // 8-digit zero-padded number stays inside the regex used in keepa.ts.
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const num = String(i).padStart(8, "0");
    out.push(`BB${num}`);
  }
  return out;
}

async function run250AsinTest(): Promise<void> {
  clearKeepaProductCache();
  const captured: CapturedCall[] = [];
  mockFetchProductOnly(captured);
  const asins = makeAsins(250);
  await getProductDetailsBatch(asins);

  check(
    "250 ASINs produces exactly 3 HTTP /product calls",
    captured.length === 3,
    `got ${captured.length} calls (batches: ${captured.map((c) => c.batchSize).join(", ")})`,
  );
  if (captured.length === 3) {
    check(
      "first call has 100 ASINs",
      captured[0].batchSize === 100,
      `got ${captured[0].batchSize}`,
    );
    check(
      "second call has 100 ASINs",
      captured[1].batchSize === 100,
      `got ${captured[1].batchSize}`,
    );
    check(
      "third call has 50 ASINs",
      captured[2].batchSize === 50,
      `got ${captured[2].batchSize}`,
    );
  }
}

async function runUnderCapTest(): Promise<void> {
  clearKeepaProductCache();
  const captured: CapturedCall[] = [];
  mockFetchProductOnly(captured);
  const asins = makeAsins(40);
  await getProductDetailsBatch(asins);
  check(
    "40 ASINs produces 1 HTTP /product call of size 40",
    captured.length === 1 && captured[0].batchSize === 40,
    `got ${captured.length} calls (batches: ${captured.map((c) => c.batchSize).join(", ")})`,
  );
}

async function main(): Promise<void> {
  check(
    "KEEPA_PRODUCT_BATCH_MAX is 100",
    KEEPA_PRODUCT_BATCH_MAX === 100,
    `got ${KEEPA_PRODUCT_BATCH_MAX}`,
  );
  await run250AsinTest();
  await runUnderCapTest();

  console.log(`\nkeepa-batch-size.test: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("test threw:", e);
  process.exit(1);
});
