/**
 * Keepa client — ASIN enrichment.
 * Token-conscious: checks Supabase product cache freshness (last_enriched_at)
 * before calling Keepa.
 */

const BASE = "https://api.keepa.com";

export function isKeepaConfigured() {
  return !!process.env.KEEPA_API_KEY;
}

// Amazon US. Tolerate `KEEPA_DOMAIN_ID` being unset OR set to an empty string
// in Vercel — the latter is what was sending `domain=0` to Keepa and producing
// `invalidParameter` 400s for every brand audit.
const DOMAIN_ID = (() => {
  const raw = process.env.KEEPA_DOMAIN_ID;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
})();

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
  // Listing-health + revenue-estimator fields (from /product stats=365)
  sales_rank_avg365?: number | null;
  sales_rank_current?: number | null;
  buy_box_avg365?: number | null;
  buy_box_current?: number | null;
  category_tree?: { catId: number; name: string }[] | null;
  product_group?: string | null;
  root_category?: number | null;
  images_count?: number | null;
  rating?: number | null;          // 0..5
  review_count?: number | null;
  features_count?: number | null;
  has_video?: boolean | null;
  has_a_plus?: boolean | null;
  /**
   * If this ASIN is a child variation, the parent's ASIN. If it is itself
   * a parent, this is undefined and `variation_asins` lists its children.
   */
  parent_asin?: string | null;
  /** Child ASINs returned by Keepa's `variationCSV` / `variations[]`. */
  variation_asins?: string[];
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
  // Loop until we have enough tokens. We give callers up to
  // 30 minutes of total wait per call so a backfill against a low-tier
  // Keepa account (refillRate 5/min) can grind through ~150 tokens of
  // catchup. Production /generate runs that take this long will exceed
  // upstream timeouts on their own; that's the same failure path as
  // before, just routed through the timeout instead of a hard error.
  const startedAt = Date.now();
  const TOTAL_BUDGET_MS = 1_800_000; // 30 minutes
  let s = await getKeepaTokenStatus(true);
  while (s.tokens_left < min) {
    if (Date.now() - startedAt > TOTAL_BUDGET_MS) return s;
    const wait = Math.min(60_000, Math.max(2_000, s.refill_in_ms || 30_000));
    await sleep(wait);
    s = await getKeepaTokenStatus(true);
  }
  return s;
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
    // Keepa /query requires perPage ≥ 50; we slice down to maxResults below.
    perPage: Math.min(100, Math.max(50, maxResults)),
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
      // 365-day stats power both the buy-box price avg used by the
      // revenue estimator and the listing-health snapshot.
      stats: 365,
      "buybox": 1,
      // aplus=1 / videos=1 are free add-ons (same 5-token cost as the
      // base product call). Without them Keepa omits the `aPlus` and
      // `videos` arrays entirely, so has_a_plus / has_video map to null
      // even on listings that do have A+ content and product video.
      aplus: 1,
      videos: 1,
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

      // Keepa stats CSV indices we use:
      //   3  = SALES_RANK
      //   16 = RATING (× 10, so divide by 10 for display)
      //   17 = COUNT_REVIEWS
      //   18 = BUY_BOX_SHIPPING (price in cents, includes shipping)
      const cur: any[] = Array.isArray(stats?.current) ? stats.current : [];
      const avg365: any[] = Array.isArray(stats?.avg365) ? stats.avg365 : [];
      const salesRankCurrent =
        typeof cur[3] === "number" && cur[3] > 0 ? cur[3] : null;
      const salesRankAvg365 =
        typeof avg365[3] === "number" && avg365[3] > 0 ? avg365[3] : null;
      const bbCurrentCents =
        typeof cur[18] === "number" && cur[18] > 0 ? cur[18] : null;
      const bbAvg365Cents =
        typeof avg365[18] === "number" && avg365[18] > 0 ? avg365[18] : null;
      const ratingRaw = typeof cur[16] === "number" && cur[16] > 0 ? cur[16] : null;
      const reviewsRaw = typeof cur[17] === "number" && cur[17] > 0 ? cur[17] : null;

      // Image count: Keepa returns `imagesCSV` as comma-separated relative
      // paths; sometimes also `images` (already an array of ids), or
      // `imagesCount`. Use whichever shape we get back.
      let imagesCount: number | null = null;
      if (typeof p?.imagesCount === "number") imagesCount = p.imagesCount;
      else if (Array.isArray(p?.images)) imagesCount = p.images.length;
      else if (typeof p?.imagesCSV === "string" && p.imagesCSV.length) {
        imagesCount = p.imagesCSV.split(",").filter(Boolean).length;
      }

      let featuresCount: number | null = null;
      if (Array.isArray(p?.features)) featuresCount = p.features.length;
      else if (typeof p?.featuresCSV === "string" && p.featuresCSV.length) {
        featuresCount = p.featuresCSV.split(",").filter(Boolean).length;
      }

      // Video flag: with videos=1 in the request, Keepa returns `videos`
      // as an array (sometimes also `videoCount` historically). Absent
      // field with the request flag set means "no product video on this
      // listing" — i.e. false, not null/unknown.
      const videosArr = Array.isArray(p?.videos) ? p.videos : null;
      const hasVideoCount =
        typeof p?.videoCount === "number" ? p.videoCount > 0 : null;
      const hasVideo: boolean =
        videosArr !== null
          ? videosArr.length > 0
          : hasVideoCount === true
          ? true
          : false;

      // A+ content: with aplus=1 in the request, Keepa returns `aPlus`
      // as an array of modules (length > 0 means A+ is published).
      // Absent field with the request flag set = no A+, i.e. false.
      const aPlusRaw = (p as any)?.aPlus ?? (p as any)?.aPlusContent;
      let hasAPlus: boolean = false;
      if (typeof aPlusRaw === "boolean") hasAPlus = aPlusRaw;
      else if (typeof aPlusRaw === "number") hasAPlus = aPlusRaw > 0;
      else if (Array.isArray(aPlusRaw)) hasAPlus = aPlusRaw.length > 0;
      else if (aPlusRaw && typeof aPlusRaw === "object")
        hasAPlus = Object.keys(aPlusRaw).length > 0;

      // Variation children. Keepa returns these in two shapes; we prefer
      // the richer `variations[]` (each entry has `.asin` + attribute set)
      // and fall back to the comma-separated `variationCSV` string. The
      // parent ASIN can also point to itself if Keepa flagged it as the
      // parent of a variation family.
      const variationAsins: string[] = (() => {
        const set = new Set<string>();
        const asArr = Array.isArray((p as any)?.variations) ? (p as any).variations : null;
        if (asArr) {
          for (const v of asArr) {
            const a = (v?.asin ?? "").toString().toUpperCase();
            if (/^[A-Z0-9]{10}$/.test(a) && a !== asin) set.add(a);
          }
        }
        const csv = (p as any)?.variationCSV;
        if (typeof csv === "string" && csv.length) {
          for (const tok of csv.split(/[, ]+/)) {
            const a = tok.trim().toUpperCase();
            if (/^[A-Z0-9]{10}$/.test(a) && a !== asin) set.add(a);
          }
        }
        return Array.from(set);
      })();
      const parentAsinRaw = (p as any)?.parentAsin ?? (p as any)?.parentASIN ?? null;
      const parentAsin =
        typeof parentAsinRaw === "string" && /^[A-Z0-9]{10}$/i.test(parentAsinRaw.trim())
          ? parentAsinRaw.trim().toUpperCase()
          : null;

      const categoryTree = Array.isArray(p?.categoryTree)
        ? p.categoryTree
            .map((c: any) =>
              c && typeof c.catId === "number"
                ? { catId: c.catId, name: c?.name ?? "" }
                : null,
            )
            .filter((c: any): c is { catId: number; name: string } => !!c)
        : null;

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
        sales_rank_avg365: salesRankAvg365,
        sales_rank_current: salesRankCurrent,
        buy_box_avg365: bbAvg365Cents != null ? bbAvg365Cents / 100 : null,
        buy_box_current: bbCurrentCents != null ? bbCurrentCents / 100 : null,
        category_tree: categoryTree,
        product_group:
          typeof p?.productGroup === "string" ? p.productGroup : null,
        root_category:
          typeof p?.rootCategory === "number" ? p.rootCategory : null,
        images_count: imagesCount,
        rating: ratingRaw != null ? ratingRaw / 10 : null,
        review_count: reviewsRaw,
        features_count: featuresCount,
        has_video: hasVideo,
        has_a_plus: hasAPlus,
        parent_asin: parentAsin,
        variation_asins: variationAsins,
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

