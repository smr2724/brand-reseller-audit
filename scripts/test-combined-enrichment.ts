/**
 * Phase 4.5 — Combined Keepa + DataForSEO enrichment smoke test.
 *
 * Usage:
 *   npx tsx scripts/test-combined-enrichment.ts "Brand Name"
 *
 * Pulls live data from BOTH providers in-memory and prints the combined
 * bundle (keepa + dataforseo + combined validation score + value-add
 * signals). Does NOT touch the live database — passes `null` as the
 * cache client so DataForSEO calls run without persistence.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import {
  searchProductsByBrand,
  getProductDetails,
  getKeepaTokenStatus,
  isKeepaConfigured,
} from "../src/lib/keepa";
import { isBrandControlled } from "../src/lib/enrichment/keepa-brand";
import {
  fetchBrandKeywords,
  fetchBrandSerp,
} from "../src/lib/enrichment/dataforseo";
import {
  computeCombinedValidationScore,
  deriveValueAddSignals,
  type ValidationSignals,
  type DataForSeoSignals,
} from "../src/lib/enrichment/scoring";
import { isDataForSEOConfigured } from "../src/lib/dataforseo";

async function main() {
  const brandName = process.argv[2];
  if (!brandName) {
    console.error('Usage: tsx scripts/test-combined-enrichment.ts "Brand Name"');
    process.exit(1);
  }

  const haveKeepa = isKeepaConfigured();
  const haveDfs = isDataForSEOConfigured();
  console.log(`\n=== Combined enrichment dry-run: "${brandName}" ===`);
  console.log(`Keepa:        ${haveKeepa ? "configured" : "MISSING"}`);
  console.log(`DataForSEO:   ${haveDfs ? "configured" : "MISSING"}\n`);

  // ----- Keepa -----
  let keepaSignals: ValidationSignals = {
    top_seller_share_pct: null,
    brand_controlled_pct: null,
    unique_seller_count: null,
    asin_count: null,
    top_seller_country: null,
  };
  let keepaSummary: any = null;

  if (haveKeepa) {
    try {
      const before = await getKeepaTokenStatus(true);
      console.log(`Keepa tokens before: ${before.tokens_left}`);

      const search = await searchProductsByBrand(brandName, 20);
      console.log(`Keepa search: ${search.asins.length} ASINs (tokens used ${search.tokens_used})`);

      if (search.asins.length) {
        const products = await getProductDetails(search.asins, 5);
        console.log(`Keepa fetched ${products.length} product details`);

        const sellerMap = new Map<string, { name: string; count: number; country?: string }>();
        let brandCtrl = 0;
        let totalOffers = 0;
        for (const p of products) {
          if (isBrandControlled(p.buy_box_seller, brandName)) brandCtrl += 1;
          totalOffers += p.total_offers_count;
          const key = (p.buy_box_seller_id || p.buy_box_seller || "").toLowerCase();
          if (key) {
            const existing = sellerMap.get(key);
            if (existing) existing.count += 1;
            else
              sellerMap.set(key, {
                name: p.buy_box_seller ?? key,
                count: 1,
                country: p.buy_box_is_amazon ? "US" : undefined,
              });
          }
        }
        const totalWon = Array.from(sellerMap.values()).reduce((a, s) => a + s.count, 0);
        const sorted = Array.from(sellerMap.values()).sort((a, b) => b.count - a.count);
        const top = sorted[0];

        keepaSignals = {
          top_seller_share_pct: top && totalWon ? top.count / totalWon : null,
          brand_controlled_pct: products.length ? brandCtrl / products.length : null,
          unique_seller_count: sellerMap.size,
          asin_count: products.length,
          top_seller_country: top?.country ?? null,
        };

        keepaSummary = {
          asin_count: products.length,
          unique_seller_count: sellerMap.size,
          top_seller: top?.name ?? null,
          top_seller_share_pct: keepaSignals.top_seller_share_pct,
          brand_controlled_pct: keepaSignals.brand_controlled_pct,
          avg_offers: products.length ? totalOffers / products.length : null,
        };
      }
    } catch (e: any) {
      console.error("Keepa error:", e?.message ?? e);
    }
  }

  // ----- DataForSEO -----
  let dfsSignals: DataForSeoSignals = {
    branded_search_volume: null,
    branded_trend_pct: null,
    competitor_top_share: null,
    competitor_count: null,
  };
  let dfsSummary: any = null;

  if (haveDfs) {
    try {
      // Pass null cache client — no DB writes during smoke test.
      const kws = await fetchBrandKeywords(null, brandName);
      console.log(`DataForSEO keywords returned: ${kws.length}`);
      const branded = kws.filter((k) =>
        k.keyword.toLowerCase().includes(brandName.toLowerCase()),
      );
      const branded_search_volume = branded.reduce(
        (a, k) => a + (typeof k.search_volume === "number" ? k.search_volume : 0),
        0,
      );

      const top_keywords = (branded.length ? branded : kws)
        .slice()
        .sort((a, b) => (b.search_volume ?? 0) - (a.search_volume ?? 0))
        .slice(0, 10)
        .map((k) => ({ keyword: k.keyword, search_volume: k.search_volume }));

      const serpKeywords = top_keywords
        .filter((k) => (k.search_volume ?? 0) > 0)
        .slice(0, 1) // budget cap for smoke test
        .map((k) => k.keyword);

      const competitorCounts = new Map<string, number>();
      let totalSerp = 0;
      for (const kw of serpKeywords) {
        const products = await fetchBrandSerp(null, kw);
        console.log(`DataForSEO SERP "${kw}": ${products.length} products`);
        for (const p of products) {
          if (!p.brand) continue;
          const isBrand = p.brand
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "")
            .includes(brandName.toLowerCase().replace(/[^a-z0-9]/g, ""));
          if (isBrand) continue;
          competitorCounts.set(p.brand, (competitorCounts.get(p.brand) ?? 0) + 1);
          totalSerp += 1;
        }
      }
      const competitors = Array.from(competitorCounts.entries())
        .map(([brand, n]) => ({ brand, share_of_serp: totalSerp ? n / totalSerp : 0 }))
        .sort((a, b) => b.share_of_serp - a.share_of_serp)
        .slice(0, 5);

      dfsSignals = {
        branded_search_volume: branded_search_volume || null,
        branded_trend_pct: null, // no historical reference in dry-run
        competitor_top_share: competitors[0]?.share_of_serp ?? null,
        competitor_count: competitors.length || null,
      };

      dfsSummary = {
        branded_search_volume: dfsSignals.branded_search_volume,
        top_keywords: top_keywords.slice(0, 5),
        competitors,
      };
    } catch (e: any) {
      console.error("DataForSEO error:", e?.message ?? e);
    }
  }

  const validationScore = computeCombinedValidationScore(keepaSignals, dfsSignals);
  const valueAddSignals = deriveValueAddSignals(keepaSignals, dfsSignals);

  console.log("\n=== Bundle ===");
  console.log(
    JSON.stringify(
      {
        brand: brandName,
        keepa: keepaSummary,
        dataforseo: dfsSummary,
        validationScore,
        valueAddSignals,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  process.exit(1);
});
