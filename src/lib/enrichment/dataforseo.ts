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
  googleAdsSearchVolumeLive,
  isDataForSEOConfigured,
  type DfsKeyword,
  type DfsProduct,
  type GoogleAdsMonthlySearch,
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
  /** Optional category-seed phrases (e.g. "makeup remover wipes") used
   * to pull related_keywords beyond just the brand name. Inferred from
   * the brand's most-common ASIN titles upstream. */
  category_seeds?: string[];
  /** Per-title vocabulary (words appearing in ≥ 2 ASIN titles). Used
   * to filter related-keyword expansions so off-topic drift (e.g.
   * "butcher paper" leaking from a single "kraft paper sachet" SKU)
   * never makes it into top_keywords. */
  title_vocab?: string[];
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
  const category_seeds = input.category_seeds ?? [];
  const title_vocab = input.title_vocab ?? [];
  const captured_at = new Date().toISOString();

  if (!isDataForSEOConfigured()) {
    return emptySnapshot("DataForSEO credentials missing");
  }

  let snapshot: DataForSeoSnapshot;
  try {
    // 1. Pull related keywords seeded with the brand name AND with any
    // category-seed phrases inferred from the catalog (e.g. "makeup
    // remover wipes" for World Amenities). Branded volume is computed
    // only from the brand-seeded set; category seeds are merged in to
    // expand top_keywords beyond a single branded search row.
    const brandedKws = await fetchBrandKeywords(admin, brand_name);
    const branded = brandedFilter(brandedKws, brand_name);
    const branded_search_volume = branded.reduce(
      (a, k) => a + (typeof k.search_volume === "number" ? k.search_volume : 0),
      0,
    );

    const categoryKws: DfsKeyword[] = [];
    for (const seed of category_seeds.slice(0, 2)) {
      try {
        const kws = await fetchCategoryKeywords(admin, seed);
        for (const k of kws) categoryKws.push(k);
      } catch (e) {
        console.warn("[dfs] category-seed related_keywords failed:", seed, e);
      }
    }

    // Merge → dedupe → filter to keep keywords on-topic with the
    // brand's catalog, then take top 12 by search_volume.
    const merged = mergeAndTag(branded, categoryKws, brand_name);
    const filtered = filterRelevant(merged, brand_name, category_seeds, title_vocab);
    const top_keywords = filtered.slice(0, MAX_KEYWORDS);

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

    // 3. Trend — pull Google Ads monthly_searches[] for the brand
    // keyword and compute (last_3 − prior_3) / prior_3. This is the
    // authoritative number the report cites; the prior brand_search_metrics
    // delta is a fallback for when Google Ads has no data on the brand.
    const branded_trend_pct = await computeBrandedTrendPct(
      admin,
      brand_id,
      brand_name,
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

/**
 * Pull related keywords for a category-seed phrase (e.g. "makeup remover
 * wipes"). Cached cross-user for 30 days under a `dfs:catkw:<seed>` key
 * so different brands in the same category share the lookup.
 */
async function fetchCategoryKeywords(
  admin: SupabaseClient<any, any, any> | null,
  seed: string,
): Promise<DfsKeyword[]> {
  const key = `dfs:catkw:${seed.toLowerCase()}`;
  if (admin) {
    const cached = await cacheGet<DfsKeyword[]>(admin, key);
    if (cached) return cached;
  }
  let kws: DfsKeyword[] = [];
  try {
    kws = await amazonRelatedKeywords(seed, { limit: 60 });
  } catch {
    try {
      kws = await amazonBulkSearchVolume([seed]);
    } catch {
      kws = [];
    }
  }
  if (admin) await cachePut(admin, key, kws);
  return kws;
}

type RankedKeyword = {
  keyword: string;
  search_volume: number | null;
  category?: "branded" | "category";
};

/**
 * Filter merged related-keyword output down to keywords that look like
 * they belong to the brand's actual catalog. Without this filter, DFS
 * related_keywords on a category seed can drift hard (e.g. seeding
 * "kraft paper" because one shower-cap SKU is in a kraft sachet
 * pulled in "butcher paper", "kraft paper roll", etc).
 *
 * Rules, in order:
 *   1. Always keep the brand name (we sort it to the front later).
 *   2. Always keep keywords containing the brand name string.
 *   3. Otherwise, every non-stopword token of the keyword must be in
 *      `titleVocab` OR appear in one of the seed phrases. Trailing
 *      modifier nouns from one-off SKUs ("bags", "roll", "sheets")
 *      get dropped this way.
 *
 * If `titleVocab` is empty (older callers), we fall through to the
 * looser legacy behaviour of dropping only obvious off-topic phrases.
 */
function filterRelevant(
  merged: RankedKeyword[],
  brandName: string,
  seeds: string[],
  titleVocab: string[],
): RankedKeyword[] {
  if (!merged.length) return merged;
  const brandLower = brandName.toLowerCase().trim();
  const STOP = new Set([
    "the", "and", "for", "with", "from", "into", "your", "you",
    "best", "top", "new", "free", "premium",
  ]);
  const vocab = new Set(titleVocab.map((w) => w.toLowerCase()));
  const seedTokens = new Set<string>();
  for (const s of seeds) {
    for (const t of s.toLowerCase().split(/\s+/)) {
      if (t && !STOP.has(t)) seedTokens.add(t);
    }
  }
  const allow = new Set<string>();
  vocab.forEach((v) => allow.add(v));
  seedTokens.forEach((v) => allow.add(v));

  // Always keep the brand keyword itself, even if vocab is empty.
  const out: RankedKeyword[] = [];
  for (const k of merged) {
    const kw = k.keyword.toLowerCase().trim();
    if (!kw) continue;
    if (kw === brandLower || kw.includes(brandLower)) {
      out.push(k);
      continue;
    }
    if (allow.size === 0) {
      // No vocab/seed signal — fall through to legacy permissive behaviour
      // so we don't regress small-catalog brands.
      out.push(k);
      continue;
    }
    const tokens = kw.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));
    if (tokens.length === 0) continue;
    // Every non-stopword token of the keyword must be in title vocab
    // or in a seed phrase. The strict rule is intentional: a permissive
    // "any token matches" filter lets "butcher paper" through (because
    // "paper" is in vocab from a kraft-paper SKU). The downside is we
    // also drop adjacent terms like "body wash" when "wash" only
    // appears in one title — that's the right trade-off; the report
    // would rather print 5 on-topic keywords than 12 with one false
    // positive that visibly mislabels the brand's category.
    const ok = tokens.every((t) => allow.has(t));
    if (ok) out.push(k);
  }

  // Sort: brand keywords first, then by descending search volume.
  out.sort((a, b) => {
    const aBrand = a.keyword.toLowerCase().includes(brandLower) ? 1 : 0;
    const bBrand = b.keyword.toLowerCase().includes(brandLower) ? 1 : 0;
    if (aBrand !== bBrand) return bBrand - aBrand;
    return (b.search_volume ?? 0) - (a.search_volume ?? 0);
  });

  return out;
}