/**
 * Walk Keepa variation links from a set of seed ASINs (typically the
 * brand-search hits, which Keepa returns at the parent level). For each
 * parent we follow `variations[]` / `variationCSV` and collect the
 * child ASINs, then return:
 *
 *   • `seeds`      — the initial input, deduped
 *   • `children`   — newly discovered child ASINs (excluding seeds)
 *   • `combined`   — seeds ∪ children, capped at `maxTotal`
 *
 * We do NOT enrich the children here — the caller decides whether to
 * pass `combined` back through `getProductDetails`. This separation keeps
 * the function cheap (1 token per seed parent we don't yet have cached)
 * and lets callers cap by token budget.
 *
 * Why we need it: the brand search returns parents only, and Beauty/
 * Health brands often have one parent listing per fragrance/scent with
 * 10–20 child SKUs that each carry their own BSR + price. Without this
 * step the revenue estimator only sees the parent's stats — usually 0
 * sales rank — and undercounts by 5–20×.
 */
export interface ExpandVariationsResult {
  seeds: string[];
  children: string[];
  combined: string[];
  hit_cap: boolean;
}

export async function expandVariationAsins(
  seedAsins: string[],
  maxTotal = 200,
): Promise<ExpandVariationsResult> {
  const seeds = Array.from(
    new Set(
      seedAsins
        .map((a) => (a ?? "").toString().toUpperCase())
        .filter((a) => /^[A-Z0-9]{10}$/.test(a)),
    ),
  );
  if (!seeds.length) {
    return { seeds: [], children: [], combined: [], hit_cap: false };
  }
  const parents = await getProductDetails(seeds, 5);
  const seedSet = new Set(seeds);
  const childSet = new Set<string>();
  for (const p of parents) {
    for (const c of p.variation_asins ?? []) {
      if (!seedSet.has(c)) childSet.add(c);
    }
  }
  const combined: string[] = [...seeds];
  const childArr = Array.from(childSet);
  let hit_cap = false;
  for (const c of childArr) {
    if (combined.length >= maxTotal) {
      hit_cap = true;
      break;
    }
    combined.push(c);
  }
  return {
    seeds,
    children: Array.from(childSet),
    combined,
    hit_cap,
  };
}

