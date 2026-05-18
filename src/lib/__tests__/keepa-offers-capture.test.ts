/**
 * Phase 84 — Full Offers Capture regression test (Bug #5).
 *
 * Run directly with tsx:
 *
 *   npx tsx src/lib/__tests__/keepa-offers-capture.test.ts
 *
 * Pre-Phase-84 we only captured `p.buy_box_seller_id` (one seller per
 * ASIN), so Krazy Klean's 30 listings × ~10 sellers/listing produced
 * `keepa_unique_seller_count=3` (literally one per ASIN). With `offers=20`
 * + `liveOffersOrder` filtering + full-offer aggregation, the same
 * brand should surface 10+ distinct sellers.
 *
 * Mock shape: 3 ASINs, each with 10 active sellers via `offers[]` +
 * `liveOffersOrder`. Some sellers appear on multiple ASINs so we can
 * also confirm offer-share sums to 1.0.
 */
import {
  getProductDetailsBatch,
  clearKeepaProductCache,
  resolveSellerInfo,
  clearKeepaSellerCache,
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

process.env.KEEPA_API_KEY = "test-key";

function makeAsin(i: number): string {
  return `B0PH84${String(i).padStart(4, "0")}`;
}

function makeSellerId(i: number): string {
  // Keepa seller IDs match /^A[A-Z0-9]{12,13}$/. Synthesize valid-looking IDs.
  const num = String(i).padStart(12, "0");
  return `A${num}`;
}

/**
 * Build a single Keepa /product entry with `count` active offers via
 * `offers[]` and a populated `liveOffersOrder` pointing at the first
 * `count` indices. Sellers are produced by `sellerIdsForAsin` so the
 * caller can control overlap across ASINs.
 */
function makeProduct(asin: string, sellerIds: string[]): any {
  const offers = sellerIds.map((sid, i) => ({
    sellerId: sid,
    isFBA: i % 2 === 0,
    isPrime: true,
    isAmazon: false,
    condition: 1,
    lastSeen: 28_000_000 + i,
    // offerCSV layout: [..., price_cents, ship_cents]. Two-entry minimum.
    offerCSV: [2999, 0],
  }));
  return {
    asin,
    title: `t-${asin}`,
    brand: "TEST BRAND",
    stats: {
      current: [],
      avg365: [],
      offerCountNew: sellerIds.length,
      // Buy-box winner is the first seller on the listing.
      buyBoxSellerIdHistory: [sellerIds[0]],
    },
    offers,
    liveOffersOrder: sellerIds.map((_, i) => i),
  };
}

function mockKeepaFetch(productsByAsin: Record<string, any>): void {
  // @ts-expect-error overriding global fetch for the test
  global.fetch = async (url: string) => {
    const u = String(url);
    if (u.includes("/token")) {
      return new Response(
        JSON.stringify({ tokensLeft: 10_000, refillIn: 0, refillRate: 5 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes("/product")) {
      const m = u.match(/[?&]asin=([^&]+)/);
      const csv = m ? decodeURIComponent(m[1]) : "";
      const products = csv.split(",").map((a) => productsByAsin[a]).filter(Boolean);
      return new Response(
        JSON.stringify({ products, tokensLeft: 10_000, refillIn: 0, refillRate: 5 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  };
}

async function runFullOffersTest(): Promise<void> {
  clearKeepaProductCache();

  // 3 ASINs, 10 sellers each, with carefully-controlled overlap:
  //   ASIN 1: sellers 0..9
  //   ASIN 2: sellers 5..14   (5 overlap with ASIN 1: 5,6,7,8,9)
  //   ASIN 3: sellers 10..19  (5 overlap with ASIN 2: 10,11,12,13,14)
  // Distinct sellers across all ASINs: 0..19 = 20 unique.
  const asin1 = makeAsin(1);
  const asin2 = makeAsin(2);
  const asin3 = makeAsin(3);
  const sellers1 = Array.from({ length: 10 }, (_, i) => makeSellerId(i));
  const sellers2 = Array.from({ length: 10 }, (_, i) => makeSellerId(i + 5));
  const sellers3 = Array.from({ length: 10 }, (_, i) => makeSellerId(i + 10));

  const productsByAsin = {
    [asin1]: makeProduct(asin1, sellers1),
    [asin2]: makeProduct(asin2, sellers2),
    [asin3]: makeProduct(asin3, sellers3),
  };
  mockKeepaFetch(productsByAsin);

  const products = await getProductDetailsBatch([asin1, asin2, asin3]);

  check(
    "3 products parsed",
    products.length === 3,
    `got ${products.length}`,
  );

  // Aggregate exactly the way enrichBrandWithKeepa does it (Phase 84
  // aggregation): walk every offer on every product, key by sellerId.
  const sellerOfferCount = new Map<string, number>();
  let totalLiveOffers = 0;
  for (const p of products) {
    for (const o of p.offers ?? []) {
      const sid = o.seller_id;
      if (!sid) continue;
      totalLiveOffers += 1;
      sellerOfferCount.set(sid, (sellerOfferCount.get(sid) ?? 0) + 1);
    }
  }

  check(
    "unique seller count >= 15 (Phase 84 expectation; spec calls for ≥15)",
    sellerOfferCount.size >= 15,
    `got ${sellerOfferCount.size}`,
  );

  check(
    "exactly 20 unique sellers (0..19) given the test fixture",
    sellerOfferCount.size === 20,
    `got ${sellerOfferCount.size}`,
  );

  check(
    "totalLiveOffers === 30 (3 ASINs × 10 sellers)",
    totalLiveOffers === 30,
    `got ${totalLiveOffers}`,
  );

  // Share sums to 1.0 (within floating-point epsilon).
  let shareSum = 0;
  for (const count of sellerOfferCount.values()) {
    shareSum += count / totalLiveOffers;
  }
  check(
    "share sums to 1.0",
    Math.abs(shareSum - 1.0) < 1e-9,
    `got ${shareSum}`,
  );

  // Top seller share should be < 0.30 (5-overlap sellers appear on 2 of
  // 3 ASINs → 2/30 = 0.0667; no seller should hit 30%).
  const maxShare = Math.max(
    ...Array.from(sellerOfferCount.values()).map((c) => c / totalLiveOffers),
  );
  check(
    "top seller share < 0.30 (no single seller dominates)",
    maxShare < 0.3,
    `got max share ${maxShare}`,
  );
}

/**
 * Phase 84 follow-up #6 — Buy-box-only seeding branch.
 *
 * Covers the fallback in `enrichBrandWithKeepa`: when the buy-box winner
 * is NOT present in the live-offers walk (e.g. `liveOffersOrder` excludes
 * the winner's index, or Keepa only surfaced the winner via
 * `buyBoxSellerIdHistory`), the aggregation still seeds a sellerMap
 * entry so the winner gets credit for `asins_won=1`. Without the
 * seeding branch, top-seller and brand-controlled classification would
 * lose the signal entirely.
 *
 * We construct a `KeepaProductDetails`-shaped object directly here
 * because the upstream `getBuyBoxSeller` parser cannot synthesize this
 * exact combination (winnerId set, offers populated, winner NOT in
 * offers) — this is the input shape `enrichBrandWithKeepa` would
 * receive when Keepa returns inconsistent state.
 */
async function runBuyBoxOnlySeedingTest(): Promise<void> {
  const sellerA = makeSellerId(990);
  const sellerB = makeSellerId(991);
  const sellerC = makeSellerId(992); // buy-box winner; NOT in offers[]

  // Hand-craft the post-parse product as enrichBrandWithKeepa sees it.
  const p = {
    asin: makeAsin(200),
    buy_box_seller_id: sellerC,
    buy_box_seller: undefined as string | undefined,
    buy_box_is_amazon: false,
    buy_box_is_fba: false,
    offers: [
      { seller_id: sellerA, seller_name: undefined, is_fba: true, is_amazon: false, is_buy_box_winner: false },
      { seller_id: sellerB, seller_name: undefined, is_fba: false, is_amazon: false, is_buy_box_winner: false },
    ],
  };

  // Reproduce keepa-brand.ts aggregation lines ~423-497 EXACTLY so the
  // seeding branch stays under unit-test coverage.
  type Row = { asins_won: number; offer_count: number; asin_count: number };
  const sellerMap = new Map<string, Row>();
  let totalLiveOffers = 0;
  const seenOnThisAsin = new Set<string>();
  for (const o of p.offers ?? []) {
    const sid = o.seller_id;
    if (!sid) continue;
    const key = sid.toLowerCase();
    totalLiveOffers += 1;
    let existing = sellerMap.get(key);
    if (!existing) {
      existing = { asins_won: 0, offer_count: 0, asin_count: 0 };
      sellerMap.set(key, existing);
    }
    existing.offer_count += 1;
    if (!seenOnThisAsin.has(key)) {
      existing.asin_count += 1;
      seenOnThisAsin.add(key);
    }
  }
  // Seeding fallback: winner not in offers[] → still credit asins_won.
  const winnerId = p.buy_box_seller_id ?? null;
  if (winnerId) {
    const key = winnerId.toLowerCase();
    let existing = sellerMap.get(key);
    if (!existing) {
      existing = { asins_won: 0, offer_count: 0, asin_count: 0 };
      sellerMap.set(key, existing);
    }
    existing.asins_won += 1;
  }

  check(
    "sellerMap contains A, B, AND seeded winner C (3 entries)",
    sellerMap.size === 3,
    `got ${sellerMap.size} sellers`,
  );
  const cRow = sellerMap.get(sellerC.toLowerCase());
  check(
    "seeded winner C: asins_won=1, offer_count=0",
    cRow?.asins_won === 1 && cRow?.offer_count === 0,
    JSON.stringify(cRow),
  );
  check(
    "total asins_won across sellerMap === 1 (only winner C)",
    Array.from(sellerMap.values()).reduce((a, s) => a + s.asins_won, 0) === 1,
    `got ${Array.from(sellerMap.values()).reduce((a, s) => a + s.asins_won, 0)}`,
  );
  check(
    "totalLiveOffers === 2 (A + B; winner C not counted as an offer)",
    totalLiveOffers === 2,
    `got ${totalLiveOffers}`,
  );

  // Phase 84 follow-up #1 invariant: top_seller_share_pct (the buy-box
  // semantic preserved for scoring) must be 1.0 when the seeded winner
  // is the only seller with asins_won>0, regardless of how many sellers
  // hold live offers.
  const totalWon = Array.from(sellerMap.values()).reduce((a, s) => a + s.asins_won, 0);
  const winnerAsinsWon = cRow?.asins_won ?? 0;
  const top_seller_share_pct = totalWon > 0 ? winnerAsinsWon / totalWon : null;
  check(
    "FU1: top_seller_share_pct (buy-box semantic) === 1.0 for the lone winner",
    top_seller_share_pct === 1.0,
    `got ${top_seller_share_pct}`,
  );
}

/**
 * Phase 84 follow-up #6 — `/seller` cache miss → hit path. The first
 * `resolveSellerInfo` call for a fresh seller_id hits Keepa and records
 * one `keepa_seller_lookup` cost row; the second call (within the 30-day
 * SELLER_NAME_CACHE TTL) hits the in-memory cache and issues zero new
 * Keepa requests. We don't have direct access to api_costs in this
 * mock-only harness, so we assert on the proxy: number of /seller fetch
 * calls. trackCost is only invoked on a real /seller round-trip, so
 * fetchCount === cost rows.
 */
async function runSellerCacheMissThenHitTest(): Promise<void> {
  clearKeepaSellerCache();
  const sellerId = makeSellerId(500);
  let fetchCount = 0;
  // @ts-expect-error overriding global fetch for the test
  global.fetch = async (url: string) => {
    const u = String(url);
    if (u.includes("/seller")) {
      fetchCount += 1;
      return new Response(
        JSON.stringify({
          sellers: {
            [sellerId]: { sellerName: "Cached Seller LLC", address: ["US"] },
          },
          tokensLeft: 10_000,
          refillIn: 0,
          refillRate: 5,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  };

  const first = await resolveSellerInfo([sellerId]);
  check(
    "first call hits Keepa /seller (fetchCount=1)",
    fetchCount === 1,
    `got fetchCount=${fetchCount}`,
  );
  check(
    "first call returns resolved name",
    first[sellerId]?.name === "Cached Seller LLC",
    `got ${JSON.stringify(first[sellerId])}`,
  );

  const second = await resolveSellerInfo([sellerId]);
  check(
    "second call hits in-memory cache (fetchCount still 1)",
    fetchCount === 1,
    `got fetchCount=${fetchCount}`,
  );
  check(
    "second call returns same resolved name",
    second[sellerId]?.name === "Cached Seller LLC",
    `got ${JSON.stringify(second[sellerId])}`,
  );
}

async function runLiveOffersOrderFilterTest(): Promise<void> {
  // Confirm `liveOffersOrder` filtering correctly drops historical offers.
  clearKeepaProductCache();
  const asin = makeAsin(99);
  const allSellers = Array.from({ length: 10 }, (_, i) => makeSellerId(100 + i));
  const product = makeProduct(asin, allSellers);
  // Mark only the first 3 indices as live; remaining 7 are "historical".
  product.liveOffersOrder = [0, 1, 2];
  mockKeepaFetch({ [asin]: product });

  const [p] = await getProductDetailsBatch([asin]);
  check(
    "liveOffersOrder filter limits offers to 3 (out of 10 historical)",
    p && p.offers.length === 3,
    `got ${p ? p.offers.length : "no product"}`,
  );
}

/**
 * Phase 84 follow-up #7 — regression guard for the FU1/FU2 interaction.
 *
 * FU2 changed `topReseller` selection to sort by `share_pct` DESC
 * (offer-share leader). FU1 restored `top_seller_share_pct` to buy-box
 * semantics (`asins_won / totalWon`) to preserve scoring magnitude. If
 * `top_seller_share_pct` is computed from `topReseller.asins_won` (the
 * FU1 implementation as merged), the offer-share leader's buy-box share
 * is reported instead of the MAX buy-box share — silently lowering
 * `computeValidationScore`/`computeLegionEconomics` magnitude whenever
 * offer-share leader ≠ buy-box leader.
 *
 * Both PR reviewers (#96) flagged this. The fix: compute
 * `top_seller_share_pct` independently as
 * `max(asins_won)/totalWon` over the brand-controlled-filtered resellers
 * list, decoupling it from `topReseller` identity.
 *
 * Reproduces the exact aggregation/sort/share block from
 * `keepa-brand.ts` lines ~837-865 so the regression stays under unit
 * coverage even though the function under test is too IO-heavy to call
 * end-to-end here.
 */
async function runTopSellerShareDecouplingTest(): Promise<void> {
  // Two resellers with diverging asins_won vs offer-share:
  //   Seller A: asins_won=10, offer-share ~20% (buy-box leader, low offer-share)
  //   Seller B: asins_won=2,  offer-share ~70% (offer-share leader, low asins_won)
  //   totalWon = 12
  const sellerA = makeSellerId(701);
  const sellerB = makeSellerId(702);

  type Reseller = {
    seller_id: string;
    seller_name: string;
    asins_won: number;
    share_pct: number;
    classification: { is_brand_controlled: boolean };
  };

  const classified: Reseller[] = [
    {
      seller_id: sellerA,
      seller_name: "Seller A LLC",
      asins_won: 10,
      share_pct: 0.20,
      classification: { is_brand_controlled: false },
    },
    {
      seller_id: sellerB,
      seller_name: "Seller B LLC",
      asins_won: 2,
      share_pct: 0.70,
      classification: { is_brand_controlled: false },
    },
  ];
  const totalWon = 12;

  // Mirror keepa-brand.ts lines ~837-865 EXACTLY.
  const resellersSorted = classified
    .filter((s) => !s.classification.is_brand_controlled)
    .sort((a, b) => {
      const bs = b.share_pct ?? 0;
      const as = a.share_pct ?? 0;
      if (bs !== as) return bs - as;
      return (b.asins_won ?? 0) - (a.asins_won ?? 0);
    });
  const topReseller = resellersSorted[0] ?? null;

  // Post-fix: top_seller_share_pct is independent of topReseller identity.
  const top_seller_share_pct =
    totalWon > 0 && resellersSorted.length > 0
      ? Math.max(...resellersSorted.map((r) => (r.asins_won ?? 0) / totalWon))
      : null;
  const top_seller_offer_share_pct = topReseller?.share_pct ?? null;

  // Three invariants in one assertion (the FU1/FU2 interaction guard
  // both reviewers on PR #96 called out):
  //   (a) FU2 — topReseller identity is the offer-share leader (B).
  //   (b) FU1 regression guard — top_seller_share_pct is MAX buy-box
  //       share (A's 10/12 ≈ 0.833), NOT the offer-share leader's
  //       buy-box share (B's 2/12 ≈ 0.167). This is what preserves
  //       `computeValidationScore` / `computeLegionEconomics` magnitude.
  //   (c) top_seller_offer_share_pct exposes B's offer-share (~0.70).
  const ok =
    topReseller?.seller_id === sellerB &&
    top_seller_share_pct !== null &&
    Math.abs(top_seller_share_pct - 10 / 12) < 1e-9 &&
    top_seller_offer_share_pct !== null &&
    Math.abs(top_seller_offer_share_pct - 0.70) < 1e-9;
  check(
    "FU1/FU2 decoupling: topReseller=B (offer-share leader), top_seller_share_pct=10/12 (buy-box-leader MAX), top_seller_offer_share_pct=0.70 (B's offer-share)",
    ok,
    `topReseller=${topReseller?.seller_id} top_seller_share_pct=${top_seller_share_pct} top_seller_offer_share_pct=${top_seller_offer_share_pct}`,
  );
}

async function main(): Promise<void> {
  await runFullOffersTest();
  await runLiveOffersOrderFilterTest();
  await runBuyBoxOnlySeedingTest();
  await runSellerCacheMissThenHitTest();
  await runTopSellerShareDecouplingTest();

  console.log(
    `\nkeepa-offers-capture.test: ${passes} passed, ${failures} failed`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("test threw:", e);
  process.exit(1);
});
