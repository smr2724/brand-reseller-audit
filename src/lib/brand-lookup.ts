/**
 * Phase 9 — Keepa-backed brand lookup with cross-user 24h cache.
 *
 * Used by the internal `/app/brands/new` flow and the public
 * `/audit-request` worker. We:
 *   1. Look up cached results for a normalized query.
 *   2. If miss/stale, hit Keepa `searchProductsByBrand` then fetch
 *      product details for the first batch of ASINs.
 *   3. Group ASINs by their Keepa-reported `brand`, derive a confidence
 *      score from match-quality + ASIN count + buy-box concentration.
 *   4. Persist the consolidated result in `brand_lookup_cache`.
 *
 * The aim is to keep the Add-Brand-by-Name UX fast and stop us from
 * burning Keepa tokens on repeat lookups (especially the marketing-site
 * worker re-checking the same brand multiple times).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  searchProductsByBrand,
  getProductDetails,
  type KeepaProductDetails,
} from "@/lib/keepa";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface BrandLookupCandidate {
  brand: string;
  asin_count: number;
  top_seller: string | null;
  est_monthly_revenue: number | null;
  confidence: number; // 0..1
  example_asins: string[];
}

export interface BrandLookupResult {
  query: string;
  normalized: string;
  candidates: BrandLookupCandidate[];
  from_cache: boolean;
  fetched_at: string;
}

export function normalizeBrandLookupQuery(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

export async function lookupBrand(
  admin: SupabaseClient<any, any, any>,
  rawQuery: string,
  opts: { maxAsins?: number; force?: boolean } = {},
): Promise<BrandLookupResult> {
  const trimmed = rawQuery.trim();
  if (!trimmed) {
    return {
      query: rawQuery,
      normalized: "",
      candidates: [],
      from_cache: false,
      fetched_at: new Date().toISOString(),
    };
  }
  const normalized = normalizeBrandLookupQuery(trimmed);

  // 1. Cache hit?
  if (!opts.force) {
    const { data: cached } = await admin
      .from("brand_lookup_cache")
      .select("query, keepa_results, result_count, fetched_at")
      .eq("query", normalized)
      .maybeSingle();
    if (cached) {
      const age = Date.now() - new Date(cached.fetched_at).getTime();
      if (Number.isFinite(age) && age < CACHE_TTL_MS) {
        const candidates = (cached.keepa_results as { candidates?: BrandLookupCandidate[] })?.candidates ?? [];
        return {
          query: rawQuery,
          normalized,
          candidates,
          from_cache: true,
          fetched_at: cached.fetched_at,
        };
      }
    }
  }

  // 2. Cache miss — call Keepa.
  const search = await searchProductsByBrand(trimmed, opts.maxAsins ?? 20);
  if (!search.asins.length) {
    const empty: BrandLookupResult = {
      query: rawQuery,
      normalized,
      candidates: [],
      from_cache: false,
      fetched_at: new Date().toISOString(),
    };
    await persistCache(admin, normalized, empty.candidates);
    return empty;
  }

  let products: KeepaProductDetails[] = [];
  try {
    products = await getProductDetails(search.asins.slice(0, 10), 5);
  } catch (e) {
    // If product detail fetch fails we still return at least the ASIN
    // count so the UI shows something. Fall through with empty products.
    console.warn("[brand-lookup] getProductDetails failed:", (e as Error)?.message);
  }

  const candidates = buildCandidates(trimmed, search.asins, products);
  const result: BrandLookupResult = {
    query: rawQuery,
    normalized,
    candidates,
    from_cache: false,
    fetched_at: new Date().toISOString(),
  };
  await persistCache(admin, normalized, candidates);
  return result;
}

async function persistCache(
  admin: SupabaseClient<any, any, any>,
  normalized: string,
  candidates: BrandLookupCandidate[],
) {
  if (!normalized) return;
  await admin
    .from("brand_lookup_cache")
    .upsert(
      {
        query: normalized,
        keepa_results: { candidates },
        result_count: candidates.length,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "query" },
    );
}

function buildCandidates(
  query: string,
  asins: string[],
  products: KeepaProductDetails[],
): BrandLookupCandidate[] {
  // Group products by their Keepa-reported brand. ASINs without a
  // detail row fall into a synthetic "(unknown brand)" bucket only if
  // it ends up being the only group.
  const byBrand = new Map<
    string,
    {
      brand: string;
      asins: string[];
      sellerTally: Map<string, number>;
      priceSum: number;
      priceCount: number;
    }
  >();

  for (const p of products) {
    const brand = (p.brand || "").trim();
    if (!brand) continue;
    const key = brand.toLowerCase();
    const bucket =
      byBrand.get(key) ??
      {
        brand,
        asins: [],
        sellerTally: new Map<string, number>(),
        priceSum: 0,
        priceCount: 0,
      };
    bucket.asins.push(p.asin);
    if (p.buy_box_seller) {
      bucket.sellerTally.set(p.buy_box_seller, (bucket.sellerTally.get(p.buy_box_seller) ?? 0) + 1);
    }
    if (typeof p.buy_box_price === "number" && p.buy_box_price > 0) {
      bucket.priceSum += p.buy_box_price;
      bucket.priceCount += 1;
    }
    byBrand.set(key, bucket);
  }

  // If we got zero detail rows back, return a single low-confidence
  // candidate so the user still sees the search hit count.
  if (byBrand.size === 0) {
    return [
      {
        brand: query,
        asin_count: asins.length,
        top_seller: null,
        est_monthly_revenue: null,
        confidence: scoreConfidence(query, query, asins.length),
        example_asins: asins.slice(0, 3),
      },
    ];
  }

  const all = Array.from(byBrand.values()).map((b) => {
    let topSeller: string | null = null;
    let topCount = 0;
    for (const entry of Array.from(b.sellerTally.entries())) {
      const [seller, count] = entry;
      if (count > topCount) {
        topCount = count;
        topSeller = seller;
      }
    }
    const avgPrice = b.priceCount ? b.priceSum / b.priceCount : null;
    // Rough est-monthly-revenue: avgPrice * asin_count * 30 *
    // assumed-units-per-day-per-asin. We deliberately stay conservative
    // (1.5 units/day) — it's a directional preview, not a forecast. The
    // real number comes from the actual report after enrichment.
    const est = avgPrice ? Math.round(avgPrice * b.asins.length * 30 * 1.5) : null;
    return {
      brand: b.brand,
      asin_count: b.asins.length,
      top_seller: topSeller,
      est_monthly_revenue: est,
      confidence: scoreConfidence(query, b.brand, b.asins.length),
      example_asins: b.asins.slice(0, 3),
    } satisfies BrandLookupCandidate;
  });

  all.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.asin_count - a.asin_count;
  });
  return all.slice(0, 5);
}

/**
 * Score 0..1 mixing string similarity to the query and ASIN count.
 * High-signal exact match > many products under the brand.
 */
function scoreConfidence(query: string, brand: string, asinCount: number): number {
  const q = query.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = brand.toLowerCase().replace(/[^a-z0-9]/g, "");
  let stringScore = 0;
  if (!q || !b) stringScore = 0.3;
  else if (q === b) stringScore = 1;
  else if (b.startsWith(q) || q.startsWith(b)) stringScore = 0.85;
  else if (b.includes(q) || q.includes(b)) stringScore = 0.7;
  else stringScore = 0.4;

  const sizeBoost = Math.min(0.2, asinCount / 100);
  return Math.min(1, stringScore + sizeBoost);
}