function mergeAndTag(
  branded: DfsKeyword[],
  category: DfsKeyword[],
  brandName: string,
): { keyword: string; search_volume: number | null; category?: "branded" | "category" }[] {
  const seen = new Map<string, { keyword: string; search_volume: number | null; category: "branded" | "category" }>();
  for (const k of branded) {
    const key = k.keyword.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, { keyword: k.keyword, search_volume: k.search_volume, category: "branded" });
    }
  }
  for (const k of category) {
    const key = k.keyword.toLowerCase();
    // Skip phrases that are essentially the brand name; they're already
    // counted on the branded side.
    if (key.includes(brandName.toLowerCase())) continue;
    if (!seen.has(key)) {
      seen.set(key, { keyword: k.keyword, search_volume: k.search_volume, category: "category" });
    }
  }
  return Array.from(seen.values()).sort(
    (a, b) => (b.search_volume ?? 0) - (a.search_volume ?? 0),
  );
}

/**
 * Compute (last_3_avg − prior_3_avg) / prior_3_avg from Google Ads
 * monthly_searches[]. Returns the trend as a percentage rounded to 1
 * decimal place (e.g. 12.4 means +12.4%). Falls back to the prior
 * brand_search_metrics snapshot when Google Ads returns no usable
 * history for the brand keyword.
 */
async function computeBrandedTrendPct(
  admin: SupabaseClient<any, any, any>,
  brandId: string,
  brandName: string,
  currentVolume: number,
): Promise<number | null> {
  try {
    const series = await googleAdsSearchVolumeLive([brandName]);
    const months = pickMonthlySeries(series, brandName);
    if (months.length >= 6) {
      const sorted = months
        .slice()
        .sort((a, b) => (b.year * 12 + b.month) - (a.year * 12 + a.month));
      const last3 = sorted.slice(0, 3);
      const prior3 = sorted.slice(3, 6);
      const last3avg = avg(last3.map((m) => m.search_volume ?? 0));
      const prior3avg = avg(prior3.map((m) => m.search_volume ?? 0));
      if (prior3avg > 0) {
        return Math.round(((last3avg - prior3avg) / prior3avg) * 1000) / 10;
      }
      // prior_3_avg = 0 with last_3_avg > 0 → effectively new demand.
      // Returning a number isn't meaningful (divide by zero), so fall
      // back rather than claim "+infinity".
    }
  } catch (e) {
    console.warn("[dfs] google_ads search_volume failed:", e);
  }
  // Fallback: snapshot-vs-snapshot delta.
  return computeTrendPct(admin, brandId, currentVolume);
}

function pickMonthlySeries(
  series: { keyword: string; monthly_searches: GoogleAdsMonthlySearch[] }[],
  brandName: string,
): GoogleAdsMonthlySearch[] {
  const target = brandName.toLowerCase().trim();
  const exact = series.find((s) => s.keyword.toLowerCase().trim() === target);
  if (exact?.monthly_searches?.length) return exact.monthly_searches;
  const partial = series.find((s) => s.keyword.toLowerCase().includes(target));
  return partial?.monthly_searches ?? [];
}

function avg(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
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