// =============================================================
// Seller-name resolver (Keepa /seller endpoint)
// =============================================================

const SELLER_NAME_CACHE = new Map<string, { t: number; name: string | null; country: string | null }>();
const SELLER_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SELLER_ID_RE = /^A[A-Z0-9]{12,13}$/;

export function isAmazonSellerId(s: string | null | undefined): boolean {
  return !!s && SELLER_ID_RE.test(s.trim());
}

interface SellerCacheReader {
  read(ids: string[]): Promise<Record<string, { name: string | null; fetched_at: string; payload?: any }>>;
  write(rows: { seller_id: string; seller_name: string | null; payload: any }[]): Promise<void>;
}

/**
 * Pull the ISO country code out of a Keepa /seller payload. Keepa returns
 * `address` as a string array whose final element is the 2-letter country
 * code (e.g. ["3161 STATE ROAD", "UNIT A", "BENSALEM", "PA", "19020", "US"]).
 * Some payloads also expose `countryCode` directly.
 */
export function extractSellerCountry(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.countryCode === "string" && payload.countryCode.trim()) {
    return payload.countryCode.trim().toUpperCase();
  }
  const addr = payload.address;
  if (Array.isArray(addr) && addr.length) {
    const last = addr[addr.length - 1];
    if (typeof last === "string" && /^[A-Z]{2}$/i.test(last.trim())) {
      return last.trim().toUpperCase();
    }
  }
  if (addr && typeof addr === "object" && typeof addr.country === "string") {
    return addr.country.trim().toUpperCase();
  }
  return null;
}

/**
 * Resolve a list of Amazon seller IDs to human-readable names via
 * Keepa's /seller endpoint. Batches up to 100 per request, 1 token per
 * resolved seller. Names are cached in memory for 30 days; pass a
 * `SellerCacheReader` (backed by `keepa_seller_cache`) to share across
 * lambda invocations.
 *
 * Returns a map { sellerId -> name|null }. `null` means Keepa returned
 * no name for that ID (rare — usually means ID is malformed or the
 * seller has been delisted). Caller should fall back to the raw ID.
 */
