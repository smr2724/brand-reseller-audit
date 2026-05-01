/**
 * Scan orchestrator — runs a full scan end-to-end:
 *   1. Keyword expansion + search volume (DataForSEO, or mock)
 *   2. Amazon SERP (DataForSEO, or mock)
 *   3. Keepa enrichment (optional, cached)
 *   4. Legion scoring
 *   5. OpenAI memo (optional, placeholder fallback)
 *   6. Persist to Supabase
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  amazonRelatedKeywords,
  amazonSerpLive,
  isDataForSEOConfigured,
  type DfsKeyword,
  type DfsProduct,
} from "./dataforseo";
import { isKeepaConfigured, keepaEnrich } from "./keepa";
import { isOpenAIConfigured, generateMemo, type MemoInput } from "./openai";
import { mockKeywords, mockProducts } from "./mock";
import { scoreOpportunity, scoreToThreshold } from "./scoring";

export type ScanDepth = "quick" | "standard" | "deep";

interface RunScanArgs {
  scanId: string;
  userId: string;
  seedKeyword: string;
  depth: ScanDepth;
  supabase: SupabaseClient;
  /** If true, skip Keepa enrichment entirely (useful for batch test runs to conserve tokens). */
  skipKeepa?: boolean;
}

function depthConfig(d: ScanDepth) {
  if (d === "quick") return { serpDepth: 10, keywordLimit: 30 };
  if (d === "deep") return { serpDepth: 40, keywordLimit: 100 };
  return { serpDepth: 20, keywordLimit: 60 };
}

async function logApiCall(supabase: SupabaseClient, userId: string, provider: string, endpoint: string, summary: string, status: string, cost = 0) {
  try {
    await supabase.from("api_logs").insert({
      user_id: userId, provider, endpoint, request_summary: summary, response_status: status, cost_estimate: cost,
    });
  } catch {}
}

