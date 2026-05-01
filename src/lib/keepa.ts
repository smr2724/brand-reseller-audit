/**
 * Keepa client — ASIN enrichment.
 * Token-conscious: checks Supabase product cache freshness (last_enriched_at)
 * before calling Keepa.
 */

const BASE = "https://api.keepa.com";

export function isKeepaConfigured() {
  return !!process.env.KEEPA_API_KEY;
}

const DOMAIN_ID = Number(process.env.KEEPA_DOMAIN_ID ?? 1); // Amazon US

export async function testKeepa() {
  const key = process.env.KEEPA_API_KEY;
  if (!key) return { ok: false, error: "KEEPA_API_KEY missing" };
  try {
    const res = await fetch(`${BASE}/token?key=${key}`, { cache: "no-store" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      ok: true,
      tokens_left: data?.tokensLeft,
      refill_in: data?.refillIn,
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export interface KeepaEnrichment {
  asin: string;
  title?: string;
  brand?: string;
  category?: string;
  price?: number;
  rating?: number;
  review_count?: number;
  bsr?: number;
  package_dimensions?: any;
  first_seen?: string;
  raw?: any;
}

/**
 * Enrich a list of ASINs in a single Keepa call (up to 100).
 * Returns map keyed by ASIN.
 */
export async function keepaEnrich(asins: string[]): Promise<Record<string, KeepaEnrichment>> {
  const key = process.env.KEEPA_API_KEY;
  const out: Record<string, KeepaEnrichment> = {};
  if (!key) return out;
  const clean = Array.from(new Set(asins.filter(a => a && /^[A-Z0-9]{10}$/i.test(a)))).slice(0, 100);
  if (!clean.length) return out;
  const url = `${BASE}/product?key=${key}&domain=${DOMAIN_ID}&asin=${clean.join(",")}&stats=180`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Keepa ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const products = data?.products ?? [];
  for (const p of products) {
    const asin = p?.asin as string;
    if (!asin) continue;
    const current = p?.stats?.current ?? [];
    // Keepa CSV index constants: 0=AMAZON, 1=NEW, 3=SALES_RANK, 16=RATING, 17=COUNT_REVIEWS
    const amazonPriceCents = current[0] ?? -1;
    const newPriceCents = current[1] ?? -1;
    const price = newPriceCents > 0 ? newPriceCents / 100 : (amazonPriceCents > 0 ? amazonPriceCents / 100 : undefined);
    const bsr = current[3] > 0 ? current[3] : undefined;
    const ratingRaw = current[16];
    const rating = typeof ratingRaw === "number" && ratingRaw > 0 ? ratingRaw / 10 : undefined;
    const reviewCount = current[17] > 0 ? current[17] : undefined;
    out[asin] = {
      asin,
      title: p?.title,
      brand: p?.brand,
      category: Array.isArray(p?.categoryTree) ? p.categoryTree.map((c: any) => c?.name).filter(Boolean).join(" > ") : undefined,
      price,
      rating,
      review_count: reviewCount,
      bsr,
      package_dimensions: p?.packageDimensions ?? {
        length: p?.packageLength, width: p?.packageWidth, height: p?.packageHeight, weight: p?.packageWeight,
      },
      first_seen: p?.trackingSince ? new Date((p.trackingSince + 21564000) * 60 * 1000).toISOString() : undefined,
      raw: { tokensLeft: data?.tokensLeft, stats: p?.stats, eanList: p?.eanList, numberOfItems: p?.numberOfItems },
    };
  }
  return out;
}

// =============================================================
// Phase 4: Brand-search + offer-aware product fetch + buy-box
// =============================================================

export interface KeepaTokenStatus {
  tokens_left: number;
  refill_in_ms: number;
  refill_rate: number;
}

export interface KeepaBrandSearchResult {
  asins: string[];
  tokens_used: number;
  tokens_left: number;
}

export interface KeepaOffer {
  seller_id?: string;
  seller_name?: string;
  is_fba: boolean;
  is_amazon: boolean;
  price?: number;
  is_buy_box_winner: boolean;
}

export interface KeepaProductDetails {
  asin: string;
  title?: string;
  brand?: string;
  buy_box_seller?: string;
  buy_box_seller_id?: string;
  buy_box_price?: number;
  buy_box_is_fba?: boolean;
  buy_box_is_amazon?: boolean;
  total_offers_count: number;
  fba_offers_count: number;
  offers: KeepaOffer[];
  last_updated?: string;
  raw?: any;
}

interface CacheEntry { t: number; v: KeepaProductDetails }
const PRODUCT_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let TOKEN_CACHE: { t: number; v: KeepaTokenStatus } | null = null;
const TOKEN_CACHE_TTL_MS = 30 * 1000;

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function normalizeBrandQuery(name: string) {
  return name
    .replace(/[®™©]/g, "")
    .replace(/[^\w\s\-&'.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function keepaFetch(path: string, params: Record<string, string | number>): Promise<{ json: any; status: number }> {
  const key = process.env.KEEPA_API_KEY;
  if (!key) throw new Error("KEEPA_API_KEY missing");
  const qs = new URLSearchParams({ key, domain: String(DOMAIN_ID), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  const url = `${BASE}${path}?${qs.toString()}`;
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      const backoff = Math.min(60_000, 1000 * Math.pow(2, attempt));
      lastErr = `HTTP ${res.status}`;
      await sleep(backoff);
      continue;
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`Keepa ${res.status}: ${(json && JSON.stringify(json).slice(0, 200)) || lastErr}`);
    }
    return { json, status: res.status };
  }
  throw new Error(`Keepa repeated failure: ${lastErr}`);
}

export async function getKeepaTokenStatus(force = false): Promise<KeepaTokenStatus> {
  if (!force && TOKEN_CACHE && Date.now() - TOKEN_CACHE.t < TOKEN_CACHE_TTL_MS) {
    return TOKEN_CACHE.v;
  }
  const key = process.env.KEEPA_API_KEY;
  if (!key) throw new Error("KEEPA_API_KEY missing");
  const res = await fetch(`${BASE}/token?key=${key}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Keepa token HTTP ${res.status}`);
  const data = await res.json();
  const v: KeepaTokenStatus = {
    tokens_left: Number(data?.tokensLeft ?? 0),
    refill_in_ms: Number(data?.refillIn ?? 0),
    refill_rate: Number(data?.refillRate ?? 0),
  };
  TOKEN_CACHE = { t: Date.now(), v };
  return v;
}

async function ensureTokens(min = 20) {
  const s = await getKeepaTokenStatus(true);
  if (s.tokens_left >= min) return s;
  const wait = Math.min(60_000, Math.max(2_000, s.refill_in_ms || 30_000));
  await sleep(wait);
  return getKeepaTokenStatus(true);
}

/**
 * Search Keepa for top ASINs under a brand name.
 * Uses /query?type=product so we can filter by brand.
 */
export async function searchProductsByBrand(brandName: string, maxResults = 20): Promise<KeepaBrandSearchResult> {
  const key = process.env.KEEPA_API_KEY;
  if (!key) throw new Error("KEEPA_API_KEY missing");
  const cleaned = normalizeBrandQuery(brandName);
  if (!cleaned) return { asins: [], tokens_used: 0, tokens_left: 0 };

  await ensureTokens(5);

  // Keepa /query: search products by brand string. Keepa returns asinList ordered by sales rank by default.
  const selection = JSON.stringify({
    brand: [cleaned],
    sort: [["current_SALES", "asc"]],
    perPage: Math.min(100, Math.max(1, maxResults)),
    page: 0,
  });
  const { json } = await keepaFetch("/query", { selection });
  const asinList: string[] = Array.isArray(json?.asinList) ? json.asinList.slice(0, maxResults) : [];
  const tokensLeft = Number(json?.tokensLeft ?? 0);
  const tokensConsumed = Number(json?.tokensConsumed ?? 1);
  TOKEN_CACHE = { t: Date.now(), v: { tokens_left: tokensLeft, refill_in_ms: Number(json?.refillIn ?? 0), refill_rate: Number(json?.refillRate ?? 0) } };
  return { asins: asinList, tokens_used: tokensConsumed, tokens_left: tokensLeft };
}

function extractOffers(p: any): { offers: KeepaOffer[]; buyBoxSellerId?: string } {
  const offers: KeepaOffer[] = [];
  const rawOffers = Array.isArray(p?.offers) ? p.offers : [];
  // Keepa marks the current buy-box offer in stats.buyBoxSellerIdHistory (last entry).
  const bbHistory: any[] = Array.isArray(p?.stats?.buyBoxSellerIdHistory) ? p.stats.buyBoxSellerIdHistory : [];
  const currentBuyBoxSellerId = bbHistory.length ? String(bbHistory[bbHistory.length - 1]) : undefined;
  for (const o of rawOffers) {
    const sellerId = o?.sellerId ? String(o.sellerId) : undefined;
    const isAmazon = sellerId === "ATVPDKIKX0DER" || (o?.isAmazon === true);
    const condition = o?.condition;
    if (condition !== undefined && condition !== 0 && condition !== 1) continue; // new only
    const offerCSV: number[] = Array.isArray(o?.offerCSV) ? o.offerCSV : [];
    const lastPriceCents = offerCSV.length >= 2 ? offerCSV[offerCSV.length - 2] : -1;
    const lastShipCents = offerCSV.length >= 1 ? offerCSV[offerCSV.length - 1] : 0;
    const totalCents = (lastPriceCents > 0 ? lastPriceCents : 0) + (lastShipCents > 0 ? lastShipCents : 0);
    offers.push({
      seller_id: sellerId,
      seller_name: o?.sellerName ?? undefined,
      is_fba: !!o?.isFBA,
      is_amazon: isAmazon,
      price: totalCents > 0 ? totalCents / 100 : undefined,
      is_buy_box_winner: sellerId !== undefined && sellerId === currentBuyBoxSellerId,
    });
  }
  return { offers, buyBoxSellerId: currentBuyBoxSellerId };
}

export function getBuyBoxSeller(productJson: any): { name?: string; sellerId?: string; price?: number; isFBA?: boolean; isAmazon?: boolean } {
  const { offers, buyBoxSellerId } = extractOffers(productJson);
  const winner = offers.find((o) => o.is_buy_box_winner) ?? offers[0];
  if (!winner) return {};
  let name = winner.seller_name;
  // Keepa may not name Amazon directly; resolve from sellerId.
  if (!name && winner.is_amazon) name = "Amazon.com";
  if (!name && winner.seller_id) name = winner.seller_id;
  return {
    name,
    sellerId: winner.seller_id ?? buyBoxSellerId,
    price: winner.price,
    isFBA: winner.is_fba,
    isAmazon: winner.is_amazon || winner.seller_id === "ATVPDKIKX0DER",
  };
}

/**
 * Batch-fetch product details with offer information.
 * Splits into chunks of `batchSize` and respects rate limits.
 * Honors a 24h in-memory cache keyed by ASIN.
 */
export async function getProductDetails(asins: string[], batchSize = 5): Promise<KeepaProductDetails[]> {
  const clean = Array.from(new Set(asins.filter((a) => a && /^[A-Z0-9]{10}$/i.test(a))));
  if (!clean.length) return [];
  const now = Date.now();
  const out: KeepaProductDetails[] = [];
  const need: string[] = [];
  for (const a of clean) {
    const c = PRODUCT_CACHE.get(a);
    if (c && now - c.t < CACHE_TTL_MS) out.push(c.v);
    else need.push(a);
  }

  for (let i = 0; i < need.length; i += batchSize) {
    const chunk = need.slice(i, i + batchSize);
    await ensureTokens(chunk.length * 5 + 2);
    const { json } = await keepaFetch("/product", {
      asin: chunk.join(","),
      offers: 20,
      stats: 30,
      "buybox": 1,
    });
    const products = Array.isArray(json?.products) ? json.products : [];
    const tokensLeft = Number(json?.tokensLeft ?? 0);
    TOKEN_CACHE = { t: Date.now(), v: { tokens_left: tokensLeft, refill_in_ms: Number(json?.refillIn ?? 0), refill_rate: Number(json?.refillRate ?? 0) } };
    for (const p of products) {
      const asin = String(p?.asin ?? "");
      if (!asin) continue;
      const { offers } = extractOffers(p);
      const bb = getBuyBoxSeller(p);
      const stats = p?.stats ?? {};
      const total = Number(stats?.offerCountNew ?? offers.length ?? 0);
      const fba = offers.filter((o) => o.is_fba).length;
      const details: KeepaProductDetails = {
        asin,
        title: p?.title,
        brand: p?.brand,
        buy_box_seller: bb.name,
        buy_box_seller_id: bb.sellerId,
        buy_box_price: bb.price,
        buy_box_is_fba: bb.isFBA,
        buy_box_is_amazon: bb.isAmazon,
        total_offers_count: total,
        fba_offers_count: fba,
        offers,
        last_updated: p?.lastUpdate ? new Date((p.lastUpdate + 21564000) * 60 * 1000).toISOString() : new Date().toISOString(),
        raw: { tokensLeft, lastPriceChange: p?.lastPriceChange },
      };
      PRODUCT_CACHE.set(asin, { t: Date.now(), v: details });
      out.push(details);
    }
  }
  return out;
}

export function clearKeepaProductCache() {
  PRODUCT_CACHE.clear();
}
