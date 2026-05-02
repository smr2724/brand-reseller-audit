/**
 * SP-API override path test.
 *
 * Verifies:
 *   1. parseTrailing12FromConnectorResponse correctly converts a
 *      `getSalesAndTrafficReport`-shaped payload into our canonical
 *      SpApiTrailingResult.
 *   2. setMockSpApiResponse + pullTrailing12FromSpApi end-to-end:
 *        a. with no link row     → returns { ok:false, reason:"no_link" }
 *        b. with link + mock ok  → returns trailing-12mo data
 *        c. with link + connector unavailable → falls back gracefully
 *
 * No real Keepa or SP-API calls; the SupabaseClient is replaced with
 * an in-memory stub that fakes the `brand_sp_api_links` table.
 *
 * Run:
 *   npx tsx scripts/test-sp-api-override.ts
 */
import {
  parseTrailing12FromConnectorResponse,
  pullTrailing12FromSpApi,
  setMockSpApiResponse,
  type SpApiTrailingResult,
} from "../src/lib/enrichment/sp-api-override";

function mkAdminWithLink(hasLink: boolean): any {
  return {
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, _val: string) {
              return {
                async maybeSingle() {
                  return {
                    data: hasLink
                      ? {
                          brand_id: "test-brand",
                          marketplace_id: "ATVPDKIKX0DER",
                          connector_account: "steve@diversifiedhospitality.com",
                          notes: null,
                          configured_at: new Date().toISOString(),
                        }
                      : null,
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
}

async function main() {
  // ---------- 1. parseTrailing12FromConnectorResponse ----------
  const fakePayload = {
    salesAndTrafficByAsin: [
      {
        childAsin: "B0754KC9TP",
        salesByAsin: { orderedProductSales: { amount: 542300.42 }, unitsOrdered: 7800 },
      },
      {
        childAsin: "B081DJMVVB",
        salesByAsin: { orderedProductSales: { amount: 218400.0 }, unitsOrdered: 17000 },
      },
      {
        // bad row — should be skipped
        childAsin: "BAD",
        salesByAsin: { orderedProductSales: { amount: 1000 } },
      },
    ],
  };
  const parsed = parseTrailing12FromConnectorResponse(
    "test-brand",
    "ATVPDKIKX0DER",
    fakePayload,
  );
  assert(parsed.ok === true, "parses good payload");
  if (parsed.ok) {
    assert(parsed.trailing_12mo_revenue === Math.round(542300.42 + 218400), "sums revenue");
    assert(parsed.asins.length === 2, "filters bad asin");
    assert(parsed.source_note.includes("SP-API"), "source label");
  }

  const empty = parseTrailing12FromConnectorResponse("test-brand", "ATVPDKIKX0DER", {
    salesAndTrafficByAsin: [],
  });
  assert(empty.ok === false, "empty rows → not ok");
  if (!empty.ok) assert(empty.reason === "connector_no_access", "empty → connector_no_access");

  // ---------- 2a. no_link path ----------
  const adminNoLink = mkAdminWithLink(false);
  const r1 = await pullTrailing12FromSpApi(adminNoLink, "test-brand");
  assert(r1.ok === false, "no link → not ok");
  if (!r1.ok) assert(r1.reason === "no_link", "no link → reason=no_link");

  // ---------- 2b. link + mock ok ----------
  const adminWithLink = mkAdminWithLink(true);
  const mockOk: SpApiTrailingResult = {
    ok: true,
    brand_id: "test-brand",
    marketplace_id: "ATVPDKIKX0DER",
    trailing_12mo_revenue: 1_240_000,
    asins: [
      { asin: "B0754KC9TP", units: 8000, ordered_revenue: 552_000 },
      { asin: "B081DJMVVB", units: 17000, ordered_revenue: 218_400 },
      { asin: "B0CTD6WBL9", units: 30000, ordered_revenue: 469_600 },
    ],
    pulled_at: new Date().toISOString(),
    source_note: "Amazon SP-API · trailing 12 months",
  };
  setMockSpApiResponse(mockOk);
  const r2 = await pullTrailing12FromSpApi(adminWithLink, "test-brand");
  assert(r2.ok === true, "mocked link + mock → ok");
  if (r2.ok) {
    assert(r2.trailing_12mo_revenue === 1_240_000, "trailing12 = 1.24M");
    assert(r2.asins.length === 3, "3 asins");
    assert(r2.source_note.includes("SP-API"), "source label preserved");
  }

  // ---------- 2c. link + no connector wired (production today) ----------
  // Mock cleared above, no env var → connector_unavailable.
  delete process.env.SP_API_CONNECTOR_TOOL;
  const r3 = await pullTrailing12FromSpApi(adminWithLink, "test-brand");
  assert(r3.ok === false, "no connector wired → not ok");
  if (!r3.ok) assert(r3.reason === "connector_unavailable", "graceful degrade");

  console.log("\nAll SP-API override tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
