import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { amazonRelatedKeywords, amazonBulkSearchVolume, amazonSerpLive, testDataForSEO } from "../src/lib/dataforseo";

async function main() {
  console.log("Testing DFS auth...");
  const auth = await testDataForSEO();
  console.log(JSON.stringify(auth, null, 2));

  console.log("\nTesting related keywords for 'concrete remover'...");
  try {
    const kws = await amazonRelatedKeywords("concrete remover", { limit: 20 });
    console.log(`Got ${kws.length} keywords. Top 10:`);
    kws.slice(0, 10).forEach((k) => console.log(`  ${k.keyword} -- sv=${k.search_volume}`));
  } catch (e: any) {
    console.error("FAIL:", e.message);
  }

  console.log("\nTesting Amazon SERP for 'concrete remover'...");
  try {
    const products = await amazonSerpLive("concrete remover", { depth: 20 });
    console.log(`Got ${products.length} products. Top 5:`);
    products.slice(0, 5).forEach((p) =>
      console.log(`  #${p.position} ${p.title?.slice(0, 60)} | $${p.price} | ${p.rating}* (${p.review_count} reviews) sponsored=${p.is_sponsored}`)
    );
  } catch (e: any) {
    console.error("FAIL:", e.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