export interface ResolvedSellerInfo {
  name: string | null;
  country: string | null;
}

export async function resolveSellerNames(
  sellerIds: Iterable<string>,
  cache?: SellerCacheReader,
): Promise<Record<string, string | null>> {
  const full = await resolveSellerInfo(sellerIds, cache);
  const out: Record<string, string | null> = {};
  for (const [id, info] of Object.entries(full)) {
    out[id] = info.name;
  }
  return out;
}

/**
 * Like `resolveSellerNames`, but returns both the seller's display name
 * and its country code (parsed from the Keepa `address` array). Cached
 * for 30 days in memory; if a Supabase-backed cache is supplied, the
 * country falls out of the cached payload too — no extra Keepa calls.
 */
export async function resolveSellerInfo(
  sellerIds: Iterable<string>,
  cache?: SellerCacheReader,
): Promise<Record<string, ResolvedSellerInfo>> {
  const out: Record<string, ResolvedSellerInfo> = {};
  const ids = Array.from(new Set(Array.from(sellerIds).map((s) => (s ?? "").trim()).filter((s) => SELLER_ID_RE.test(s))));
  if (!ids.length) return out;

  const now = Date.now();
  const need: string[] = [];
  for (const id of ids) {
    const c = SELLER_NAME_CACHE.get(id);
    if (c && now - c.t < SELLER_CACHE_TTL_MS) {
      out[id] = { name: c.name, country: c.country };
    } else {
      need.push(id);
    }
  }

  // Optional shared cache (Supabase). Best-effort; ignore errors.
  if (cache && need.length) {
    try {
      const rows = await cache.read(need);
      const stillNeed: string[] = [];
      for (const id of need) {
        const r = rows[id];
        if (r && now - new Date(r.fetched_at).getTime() < SELLER_CACHE_TTL_MS) {
          const country = extractSellerCountry(r.payload);
          SELLER_NAME_CACHE.set(id, { t: now, name: r.name, country });
          out[id] = { name: r.name, country };
        } else {
          stillNeed.push(id);
        }
      }
      need.length = 0;
      need.push(...stillNeed);
    } catch {
      // proceed without cache
    }
  }

  // Hardcoded fast-path for Amazon US — saves 1 token per audit.
  for (let i = need.length - 1; i >= 0; i--) {
    if (need[i] === "ATVPDKIKX0DER") {
      out["ATVPDKIKX0DER"] = { name: "Amazon.com", country: "US" };
      SELLER_NAME_CACHE.set("ATVPDKIKX0DER", { t: now, name: "Amazon.com", country: "US" });
      need.splice(i, 1);
    }
  }

  if (!need.length) return out;

  const key = process.env.KEEPA_API_KEY;
  if (!key) return out;

  const writeRows: { seller_id: string; seller_name: string | null; payload: any }[] = [];

  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    const url = `${BASE}/seller?key=${key}&domain=${DOMAIN_ID}&seller=${chunk.join(",")}`;
    let json: any = null;
    try {
      const res = await fetch(url, {
        cache: "no-store",
        headers: { "Accept-Encoding": "gzip" },
      });
      if (!res.ok) {
        // soft fail — leave these IDs unresolved
        continue;
      }
      json = await res.json().catch(() => null);
    } catch {
      continue;
    }
    if (!json) continue;
    const tokensLeft = Number(json?.tokensLeft ?? 0);
    if (tokensLeft) {
      TOKEN_CACHE = { t: Date.now(), v: { tokens_left: tokensLeft, refill_in_ms: Number(json?.refillIn ?? 0), refill_rate: Number(json?.refillRate ?? 0) } };
    }
    const sellers = json?.sellers ?? {};
    for (const id of chunk) {
      const entry = sellers?.[id];
      const name = (entry?.sellerName ?? null) as string | null;
      const country = extractSellerCountry(entry);
      out[id] = { name, country };
      SELLER_NAME_CACHE.set(id, { t: now, name, country });
      writeRows.push({ seller_id: id, seller_name: name, payload: entry ?? null });
    }
  }

  if (cache && writeRows.length) {
    try {
      await cache.write(writeRows);
    } catch {
      // best-effort
    }
  }

  return out;
}

export function clearKeepaSellerCache() {
  SELLER_NAME_CACHE.clear();
}