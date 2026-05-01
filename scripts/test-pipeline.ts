/**
 * Test the full scan pipeline (no DB writes) for one seed keyword.
 * Validates DFS + Keepa + scoring + OpenAI memo end-to-end.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { amazonRelatedKeywords, amazonSerpLive } from "../src/lib/dataforseo";
import { keepaEnrich } from "../src/lib/keepa";
import { generateMemo } from "../src/lib/openai";
import { scoreOpportunity } from "../src/lib/scoring";

async function run(seed: string) {
  console.log(`\n=== ${seed} ===`);
  const keywords = await amazonRelatedKeywords(seed, { limit: 60 });
  console.log(`Keywords: ${keywords.length}`);
  const products = await amazonSerpLive(seed, { depth: 20 });
  console.log(`Products: ${products.length}`);

  const asins = Array.from(new Set(products.slice(0, 10).map(p => p.asin).filter(Boolean) as string[]));
  console.log(`Top-10 ASINs to enrich: ${asins.length}`);
  let enrichMap: Record<string, any> = {};
  if (asins.length) {
    try {
      enrichMap = await keepaEnrich(asins);
      console.log(`Keepa enriched: ${Object.keys(enrichMap).length}`);
    } catch (e: any) {
      console.error("Keepa fail:", e.message);
    }
  }

  // merge enrichment for missing fields
  for (const p of products) {
    if (!p.asin) continue;
    const e = enrichMap[p.asin];
    if (!e) continue;
    p.title = p.title ?? e.title;
    p.brand = p.brand ?? e.brand;
    p.price = p.price ?? e.price;
    p.rating = p.rating ?? e.rating;
    p.review_count = p.review_count ?? e.review_count;
  }

  const score = scoreOpportunity({
    seedKeyword: seed,
    keywords: keywords.map(k => ({ keyword: k.keyword, search_volume: k.search_volume, intent_type: null })),
    products: products.map(p => ({
      asin: p.asin, title: p.title, brand: p.brand, price: p.price, rating: p.rating,
      review_count: p.review_count, image_url: p.image_url, is_sponsored: p.is_sponsored, position: p.position,
    })),
  });
  console.log(`Legion Score: ${score.legion_score}`);
  console.log(`  Demand: ${score.demand_score} / 20`);
  console.log(`  Comp Weakness: ${score.competition_weakness_score} / 20`);
  console.log(`  Product Adv: ${score.product_advantage_score} / 20`);
  console.log(`  Visual Demo: ${score.visual_demo_score} / 15`);
  console.log(`  Economics: ${score.economics_score} / 15`);
  console.log(`  Partner: ${score.partner_score} / 10`);
  console.log(`  Path: ${score.recommended_path}`);

  const memo = await generateMemo({
    seedKeyword: seed,
    topKeywords: keywords.slice(0, 15),
    topProducts: products.slice(0, 10),
    scores: { ...score },
    metrics: score.metrics,
  });
  console.log("\nMemo summary:", memo.summary);
  console.log("Why excited:", memo.why_excited);
  console.log("Why skeptical:", memo.why_skeptical);
  console.log("Recommended Path:", memo.recommended_path);
}

(async () => {
  await run("concrete remover");
})().catch((e) => { console.error(e); process.exit(1); });
