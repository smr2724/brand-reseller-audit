/**
 * Phase 4.5 — Per-brand DataForSEO enrichment.
 *
 * Pulls market-demand signals (branded keyword volume + trend, top keywords,
 * SERP competitor footprint) for a single brand and persists a snapshot to
 * `brand_search_metrics`. A 30-day cache in `dataforseo_cache` keeps token
 * spend in line with the per-brand Keepa budget.
 *
 * Pure data-collection — scoring is in ./scoring.ts, the public bundle
 * helper is in ./index.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  amazonRelatedKeywords,
  amazonBulkSearchVolume,
  amazonSerpLive,
  isDataForSEOConfigured,
  type DfsKeyword,
  type DfsProduct,
} from "@/lib/dataforseo";

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_KEYWORDS = 15;       // top-N retained on the brand summary
const SERP_DEPTH = 30;         // SERP positions inspected for competitor share
const MAX_SERP_QUERIES = 2;    // budget cap — SERP tasks are the expensive part

export interface DataForSeoSnapshot {
  branded_search_volume: number | null;
  branded_trend_pct: number | null;
  top_keywords: { keyword: string; search_volume: number | null }[];
  competitor_brands: { brand: string; share_of_serp: number }[];
  serp_positions: { keyword: string; asin?: string; brand?: string; position: number; is_brand: boolean }[];
  organic_traffic_value: number | null;
  captured_at: string;
  enrichment_error: string | null;
}

export interface EnrichDfsInput {
  brand_id: string;
  brand_name: string;
  user_id: string;
}

// =============================================================
// Cache helpers (cross-user, service-role only)
// =============================================================

async function cacheGet<T = any>(
  admin: SupabaseClient<any, any, any>,
  key: string,
): Promise<T | null> {
  try {
    const { data } = await admin
      .from("dataforseo_cache")
      .select("payload, expires_at")
      .eq("key", key)
      .maybeSingle();
    if (!data) return null;
    if (new Date(data.expires_at).getTime() < Date.now()) return null;
    return data.payload as T;
  } catch {
    return null;
  }
}

async function cachePut(
  admin: SupabaseClient<any, any, any>,
  key: string,
  payload: any,
): Promise<void> {
  try {
    const expires_at = new Date(Date.now() + CACHE_TTL_MS).toISOString();
    await admin
      .from("dataforseo_cache")
      .upsert(
        { key, payload, fetched_at: new Date().toISOString(), expires_at },
        { onConflict: "key" },
      );
  } catch {
    // Cache failures are non-fatal.
  }
}

// =============================================================
// Public collection helpers — exported for the smoke-test script.
// Each tier returns null/empty on failure so the caller can degrade gracefully.
// =============================================================

export async function fetchBrandKeywords(
  admin: SupabaseClient<any, any, any> | null,
  brandName: string,
): Promise<DfsKeyword[]> {
  const key = `dfs:related:${brandName.toLowerCase()}`;
  if (admin) {
    const cached = await cacheGet<DfsKeyword[]>(admin, key);
    if (cached) return cached;
  }
  let kws: DfsKeyword[] = [];
  try {
    kws = await amazonRelatedKeywords(brandName, { limit: 80 });
  } catch (e) {
    // Fallback: bulk volume on the seed alone.
    try {
      kws = await amazonBulkSearchVolume([brandName]);
    } catch {
      kws = [];
    }
  }
  if (admin) await cachePut(admin, key, kws);
  return kws;
}

export async function fetchBrandSerp(
  admin: SupabaseClient<any, any, any> | null,
  keyword: string,
): Promise<DfsProduct[]> {
  const key = `dfs:serp:${keyword.toLowerCase()}`;
  if (admin) {
    const cached = await cacheGet<DfsProduct[]>(admin, key);
    if (cached) return cached;
  }
  let products: DfsProduct[] = [];
  try {
    products = await amazonSerpLive(keyword, { depth: SERP_DEPTH });
  } catch {
    products = [];
  }
  if (admin) await cachePut(admin, key, products);
  return products;
}

// =============================================================
// Aggregation helpers
// =============================================================

function brandedFilter(keywords: DfsKeyword[], brandName: string): DfsKeyword[] {
  const needle = brandName.toLowerCase().trim();
  if (!needle) return [];
  return keywords.filter((k) => k.keyword.toLowerCase().includes(needle));
}

function brandSerpMatch(productBrand: string | undefined, brandName: string): boolean {
  if (!productBrand) return false;
  const a = productBrand.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = brandName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!a || !b) return false;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

function summarizeCompetitors(
  serpByKeyword: { keyword: string; products: DfsProduct[] }[],
  brandName: string,
): { brand: string; share_of_serp: number }[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const { products } of serpByKeyword) {
    for (const p of products) {
      const b = (p.brand ?? "").trim();
      if (!b) continue;
      total += 1;
      // Roll the prospect brand together regardless of casing variants.
      const key = brandSerpMatch(b, brandName) ? brandName : b;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  if (!total) return [];
  return Array.from(counts.entries())
    .filter(([b]) => !brandSerpMatch(b, brandName))
    .map(([brand, n]) => ({ brand, share_of_serp: n / total }))
    .sort((a, b) => b.share_of_serp - a.share_of_serp)
    .slice(0, 10);
}

function flattenSerpPositions(
  serpByKeyword: { keyword: string; products: DfsProduct[] }[],
  brandName: string,
): DataForSeoSnapshot["serp_positions"] {
  const out: DataForSeoSnapshot["serp_positions"] = [];
  for (const { keyword, products } of serpByKeyword) {
    for (const p of products) {
      if (p.position == null) continue;
      out.push({
        keyword,
        asin: p.asin,
        brand: p.brand,
        position: p.position,
        is_brand: brandSerpMatch(p.brand, brandName),
      });
    }
  }
  return out
    .sort((a, b) => a.position - b.position)
    .slice(0, 60);
}

function estimateTrafficValue(branded: DfsKeyword[]): number | null {
  // Lightweight CTR-weighted estimate. We don't have CPCs here, so we
  // assume a typical Amazon branded CTR of 35% at #1 falling off log-style
  // and a $0.75 effective per-click value. This is an Assumption block —
  // the report is required to label it as such.
  if (!branded.length) return null;
  let total = 0;
  for (const k of branded) {
    const v = k.search_volume ?? 0;
    if (!v) continue;
    total += v * 0.35 * 0.75;
  }
  return total > 0 ? Math.round(total) : null;
}

// =============================================================
// Top-level orchestrator
// =============================================================

export async function enrichBrandWithDataForSeo(
  admin: SupabaseClient<any, any, any>,
  input: EnrichDfsInput,
): Promise<DataForSeoSnapshot> {
  const { brand_id, brand_name, user_id } = input;
  const captured_at = new Date().toISOString();

  if (!isDataForSEOConfigured()) {
    return emptySnapshot("DataForSEO credentials missing");
  }

  let snapshot: DataForSeoSnapshot;
  try {
    // 1. Pull related keywords + branded volumes.
    const keywords = await fetchBrandKeywords(admin, brand_name);
    const branded = brandedFilter(keywords, brand_name);
    const branded_search_volume = branded.reduce(
      (a, k) => a + (typeof k.search_volume === "number" ? k.search_volume : 0),
      0,
    );

    const top_keywords = (branded.length ? branded : keywords)
      .slice()
      .sort((a, b) => (b.search_volume ?? 0) - (a.search_volume ?? 0))
      .slice(0, MAX_KEYWORDS)
      .map((k) => ({ keyword: k.keyword, search_volume: k.search_volume }));

    // 2. Pull SERP for the top branded keywords (budget capped).
    const serpKeywords = top_keywords
      .filter((k) => (k.search_volume ?? 0) > 0)
      .slice(0, MAX_SERP_QUERIES)
      .map((k) => k.keyword);
    const serpByKeyword: { keyword: string; products: DfsProduct[] }[] = [];
    for (const kw of serpKeywords) {
      const products = await fetchBrandSerp(admin, kw);
      serpByKeyword.push({ keyword: kw, products });
    }

    const competitor_brands = summarizeCompetitors(serpByKeyword, brand_name);
    const serp_positions = flattenSerpPositions(serpByKeyword, brand_name);
    const organic_traffic_value = estimateTrafficValue(branded);

    // 3. Trend — DataForSEO volumes are not historical here, so we fall back
    // to comparing to the most recent prior brand_search_metrics row.
    const branded_trend_pct = await computeTrendPct(
      admin,
      brand_id,
      branded_search_volume,
    );

    snapshot = {
      branded_search_volume: branded_search_volume || null,
      branded_trend_pct,
      top_keywords,
      competitor_brands,
      serp_positions,
      organic_traffic_value,
      captured_at,
      enrichment_error: null,
    };
  } catch (err: any) {
    return emptySnapshot(String(err?.message ?? err).slice(0, 500));
  }

  // 4. Persist a snapshot row + brand-level summary columns.
  try {
    await admin.from("brand_search_metrics").insert({
      user_id,
      brand_id,
      branded_search_volume: snapshot.branded_search_volume,
      branded_trend_pct: snapshot.branded_trend_pct,
      top_keywords: snapshot.top_keywords,
      competitor_brands: snapshot.competitor_brands,
      serp_positions: snapshot.serp_positions,
      organic_traffic_value: snapshot.organic_traffic_value,
      captured_at,
    });

    await admin
      .from("brands")
      .update({
        dataforseo_last_enriched_at: captured_at,
        dataforseo_branded_volume: snapshot.branded_search_volume,
        dataforseo_branded_trend_pct: snapshot.branded_trend_pct,
        dataforseo_competitor_count: snapshot.competitor_brands.length,
        dataforseo_top_keyword: snapshot.top_keywords[0]?.keyword ?? null,
        updated_at: captured_at,
      })
      .eq("id", brand_id)
      .eq("user_id", user_id);
  } catch {
    // Persistence failure shouldn't fail the bundle — the report can still use
    // the in-memory snapshot. Validation score will pick it up next run.
  }

  return snapshot;
}

async function computeTrendPct(
  admin: SupabaseClient<any, any, any>,
  brandId: string,
  currentVolume: number,
): Promise<number | null> {
  if (!currentVolume) return null;
  try {
    const { data } = await admin
      .from("brand_search_metrics")
      .select("branded_search_volume, captured_at")
      .eq("brand_id", brandId)
      .order("captured_at", { ascending: false })
      .limit(1);
    const prev = data?.[0]?.branded_search_volume;
    if (!prev || prev <= 0) return null;
    return Math.round(((currentVolume - prev) / prev) * 1000) / 10;
  } catch {
    return null;
  }
}

function emptySnapshot(error: string | null): DataForSeoSnapshot {
  return {
    branded_search_volume: null,
    branded_trend_pct: null,
    top_keywords: [],
    competitor_brands: [],
    serp_positions: [],
    organic_traffic_value: null,
    captured_at: new Date().toISOString(),
    enrichment_error: error,
  };
}

// Re-export DfsKeyword/DfsProduct so consumers don't reach into the provider.
export type { DfsKeyword, DfsProduct };
