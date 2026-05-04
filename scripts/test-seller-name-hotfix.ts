/**
 * Hotfix (May 2026) — Tests for the seller-name resolution hotfix.
 *
 * 1. resolveSellerInfo: when Keepa /seller returns no name for a given
 *    seller ID, the resolver returns `{ name: null, country: null }`
 *    (NOT the raw seller_id).
 * 2. resolveSellerInfo: when Keepa returns a real name + country, the
 *    resolver passes them through and writes them to the cache.
 * 3. The backfill admin route module exports a POST handler that
 *    requires CRON_SECRET-bearer authorization.
 *
 * Run:
 *   npx tsx scripts/test-seller-name-hotfix.ts
 */

const ORIGINAL_FETCH = globalThis.fetch;
const counts = { pass: 0, fail: 0 };

function assertEq(name: string, got: unknown, expect: unknown) {
  if (JSON.stringify(got) === JSON.stringify(expect)) {
    counts.pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    counts.fail += 1;
    console.log(
      `FAIL  ${name}\n  got:    ${JSON.stringify(got)}\n  expect: ${JSON.stringify(expect)}`,
    );
  }
}

function fakeFetch(payload: any) {
  return async (_url: string, _init?: any) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

(async () => {
  process.env.KEEPA_API_KEY = "test-key";

  const { resolveSellerInfo, clearKeepaSellerCache } = await import(
    "../src/lib/keepa"
  );

  // 1. Keepa returns no name for the unknown seller id — resolver MUST
  //    surface { name: null } so callers can persist NULL instead of
  //    falling back to the raw seller_id.
  {
    clearKeepaSellerCache();
    globalThis.fetch = fakeFetch({
      tokensLeft: 200,
      sellers: {
        // Note: seller A1BKR1TFBMOG3V is intentionally absent — Keepa
        // sometimes omits unknown IDs from the response entirely.
      },
    }) as any;
    const out = await resolveSellerInfo(["A1BKR1TFBMOG3V"]);
    assertEq(
      "missing seller resolves to null name (no seller_id fallback)",
      out["A1BKR1TFBMOG3V"],
      { name: null, country: null },
    );
  }

  // 2. Real storefront — pass name + parsed country code through.
  {
    clearKeepaSellerCache();
    globalThis.fetch = fakeFetch({
      tokensLeft: 199,
      sellers: {
        A20VA93I9198M6: {
          sellerName: "ACME Distributors LLC",
          address: ["123 Main St", "Bensalem", "PA", "19020", "US"],
        },
      },
    }) as any;
    const out = await resolveSellerInfo(["A20VA93I9198M6"]);
    assertEq(
      "real seller resolves to its display name",
      out["A20VA93I9198M6"]?.name,
      "ACME Distributors LLC",
    );
    assertEq(
      "country parsed from address array",
      out["A20VA93I9198M6"]?.country,
      "US",
    );
  }

  // 3. Amazon retail short-circuits without burning a token.
  {
    clearKeepaSellerCache();
    let called = 0;
    globalThis.fetch = (async (_url: string) => {
      called += 1;
      return fakeFetch({ tokensLeft: 0, sellers: {} })(_url);
    }) as any;
    const out = await resolveSellerInfo(["ATVPDKIKX0DER"]);
    assertEq(
      "Amazon retail short-circuits to Amazon.com",
      out["ATVPDKIKX0DER"],
      { name: "Amazon.com", country: "US" },
    );
    assertEq("Amazon retail does not call Keepa", called, 0);
  }

  // 4. Backfill route module exports POST and rejects unauthenticated
  //    requests with 401. Lightweight check — no Supabase needed.
  {
    process.env.CRON_SECRET = "test-cron-secret";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const mod = await import(
      "../src/app/api/admin/backfill-seller-names/route"
    );
    if (typeof mod.POST !== "function") {
      assertEq("backfill route exports POST", false, true);
    } else {
      const req = new Request("https://x.test/api/admin/backfill-seller-names", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      });
      const res = await mod.POST(req);
      assertEq("unauthenticated POST → 401", res.status, 401);

      const goodReq = new Request(
        "https://x.test/api/admin/backfill-seller-names",
        {
          method: "POST",
          body: JSON.stringify({}),
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test-cron-secret",
          },
        },
      );
      // Without SUPABASE_SERVICE_ROLE_KEY the handler should authorize
      // then bail with the missing-server-key error (status 500).
      const res2 = await mod.POST(goodReq);
      assertEq(
        "auth passes with valid bearer token (server-misconfig 500 next)",
        res2.status,
        500,
      );
    }
  }

  globalThis.fetch = ORIGINAL_FETCH;

  console.log(`\n${counts.pass} passed, ${counts.fail} failed.`);
  if (counts.fail > 0) process.exit(1);
})();
