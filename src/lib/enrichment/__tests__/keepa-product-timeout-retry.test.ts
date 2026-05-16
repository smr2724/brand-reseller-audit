/**
 * Phase 79 — Keepa /product timeout-retry tests.
 *
 * Covers the two retry-on-timeout invariants:
 *
 *   1. When /product times out once and then succeeds, getProductDetails
 *      returns the product, emits exactly one warn log, and
 *      consumeKeepaProductRetryCount() reports 1.
 *   2. When /product times out twice in a row, getProductDetails throws
 *      the fetchWithTimeout error so the bulk worker can mark the brand
 *      `error`. consumeKeepaProductRetryCount() reports 1 (one retry
 *      fired, the second attempt also threw and was rethrown).
 *
 * Implementation note: we patch global fetch to throw an AbortError on
 * cue. fetchWithTimeout catches AbortError and rewrites it to the
 * `fetchWithTimeout timed out after ...` message that the retry guard
 * keys off. We bypass ensureTokens() by stubbing the /token reply with
 * fat token counts.
 *
 * Run with:
 *   npx tsx src/lib/enrichment/__tests__/keepa-product-timeout-retry.test.ts
 */
import assert from "node:assert/strict";

process.env.KEEPA_API_KEY = "test-key";
process.env.KEEPA_DOMAIN_ID = "1";

interface MockResponse {
  status: number;
  ok: boolean;
  json: () => Promise<any>;
  text: () => Promise<string>;
}

function makeRes(body: any, status = 200): MockResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const TOKEN_OK = { tokensLeft: 4000, refillIn: 0, refillRate: 0 };

let fetchScript: Array<{
  match: (url: string) => boolean;
  reply: (url: string, init?: any) => MockResponse | Promise<MockResponse>;
}> = [];

function installFetch() {
  (globalThis as any).fetch = async (url: string | URL, init?: any) => {
    const u = typeof url === "string" ? url : url.toString();
    for (const handler of fetchScript) {
      if (handler.match(u)) return handler.reply(u, init);
    }
    throw new Error(`no fetch handler matched ${u}`);
  };
}

installFetch();

async function load() {
  delete require.cache[require.resolve("../../keepa")];
  delete require.cache[require.resolve("../../brand/recover-stuck-brands")];
  return require("../../keepa") as typeof import("../../keepa");
}

/**
 * Build an "AbortError" the way fetch() raises it when its signal aborts.
 * fetchWithTimeout in src/lib/util/timing.ts rewrites this into the
 * `fetchWithTimeout timed out after ...` Error our retry-guard keys off.
 */
function abortError(): Error {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

function captureWarns() {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: any[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.warn = original;
    },
  };
}

/**
 * Fake Keepa /product success payload that getProductDetails can parse
 * end-to-end without throwing. We only need one product back; the parser
 * is defensive about missing CSV fields.
 */
function productOk(asin: string) {
  return {
    products: [
      {
        asin,
        title: "Test Product",
        brand: "Test Brand",
        stats: { current: [], avg365: [] },
        offers: [],
        lastUpdate: 30_000_000, // safe Keepa-minute (~year 2027)
      },
    ],
    tokensLeft: TOKEN_OK.tokensLeft,
    refillIn: 0,
    refillRate: 0,
  };
}

async function test_1_timeoutThenSuccess() {
  let productCalls = 0;
  fetchScript = [
    { match: (u) => u.includes("/token"), reply: () => makeRes(TOKEN_OK) },
    {
      match: (u) => u.includes("/product"),
      reply: async () => {
        productCalls += 1;
        if (productCalls === 1) throw abortError();
        return makeRes(productOk("B000000001"));
      },
    },
  ];

  const k = await load();
  const warns = captureWarns();
  try {
    const out = await k.getProductDetails(["B000000001"], 5);
    assert.equal(productCalls, 2, "first call aborts, second call succeeds");
    assert.equal(out.length, 1, "the retried product is returned");
    assert.equal(out[0].asin, "B000000001");
    const retried = k.consumeKeepaProductRetryCount();
    assert.equal(retried, 1, "exactly one retry recorded");
    const retryWarn = warns.lines.find((l) => l.includes("[phase79]"));
    assert.ok(retryWarn, "retry should emit one [phase79] warn line");
    console.log("ok: 1 — timeout then success retries once and returns the product");
  } finally {
    warns.restore();
  }
}

async function test_2_doubleTimeoutThrows() {
  let productCalls = 0;
  fetchScript = [
    { match: (u) => u.includes("/token"), reply: () => makeRes(TOKEN_OK) },
    {
      match: (u) => u.includes("/product"),
      reply: async () => {
        productCalls += 1;
        throw abortError();
      },
    },
  ];

  const k = await load();
  const warns = captureWarns();
  try {
    let threw: unknown = null;
    try {
      await k.getProductDetails(["B000000002"], 5);
    } catch (e) {
      threw = e;
    }
    assert.ok(threw instanceof Error, "second timeout should rethrow");
    assert.ok(
      String((threw as Error).message).startsWith("fetchWithTimeout timed out"),
      "rethrown error should be the fetchWithTimeout message",
    );
    assert.equal(productCalls, 2, "should attempt exactly twice (one retry)");
    const retried = k.consumeKeepaProductRetryCount();
    assert.equal(retried, 1, "one retry counted even though it also failed");
    console.log("ok: 2 — double timeout rethrows after exactly one retry");
  } finally {
    warns.restore();
  }
}

async function main() {
  await test_1_timeoutThenSuccess();
  await test_2_doubleTimeoutThrows();
  console.log("phase-79 keepa-product-timeout-retry tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