export async function runScan(args: RunScanArgs) {
  const { scanId, userId, seedKeyword, depth, supabase } = args;
  const cfg = depthConfig(depth);
  const usedMock = { keywords: false, serp: false, keepa: false, memo: false };
  let errors: string[] = [];

  // 1. Keywords
  let keywords: DfsKeyword[] = [];
  if (isDataForSEOConfigured()) {
    try {
      keywords = await amazonRelatedKeywords(seedKeyword, { limit: cfg.keywordLimit });
      await logApiCall(supabase, userId, "dataforseo", "related_keywords", seedKeyword, "ok");
    } catch (e: any) {
      errors.push(`DataForSEO keywords: ${e?.message ?? e}`);
      await logApiCall(supabase, userId, "dataforseo", "related_keywords", seedKeyword, "error");
    }
  }
  if (!keywords.length) {
    keywords = mockKeywords(seedKeyword);
    usedMock.keywords = true;
  }

  // 2. SERP
  let products: DfsProduct[] = [];
  if (isDataForSEOConfigured()) {
    try {
      products = await amazonSerpLive(seedKeyword, { depth: cfg.serpDepth });
      await logApiCall(supabase, userId, "dataforseo", "amazon_serp_live", seedKeyword, "ok");
    } catch (e: any) {
      errors.push(`DataForSEO SERP: ${e?.message ?? e}`);
      await logApiCall(supabase, userId, "dataforseo", "amazon_serp_live", seedKeyword, "error");
    }
  }
  if (!products.length) {
    products = mockProducts(seedKeyword);
    usedMock.serp = true;
  }

  // 3. Keepa (cached-aware, opportunistic)
  const asins = Array.from(new Set(products.map(p => p.asin).filter(Boolean) as string[]));
  const enrichMap: Record<string, any> = {};
  if (!args.skipKeepa && isKeepaConfigured() && asins.length) {
    try {
      // Check cache first
      const { data: existing } = await supabase
        .from("products")
        .select("asin,last_enriched_at,keepa_payload,title,brand,price,rating,review_count,bsr,category")
        .in("asin", asins);
      const CACHE_HOURS = 24 * 7; // 7 days
      const now = Date.now();
      const staleAsins: string[] = [];
      for (const asin of asins) {
        const row = existing?.find(r => r.asin === asin);
        if (row?.last_enriched_at) {
          const age = (now - new Date(row.last_enriched_at).getTime()) / (1000 * 60 * 60);
          if (age < CACHE_HOURS && row.keepa_payload) {
            enrichMap[asin] = {
              asin, title: row.title, brand: row.brand, price: row.price, rating: row.rating,
              review_count: row.review_count, bsr: row.bsr, category: row.category, raw: row.keepa_payload,
            };
            continue;
          }
        }
        staleAsins.push(asin);
      }
      if (staleAsins.length) {
        const fresh = await keepaEnrich(staleAsins);
        Object.assign(enrichMap, fresh);
        await logApiCall(supabase, userId, "keepa", "product", `${staleAsins.length} ASINs`, "ok", staleAsins.length * 0.001);
      }
    } catch (e: any) {
      errors.push(`Keepa: ${e?.message ?? e}`);
      await logApiCall(supabase, userId, "keepa", "product", "enrichment", "error");
      usedMock.keepa = true;
    }
  } else if (asins.length) {
    usedMock.keepa = true;
  }

  // Merge enrichment into products where DataForSEO was missing fields
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

  // 4. Score
  const score = scoreOpportunity({
    seedKeyword,
    keywords: keywords.map(k => ({ keyword: k.keyword, search_volume: k.search_volume, intent_type: null })),
    products: products.map(p => ({
      asin: p.asin, title: p.title, brand: p.brand, price: p.price, rating: p.rating,
      review_count: p.review_count, image_url: p.image_url, is_sponsored: p.is_sponsored, position: p.position,
    })),
  });

  // 5. Memo
  let memo;
  if (isOpenAIConfigured()) {
    try {
      memo = await generateMemo({
        seedKeyword,
        topKeywords: keywords.slice(0, 15),
        topProducts: products.slice(0, 10),
        scores: {
          legion_score: score.legion_score,
          demand_score: score.demand_score,
          competition_weakness_score: score.competition_weakness_score,
          product_advantage_score: score.product_advantage_score,
          visual_demo_score: score.visual_demo_score,
          economics_score: score.economics_score,
          partner_score: score.partner_score,
          recommended_path: score.recommended_path,
        },
        metrics: score.metrics,
      });
      await logApiCall(supabase, userId, "openai", "chat.completions", seedKeyword, "ok");
    } catch (e: any) {
      errors.push(`OpenAI: ${e?.message ?? e}`);
      await logApiCall(supabase, userId, "openai", "chat.completions", seedKeyword, "error");
      usedMock.memo = true;
    }
  } else {
    usedMock.memo = true;
    const input: MemoInput = {
      seedKeyword,
      topKeywords: keywords.slice(0, 15),
      topProducts: products.slice(0, 10),
      scores: { ...score },
      metrics: score.metrics,
    };
    memo = await generateMemo(input); // generateMemo handles placeholder when key missing
  }

  // 6. Persist
  const threshold = scoreToThreshold(score.legion_score);
  const initialStatus: string = threshold === "deep_dive" ? "deep_dive" : threshold === "review" ? "review" : threshold === "watchlist" ? "watchlist" : "reject";

  // Auto-archive: keep active only if it meets the strict-winner bar
  // (legion_score >= 80 AND top_10_avg_reviews < 500). Everything else is
  // archived on insert so the dashboard stays clean. Steve can restore manually.
  const isWinner =
    score.legion_score >= 80 && (score.metrics.top_10_avg_reviews ?? Infinity) < 500;
  const archivedAt = isWinner ? null : new Date().toISOString();

  const { data: opp, error: oppErr } = await supabase
    .from("opportunities")
    .insert({
      user_id: userId,
      scan_id: scanId,
      name: formatOppName(seedKeyword),
      main_keyword: seedKeyword,
      category: inferCategory(seedKeyword),
      marketplace: "amazon_us",
      status: initialStatus,
      recommended_path: memo?.recommended_path ?? score.recommended_path,
      legion_score: score.legion_score,
      demand_score: score.demand_score,
      competition_weakness_score: score.competition_weakness_score,
      product_advantage_score: score.product_advantage_score,
      visual_demo_score: score.visual_demo_score,
      economics_score: score.economics_score,
      partner_score: score.partner_score,
      monthly_search_volume: score.metrics.monthly_search_volume,
      total_cluster_search_volume: score.metrics.total_cluster_search_volume,
      top_10_avg_reviews: score.metrics.top_10_avg_reviews,
      top_10_avg_rating: score.metrics.top_10_avg_rating,
      avg_price: score.metrics.avg_price,
      summary: memo?.summary,
      why_excited: memo?.why_excited,
      why_skeptical: memo?.why_skeptical,
      product_advantage_hypothesis: memo?.product_advantage_hypothesis,
      visual_demo_notes: memo?.visual_demo_notes,
      economics_notes: memo?.economics_notes,
      partner_notes: memo?.partner_notes,
      last_scanned_at: new Date().toISOString(),
      archived_at: archivedAt,
    })
    .select()
    .single();

  if (oppErr) throw oppErr;

  // keywords
  if (keywords.length) {
    const rows = keywords.slice(0, 100).map(k => ({
      opportunity_id: opp.id,
      keyword: k.keyword,
      search_volume: k.search_volume,
      intent_type: inferIntent(k.keyword),
      source: usedMock.keywords ? "mock" : "dataforseo",
    }));
    await supabase.from("keywords").insert(rows);
  }

  // products (upsert by asin + marketplace) — store one row per ASIN
  for (const p of products) {
    if (!p.asin) continue;
    const enrich = enrichMap[p.asin];
    const payload: any = {
      asin: p.asin,
      marketplace: "amazon_us",
      title: p.title,
      brand: p.brand,
      product_url: p.product_url,
      image_url: p.image_url,
      category: enrich?.category,
      price: p.price,
      rating: p.rating,
      review_count: p.review_count,
      bsr: enrich?.bsr,
      is_sponsored: p.is_sponsored ?? false,
      first_seen_at: enrich?.first_seen ?? new Date().toISOString(),
      last_enriched_at: enrich ? new Date().toISOString() : null,
      keepa_payload: enrich?.raw ?? null,
      dataforseo_payload: { position: p.position, is_sponsored: p.is_sponsored ?? false },
    };
    const { data: prodRow, error: prodErr } = await supabase
      .from("products")
      .upsert(payload, { onConflict: "asin,marketplace" })
      .select("id")
      .single();
    if (prodErr || !prodRow) continue;
    await supabase.from("opportunity_products").insert({
      opportunity_id: opp.id,
      product_id: prodRow.id,
      keyword: seedKeyword,
      position: p.position,
      organic_position: p.is_sponsored ? null : p.position,
      sponsored_position: p.is_sponsored ? p.position : null,
      listing_quality_score: calcListingQuality(p),
      weakness_notes: describeWeakness(p),
    });
  }

  await supabase.from("scans").update({
    status: "complete",
    completed_at: new Date().toISOString(),
    raw_input: { depth, usedMock, errors },
  }).eq("id", scanId);

  return { opportunityId: opp.id, score, usedMock, errors };
}

