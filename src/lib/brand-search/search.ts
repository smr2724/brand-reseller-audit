/**
 * Phase 25 — Fuzzy brand search service.
 *
 * Coordinates Keepa variant fan-out + DataForSEO Amazon SERP in parallel,
 * dedupes by Amazon brand string (case-insensitive), and returns the top 10
 * candidates ranked by similarity to the original input.
 *
 * Design principle: search inputs to brand discovery should never return
 * zero results unless we've tried at least (1) exact, (2) deterministic
 * variants, (3) external Amazon search. We always show the user a list when
 * we possibly can — humans pick the right brand from a small list better
 * than fuzzy matchers do.
 */
import {
  searchProductsByBrand,
  isKeepaConfigured,
} from "@/lib/keepa";
import { amazonSerpLive, isDataForSEOConfigured } from "@/lib/dataforseo";
import { tightVariants, looseVariants, normalizeQuery } from "./variants";
import { similarity } from "./similarity";

export type BrandSearchMode = "tight" | "loose";

export interface BrandCandidate {
  name: string;
  source: "keepa" | "dataforseo" | "both";
  asin_count: number | null;
  storefront_url: string | null;
  similarity: number;
  matched_variant?: string;
}

export interface BrandSearchResult {
  candidates: BrandCandidate[];
  exhausted: boolean;
  variants_tried: string[];
  duration_ms: number;
}

interface CacheEntry {
  t: number;
  v: BrandSearchResult;
}
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

function cacheKey(query: string, mode: BrandSearchMode): string {
  return `${mode}::${normalizeQuery(query)}`;
}

function storefrontUrlForBrand(brand: string): string {
  return `https://www.amazon.com/s?k=${encodeURIComponent(brand)}&i=brands`;
}

function dedupeByBrand(candidates: BrandCandidate[]): BrandCandidate[] {
  const map = new Map<string, BrandCandidate>();
  for (const c of candidates) {
    const key = c.name.toLowerCase().trim();
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, c);
      continue;
    }
    // Merge: prefer the higher similarity, sum ASIN counts (cap at the max),
    // upgrade source to "both" when sources differ, retain best storefront.
    const merged: BrandCandidate = {
      ...prev,
      asin_count:
        (prev.asin_count ?? 0) >= (c.asin_count ?? 0)
          ? prev.asin_count
          : c.asin_count,
      source: prev.source === c.source ? prev.source : "both",
      storefront_url: prev.storefront_url ?? c.storefront_url,
      similarity: Math.max(prev.similarity, c.similarity),
      matched_variant: prev.matched_variant ?? c.matched_variant,
    };
    map.set(key, merged);
  }
  return Array.from(map.values());
}

async function runKeepaForVariant(variant: string): Promise<BrandCandidate[]> {
  try {
    const res = await searchProductsByBrand(variant, 5);
    if (!res.asins.length) return [];
    // Keepa /query returns ASINs filtered on brand=variant. We treat the
    // variant string as the brand name for ranking; the actual product
    // detail fetch happens later in the create-from-lookup flow.
    return [
      {
        name: variant,
        source: "keepa",
        asin_count: res.asins.length,
        storefront_url: storefrontUrlForBrand(variant),
        similarity: 0, // filled in by ranker
        matched_variant: variant,
      },
    ];
  } catch (err) {
    console.warn("[brand-search] keepa variant failed", variant, (err as Error)?.message);
    return [];
  }
}

async function runDataForSeoSearch(query: string): Promise<BrandCandidate[]> {
  try {
    const products = await amazonSerpLive(query, { depth: 20 });
    const byBrand = new Map<string, number>();
    for (const p of products) {
      const brand = (p.brand || "").trim();
      if (!brand) continue;
      byBrand.set(brand, (byBrand.get(brand) ?? 0) + 1);
    }
    return Array.from(byBrand.entries()).map(([name, count]) => ({
      name,
      source: "dataforseo" as const,
      asin_count: count,
      storefront_url: storefrontUrlForBrand(name),
      similarity: 0,
      matched_variant: query,
    }));
  } catch (err) {
    console.warn("[brand-search] dataforseo failed", (err as Error)?.message);
    return [];
  }
}

export async function searchBrands(
  rawQuery: string,
  mode: BrandSearchMode = "tight",
): Promise<BrandSearchResult> {
  const started = Date.now();
  const query = rawQuery.trim();
  if (!query) {
    return { candidates: [], exhausted: true, variants_tried: [], duration_ms: 0 };
  }

  const key = cacheKey(query, mode);
  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.t < CACHE_TTL_MS) {
    return cached.v;
  }

  const variants = mode === "loose" ? looseVariants(query) : tightVariants(query);

  const keepaTask: Promise<BrandCandidate[]> = isKeepaConfigured()
    ? Promise.all(variants.map(runKeepaForVariant)).then((arrs) => arrs.flat())
    : Promise.resolve([]);

  const dfsTask: Promise<BrandCandidate[]> = isDataForSEOConfigured()
    ? runDataForSeoSearch(query)
    : Promise.resolve([]);

  const [keepaResults, dfsResults] = await Promise.all([keepaTask, dfsTask]);
  const merged = dedupeByBrand([...keepaResults, ...dfsResults]);

  for (const c of merged) {
    c.similarity = similarity(query, c.name);
  }

  merged.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    return (b.asin_count ?? 0) - (a.asin_count ?? 0);
  });

  const top = merged.slice(0, 10);
  const exhausted = mode === "loose" || top.length === 0;
  const result: BrandSearchResult = {
    candidates: top,
    exhausted,
    variants_tried: variants,
    duration_ms: Date.now() - started,
  };
  CACHE.set(key, { t: Date.now(), v: result });
  return result;
}

export function clearBrandSearchCache() {
  CACHE.clear();
}
