/**
 * Phase 4 — Keepa enrichment smoke test.
 *
 * Usage:
 *   KEEPA_API_KEY=xxx npx tsx scripts/test-keepa-enrichment.ts "Brand Name"
 *
 * Runs the full pipeline in-memory (search + per-ASIN detail + aggregate).
 * Does NOT touch the live database.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import {
  searchProductsByBrand,
  getProductDetails,
  getKeepaTokenStatus,
  isKeepaConfigured,
} from "../src/lib/keepa";
import { computeValidationScore } from "../src/lib/enrichment/scoring";
import { isBrandControlled } from "../src/lib/enrichment/keepa-brand";

async function main() {
  const brandName = process.argv[2];
  if (!brandName) {
    console.error("Usage: tsx scripts/test-keepa-enrichment.ts \"Brand Name\"");
    process.exit(1);
  }
  if (!isKeepaConfigured()) {
    console.error("KEEPA_API_KEY missing in env (.env.local or shell).");
    process.exit(1);
  }

  console.log(`\n=== Keepa enrichment dry-run: "${brandName}" ===\n`);

  try {
    const before = await getKeepaTokenStatus(true);
    console.log(`Tokens before: ${before.tokens_left} (refill in ${before.refill_in_ms}ms)`);
  } catch (e: any) {
    console.error("Token check failed:", e?.message ?? e);
    process.exit(1);
  }

  const search = await searchProductsByBrand(brandName, 20);
  console.log(`\nSearch: ${search.asins.length} ASINs (tokens used ${search.tokens_used}, left ${search.tokens_left})`);
  if (!search.asins.length) {
    console.log("No ASINs found. Exiting.");
    process.exit(0);
  }
  console.log(search.asins.join(", "));

  const products = await getProductDetails(search.asins, 5);
  console.log(`\nFetched ${products.length} product details\n`);
  for (const p of products) {
    const ctrl = isBrandControlled(p.buy_box_seller, brandName) ? "✓" : "✗";
    console.log(
      `  ${p.asin}  ${ctrl} ${p.buy_box_seller ?? "(no buy box)"}  $${p.buy_box_price ?? "?"}  offers=${p.total_offers_count} fba=${p.fba_offers_count}`,
    );
    console.log(`     ${(p.title ?? "").slice(0, 80)}`);
  }

  // Aggregate
  const sellerMap = new Map<string, { name: string; count: number; country?: string }>();
  let amazon1p = 0;
  let brandCtrl = 0;
  let totalOffers = 0;
  for (const p of products) {
    if (p.buy_box_is_amazon) amazon1p += 1;
    if (isBrandControlled(p.buy_box_seller, brandName)) brandCtrl += 1;
    totalOffers += p.total_offers_count;
    const key = (p.buy_box_seller_id || p.buy_box_seller || "").toLowerCase();
    if (key) {
      const existing = sellerMap.get(key);
      if (existing) existing.count += 1;
      else sellerMap.set(key, { name: p.buy_box_seller ?? key, count: 1, country: p.buy_box_is_amazon ? "US" : undefined });
    }
  }

  const totalWon = Array.from(sellerMap.values()).reduce((a, s) => a + s.count, 0);
  const sorted = Array.from(sellerMap.values()).sort((a, b) => b.count - a.count);
  const top = sorted[0];
  const summary = {
    asin_count: products.length,
    unique_seller_count: sellerMap.size,
    brand_controlled_pct: products.length ? brandCtrl / products.length : null,
    top_seller: top?.name ?? null,
    top_seller_share_pct: top && totalWon ? top.count / totalWon : null,
    avg_offers: products.length ? totalOffers / products.length : null,
    amazon_1p_share: products.length ? amazon1p / products.length : 0,
  };
  const validation_score = computeValidationScore({
    top_seller_share_pct: summary.top_seller_share_pct,
    brand_controlled_pct: summary.brand_controlled_pct,
    unique_seller_count: summary.unique_seller_count,
    asin_count: summary.asin_count,
    top_seller_country: top?.country ?? null,
  });

  console.log("\n=== Aggregate ===");
  console.log(JSON.stringify({ ...summary, validation_score }, null, 2));

  const after = await getKeepaTokenStatus(true);
  console.log(`\nTokens after: ${after.tokens_left}`);
}

main().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  process.exit(1);
});