function formatOppName(seed: string) {
  return seed.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function inferCategory(seed: string): string {
  const kw = seed.toLowerCase();
  // Pest & wildlife
  if (/\b(mole|vole|gopher|snake|wasp|hornet|carpenter bee|mouse|rat|rodent|ant|roach|flea|tick|bug|bee|spider|pest|repellent|bait)\b/.test(kw)) return "Pest & Wildlife";
  // Auto detailing & restoration
  if (/\b(headlight|tar|brake dust|leather|overspray|clay bar|wheel cleaner|car wash|detailing|paint correction)\b/.test(kw)) return "Auto Detailing";
  // Pool & spa
  if (/\b(pool|spa|hot tub|chlorine|phosphate|clarifier|stabilizer|algaecide|well water|iron filter)\b/.test(kw)) return "Pool & Spa";
  // HVAC & appliance
  if (/\b(dishwasher|washing machine|dryer vent|garbage disposal|humidifier|ac coil|hvac|condenser|evaporator|appliance)\b/.test(kw)) return "HVAC & Appliance";
  // Lawn & turf
  if (/\b(stump|crabgrass|fungicide|herbicide|grub|dethatcher|lawn|turf|sewer line|root killer|grass)\b/.test(kw)) return "Lawn & Turf";
  // Pet odor & utility
  if (/\b(cat urine|dog ear|skunk|pet hair|pet odor|enzyme cleaner|flea spray)\b/.test(kw)) return "Pet Utility";
  // Tools & hardware
  if (/\b(screw extractor|bolt remover|drain snake|auger|thread repair|magnetic parts|impact driver|bit set|tool)\b/.test(kw)) return "Tools & Hardware";
  // Marine & RV
  if (/\b(boat|hull|rv|holding tank|bilge|antifreeze|generator|fouling|marine)\b/.test(kw)) return "Marine & RV";
  // Original chemicals categories
  if (/\b(concrete|masonry|grout|mortar)\b/.test(kw)) return "Concrete & Masonry";
  if (/\b(rust|corrosion)\b/.test(kw)) return "Rust & Corrosion";
  if (/\b(degreaser|grease|oil)\b/.test(kw)) return "Degreasers";
  if (/\b(graffiti|paint|adhesive|glue)\b/.test(kw)) return "Surface Removers";
  if (/\b(ice machine|descaler|scale|hard water)\b/.test(kw)) return "Descaling";
  if (/\b(kitchen|commercial kitchen)\b/.test(kw)) return "Commercial Kitchen";
  if (/\b(mold|mildew|odor|stain)\b/.test(kw)) return "Stain & Odor Control";
  if (/\b(floor stripper|janitorial|facility)\b/.test(kw)) return "Janitorial";
  if (/\b(asphalt)\b/.test(kw)) return "Asphalt & Roadway";
  if (/\b(equipment|industrial|commercial)\b/.test(kw)) return "Industrial Cleaners";
  return "Other";
}

function inferIntent(keyword: string): string {
  const kw = keyword.toLowerCase();
  if (/\b(best|top|reviews)\b/.test(kw)) return "research";
  if (/\b(how to|what is|why)\b/.test(kw)) return "informational";
  if (/\b(buy|amazon|near me|price)\b/.test(kw)) return "transactional";
  if (/\b(remover|cleaner|stripper|degreaser|descaler)\b/.test(kw)) return "commercial";
  return "general";
}

function calcListingQuality(p: DfsProduct): number {
  let s = 5;
  if (!p.title || p.title.length < 40) s -= 1;
  if (!p.image_url) s -= 1;
  if (!p.brand) s -= 1;
  if ((p.rating ?? 0) < 4.0) s -= 1;
  if ((p.review_count ?? 0) < 100) s -= 1;
  return Math.max(0, s);
}

function describeWeakness(p: DfsProduct): string {
  const notes: string[] = [];
  if ((p.review_count ?? 0) < 300) notes.push("low review count");
  if ((p.rating ?? 5) < 4.2) notes.push("mediocre rating");
  if (!p.brand) notes.push("brand unclear");
  if (!p.title || p.title.length < 60) notes.push("short title");
  if (p.is_sponsored) notes.push("paying for placement");
  return notes.length ? notes.join("; ") : "looks solid";
}
