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

async function main(): Promise<void> {
  await runFullOffersTest();
  await runLiveOffersOrderFilterTest();

  console.log(
    `\nkeepa-offers-capture.test: ${passes} passed, ${failures} failed`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("test threw:", e);
  process.exit(1);
});
