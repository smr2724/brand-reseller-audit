/**
 * Keepa client — ASIN enrichment.
 * Token-conscious: checks Supabase product cache freshness (last_enriched_at)
 * before calling Keepa.
 */
import { fetchWithTimeout } from "@/lib/util/timing";

const BASE = "https://api.keepa.com";

// Phase 22 — Per-request HTTP deadline. A single hung Keepa response was
// silently consuming the entire 300s function budget; cap each call at 30s.
const KEEPA_HTTP_TIMEOUT_MS = 30_000;

// Phase 79 — The /product bulk-enrich call (5 ASINs × offers=20 × stats=365)
// regularly takes 30–60s under load and was throwing fetchWithTimeout errors
// inside the bulk worker (run 6a308a72: Q Power, keepa_enrich step). Bump the
// product-call ceiling to 90s and add one retry on timeout (the search/query
// timeouts stay at 30s — those endpoints aren't the slow one).
const KEEPA_PRODUCT_HTTP_TIMEOUT_MS = 90_000;
const KEEPA_PRODUCT_RETRY_DELAY_MS = 2_000;

// Phase 79 — Module-level counter incremented every time the /product call
// retries after a fetchWithTimeout abort. The bulk worker drains this with
// consumeKeepaProductRetryCount() right after enrichment so it can bump
// bulk_run_brands.retry_count. Keeping it module-local avoids threading a
// retry signal through getProductDetails → expandVariationAsins → enrichBrandWithKeepa.
let KEEPA_PRODUCT_RETRY_COUNTER = 0;

function isFetchTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return msg.startsWith("fetchWithTimeout timed out");
}

/**
 * Atomically read and reset the /product retry counter. Returns the number
 * of retries that fired since the last call. Safe to call from anywhere —
 * meant for the bulk worker to plumb into `bulk_run_brands.retry_count`.
 */
export function consumeKeepaProductRetryCount(): number {
  const n = KEEPA_PRODUCT_RETRY_COUNTER;
  KEEPA_PRODUCT_RETRY_COUNTER = 0;
  return n;
}

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
    const res = await fetchWithTimeout(`${BASE}/token?key=${key}`, {
      cache: "no-store",
      timeoutMs: KEEPA_HTTP_TIMEOUT_MS,
      label: "keepa/token",
    });
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
  const res = await fetchWithTimeout(url, {
    cache: "no-store",
    timeoutMs: KEEPA_HTTP_TIMEOUT_MS,
    label: "keepa/product(legacy)",
  });
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
  /**
   * Phase 32 — count of distinct Buy Box winner changes in the last 90
   * days. Derived from `csv[32]` (Buy Box seller-id history) when
   * available, falling back to `csv[18]` (Buy Box shipping-price
   * history). `null` when neither series is present (most often: a
   * listing with no recent offers / no winner). A sharper signal than
   * review velocity for "what actually sold recently" — a dormant
   * pallet has zero changes while an active 4-pack flips frequently.
   */
  buy_box_change_count_90d?: number | null;
  /**
   * Phase 34 — Amazon's "X+ bought in past month" floor as published
   * by Keepa via `monthlySold`. Treated as a tiered floor (50, 100,
   * 200, 500, 1000, 2000, 5000+). 0 / null / undefined / missing all
   * map to null (Amazon hides the badge below 50). When present, used
   * in preference to the BSR-curve estimate.
   */
  monthly_sold?: number | null;
  raw?: any;
}

interface CacheEntry { t: number; v: KeepaProductDetails }
const PRODUCT_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let TOKEN_CACHE: { t: number; v: KeepaTokenStatus } | null = null;
const TOKEN_CACHE_TTL_MS = 30 * 1000;

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Phase 37 — Defensive Keepa-minute → ISO string. Keepa stores timestamps
 * as `unix-minutes - 21564000`, so naive `new Date((m + 21564000) * 60_000)
 * .toISOString()` throws `RangeError: Invalid time value` (the V8 message
 * varies by version, sometimes surfacing as the platform "did not match
 * the expected pattern" text) on out-of-range / non-numeric values. We
 * return null on any failure so the caller can fall back cleanly.
 */
function safeKeepaMinuteToIso(minute: unknown): string | null {
  if (typeof minute !== "number" || !Number.isFinite(minute)) return null;
  try {
    const ms = (minute + 21564000) * 60 * 1000;
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    const t = d.getTime();
    if (!Number.isFinite(t)) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function normalizeBrandQuery(name: string) {
  return name
    .replace(/[®™©]/g, "")
    .replace(/[^\w\s\-&'.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface KeepaFetchOptions {
  /** Per-call HTTP timeout override. Defaults to KEEPA_HTTP_TIMEOUT_MS (30s). */
  timeoutMs?: number;
  /**
   * Phase 79 — retry the request once on fetchWithTimeout abort. Used by
   * the /product call where a 5-ASIN bulk enrich can legitimately exceed
   * 30s under load. Increments KEEPA_PRODUCT_RETRY_COUNTER on every retry
   * fire so the bulk worker can surface it on bulk_run_brands.retry_count.
   */
  retryOnTimeout?: boolean;
}

async function keepaFetch(
  path: string,
  params: Record<string, string | number>,
  options: KeepaFetchOptions = {},
): Promise<{ json: any; status: number }> {
  const key = process.env.KEEPA_API_KEY;
  if (!key) throw new Error("KEEPA_API_KEY missing");
  const qs = new URLSearchParams({ key, domain: String(DOMAIN_ID), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  const url = `${BASE}${path}?${qs.toString()}`;
  const timeoutMs = options.timeoutMs ?? KEEPA_HTTP_TIMEOUT_MS;
  let lastErr = "";
  let timeoutRetried = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, {
        cache: "no-store",
        timeoutMs,
        label: `keepa${path}`,
      });
    } catch (err) {
      // Phase 79 — fetchWithTimeout aborts surface as a thrown Error whose
      // message starts with "fetchWithTimeout timed out". When the caller
      // opts in to retryOnTimeout, swallow the first abort, wait briefly
      // (let Keepa breathe), and retry once. A second timeout rethrows so
      // the bulk worker still catches it and marks the brand `error`.
      if (options.retryOnTimeout && !timeoutRetried && isFetchTimeoutError(err)) {
        timeoutRetried = true;
        KEEPA_PRODUCT_RETRY_COUNTER += 1;
        console.warn(
          `[phase79] keepa${path} timed out after ${timeoutMs}ms — retrying once after ${KEEPA_PRODUCT_RETRY_DELAY_MS}ms`,
        );
        await sleep(KEEPA_PRODUCT_RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      // Phase 22 — was up to 60s of backoff between retries; that alone
      // could blow the budget. Cap at 5s and only retry once on 5xx/429.
      const backoff = Math.min(5_000, 1000 * (attempt + 1));
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
  const res = await fetchWithTimeout(`${BASE}/token?key=${key}`, {
    cache: "no-store",
    timeoutMs: KEEPA_HTTP_TIMEOUT_MS,
    label: "keepa/token",
  });
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
  // Phase 22 — Cap the wait budget at 30s. The previous 30-minute budget
  // was meant to support batch backfills, but a Vercel function audit
  // can't afford anywhere near that — a low-token Keepa account would
  // silently consume the entire 300s function budget in token waits and
  // never start the actual /product fetch. With the new cap, we either
  // proceed with whatever tokens are available or surface the throttle
  // upstream where it can be handled (and the audit-generation budget
  // can go to LLM/PDF work instead).
  const startedAt = Date.now();
  const TOTAL_BUDGET_MS = 30_000;
  let s = await getKeepaTokenStatus(true);
  while (s.tokens_left < min) {
    if (Date.now() - startedAt > TOTAL_BUDGET_MS) return s;
    const wait = Math.min(10_000, Math.max(2_000, s.refill_in_ms || 5_000));
    await sleep(wait);
    s = await getKeepaTokenStatus(true);
  }
  return s;
}

/**
 * Free-text product search on Keepa's `/search?type=product` endpoint.
 * Returns lightweight product objects (each with the canonical `brand`
 * string and `asin`) — the *only* Keepa endpoint that maps a fuzzy user
 * term to Amazon-canonical brand names. `/query` requires a strict-equality
 * brand filter (so it can never *discover* canonical names from a fuzzy
 * input — it can only confirm a guess). Phase 25.2 picker is built on this.
 *
 * The response shape from Keepa is `{ products: [...], totalProducts, ... }`.
 * We don't care about price/history here; just `brand` and `asin`. Each
 * call costs ~5 tokens regardless of `pageCount` because Keepa returns
 * full product objects unless `asins-only=1`.
 */
export interface KeepaSearchHit {
  asin: string;
  brand: string | null;
  title: string | null;
}

export async function keepaProductSearch(
  term: string,
  page = 0,
): Promise<{ products: KeepaSearchHit[]; tokens_left: number }> {
  const key = process.env.KEEPA_API_KEY;
  if (!key) throw new Error("KEEPA_API_KEY missing");
  const cleaned = normalizeBrandQuery(term);
  if (!cleaned || cleaned.length < 3) return { products: [], tokens_left: 0 };
  await ensureTokens(5);
  // Keepa `/search?type=product`: free-text product search. `term` accepts
  // multiple space-separated keywords (all must match). Page 0 returns up
  // to ~40 products. We keep `history=0` to keep the response small.
  const { json } = await keepaFetch("/search", {
    type: "product",
    term: cleaned,
    page,
    history: 0,
  });
  const products: KeepaSearchHit[] = Array.isArray(json?.products)
    ? json.products.map((p: any) => ({
        asin: typeof p?.asin === "string" ? p.asin : "",
        brand: typeof p?.brand === "string" && p.brand.trim() ? p.brand.trim() : null,
        title: typeof p?.title === "string" ? p.title : null,
      })).filter((p: KeepaSearchHit) => /^[A-Z0-9]{10}$/.test(p.asin))
    : [];
  const tokensLeft = Number(json?.tokensLeft ?? 0);
  TOKEN_CACHE = { t: Date.now(), v: { tokens_left: tokensLeft, refill_in_ms: Number(json?.refillIn ?? 0), refill_rate: Number(json?.refillRate ?? 0) } };
  return { products, tokens_left: tokensLeft };
}

/**
 * Phase 33 — hard ceiling on `/query` page iterations per brand. 5 pages
 * × perPage 100 = 500 ASINs. Override via env for one-off heavy brands;
 * the default keeps a single brand from draining Keepa's ~3,900-token
 * bucket on its own (Yeti's 8,486 ASINs would otherwise eat the lot).
 */
export const KEEPA_MAX_PAGES_PER_BRAND = (() => {
  const raw = Number(process.env.KEEPA_MAX_PAGES_PER_BRAND ?? "5");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
})();

/**
 * Phase 33.1 — exclude dead inventory at fetch time. ASINs with sales
 * rank worse than this threshold contribute essentially zero TTM revenue
 * and waste Keepa tokens. Override via env for one-off audits where the
 * tail matters.
 */
export const KEEPA_BRAND_SEARCH_RANK_CEILING = (() => {
  const raw = Number(process.env.KEEPA_BRAND_SEARCH_RANK_CEILING ?? "500000");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500_000;
})();

/**
 * Search Keepa for top ASINs under a brand name.
 * Uses /query?type=product so we can filter by brand.
 *
 * Phase 33 — paginates internally. Phase 11 only fetched page 0 (max 50–100
 * ASINs), silently dropping the long tail of large catalogs (Terra Pure
 * 663 → 44, Yeti 8,486 → 20). Now iterates up to
 * KEEPA_MAX_PAGES_PER_BRAND pages of 100 ASINs each, breaking when Keepa
 * is exhausted, the caller's `maxResults` is reached, or the Phase 30
 * token-budget floor would be crossed mid-fetch.
 */
export async function searchProductsByBrand(brandName: string, maxResults = 20): Promise<KeepaBrandSearchResult> {
  const key = process.env.KEEPA_API_KEY;
  if (!key) throw new Error("KEEPA_API_KEY missing");
  const cleaned = normalizeBrandQuery(brandName);
  if (!cleaned) return { asins: [], tokens_used: 0, tokens_left: 0 };

  await ensureTokens(5);

  // Phase 33 — Lazy import to keep the module-level dependency graph the
  // same; recover-stuck-brands also imports keepa, so an eager top-level
  // import would be circular.
  const { TOKEN_BUDGET_FLOOR } = await import("@/lib/brand/recover-stuck-brands");

  // Phase 66 — outer-page hard cap independent of perPage configuration.
  // Even if a future env override pushed KEEPA_MAX_PAGES_PER_BRAND
  // arbitrarily high, this 50-page ceiling guarantees the loop terminates
  // in finite time. With perPage=100 that's 5,000 ASINs — well past the
  // economically-meaningful tail for any reseller-audit brand.
  const PHASE66_MAX_PAGES_SAFETY = 50;
  const pageCeiling = Math.min(KEEPA_MAX_PAGES_PER_BRAND, PHASE66_MAX_PAGES_SAFETY);

  // Phase 66 — wall-clock cap on the full pagination loop. Without this
  // a single brand with slow Keepa responses could chain three 30-second
  // attempts × five pages × retries and consume the entire function
  // budget before product fetch even starts. 90s leaves room for a slow
  // first call while keeping the orchestrator's overall budget intact.
  const PHASE66_PAGINATION_WALL_CLOCK_MS = 90_000;
  const paginationStartedAt = Date.now();

  const perPage = 100;
  const accumulated: string[] = [];
  let tokensConsumed = 0;
  let tokensLeft = 0;
  let totalProducts: number | null = null;
  let pagesFetched = 0;

  for (let page = 0; page < pageCeiling; page++) {
    if (Date.now() - paginationStartedAt > PHASE66_PAGINATION_WALL_CLOCK_MS) {
      console.warn(
        `[phase66] pagination wall-clock (${PHASE66_PAGINATION_WALL_CLOCK_MS}ms) hit for "${cleaned}" at page=${page}, accumulated=${accumulated.length}; breaking loop`,
      );
      break;
    }

    if (page > 0) {
      // Preserve the Phase 30 invariant during long fetches: bail before
      // burning more tokens if the bucket has slipped under the floor.
      const status = await getKeepaTokenStatus(false);
      if (status.tokens_left < TOKEN_BUDGET_FLOOR) {
        console.log(
          `[phase33] token budget floor reached mid-fetch for "${cleaned}" — tokens_left=${status.tokens_left}, page=${page}, accumulated=${accumulated.length}`,
        );
        break;
      }
    }

    const selection = JSON.stringify({
      brand: [cleaned],
      sort: [["current_SALES", "asc"]],
      current_SALES_lte: KEEPA_BRAND_SEARCH_RANK_CEILING,
      availabilityAmazon_gte: 0,
      perPage,
      page,
    });
    const { json } = await keepaFetch("/query", { selection });
    pagesFetched += 1;

    tokensLeft = Number(json?.tokensLeft ?? tokensLeft);
    tokensConsumed += Number(json?.tokensConsumed ?? 1);
    TOKEN_CACHE = {
      t: Date.now(),
      v: {
        tokens_left: tokensLeft,
        refill_in_ms: Number(json?.refillIn ?? 0),
        refill_rate: Number(json?.refillRate ?? 0),
      },
    };

    const pageAsins: string[] = Array.isArray(json?.asinList) ? json.asinList : [];
    if (totalProducts === null && Number.isFinite(json?.totalProducts)) {
      totalProducts = Number(json.totalProducts);
    }
    accumulated.push(...pageAsins);

    // Phase 66 — per-page structured progress log. Greppable in Vercel
    // logs via `event:"keepa_brand_search_page"` so any future hang can
    // be pinpointed down to which page stalled. Includes elapsed time
    // so a slow Keepa response is visible even when the function has
    // not yet timed out.
    console.log(
      JSON.stringify({
        event: "keepa_brand_search_page",
        brand: cleaned,
        page,
        page_size: pageAsins.length,
        accumulated: accumulated.length,
        total_products: totalProducts,
        tokens_used: tokensConsumed,
        tokens_left: tokensLeft,
        elapsed_ms: Date.now() - paginationStartedAt,
      }),
    );

    if (pageAsins.length < perPage) break; // Keepa exhausted
    if (totalProducts !== null && accumulated.length >= totalProducts) break;
    if (accumulated.length >= maxResults) break;
    // Phase 66 — hard ASIN cap on the accumulator. Belt-and-suspenders
    // against a maxResults arg that accidentally allows runaway growth.
    if (accumulated.length >= 5000) {
      console.warn(
        `[phase66] brand_search hard ASIN cap (5000) reached for "${cleaned}" at page=${page}`,
      );
      break;
    }
  }

  console.log(
    `[phase33] keepa brand search "${cleaned}" — pages_fetched=${pagesFetched}, accumulated=${accumulated.length}, keepa_total_products=${totalProducts ?? "unknown"}, maxResults=${maxResults}, rank_ceiling=${KEEPA_BRAND_SEARCH_RANK_CEILING}, tokens_used=${tokensConsumed}, tokens_left=${tokensLeft}`,
  );

  return {
    asins: accumulated.slice(0, maxResults),
    tokens_used: tokensConsumed,
    tokens_left: tokensLeft,
  };
}

/**
 * Phase 32 — count distinct Buy Box winner changes in the last 90 days.
 *
 * Keepa CSV time-series are `[keepaMinute, value, keepaMinute, value, ...]`
 * (Keepa minutes since epoch + offset 21564000). We prefer csv[32]
 * (Buy Box seller-id history): each entry is the winning seller ID at
 * that minute. A "change" is any sample whose seller-id differs from
 * the previous sample's seller-id within the 90-day window. When csv[32]
 * is absent, we fall back to csv[18] (Buy Box shipping-price history)
 * and count distinct price values — noisier (price oscillates without
 * a winner change) but still correlates with active offer churn. When
 * neither series exists or is empty, we return null so the attribution
 * layer can fall back to review-only weighting.
 *
 * We avoid bumping `offers` from 20 → 30: the csv-based history is
 * what we actually need (the live offer snapshot is unrelated), and 20
 * already covers >90% of small/mid brand listings.
 */
function buyBoxChangeCount90d_(p: any): number | null {
  const csv: any[] = Array.isArray(p?.csv) ? p.csv : [];
  // Keepa minute = unix-minutes - 21564000. 90 days = 129600 unix-minutes.
  const nowKeepa = Math.floor(Date.now() / 60_000) - 21564000;
  const cutoff = nowKeepa - 90 * 24 * 60;

  function countDistinctTransitions(series: any): number | null {
    if (!Array.isArray(series) || series.length < 4) return null;
    let prev: string | number | null = null;
    let count = 0;
    let saw = false;
    for (let i = 0; i + 1 < series.length; i += 2) {
      const t = series[i];
      const v = series[i + 1];
      if (typeof t !== "number") continue;
      if (t < cutoff) {
        // Track the most recent pre-window value so the first in-window
        // sample only counts as a change if it differs from it.
        if (v !== -1) prev = v;
        continue;
      }
      if (v === -1) {
        // -1 = no winner. Treat as its own state so a listing flipping
        // in/out of "no offers" still registers churn.
        if (prev !== "__none__") {
          if (saw) count += 1;
          prev = "__none__";
        }
        saw = true;
        continue;
      }
      if (prev !== v) {
        if (saw) count += 1;
        prev = v;
      }
      saw = true;
    }
    return saw ? count : null;
  }

  // csv[32] = Buy Box seller-id history (preferred). csv[18] = Buy Box
  // shipping-price history (fallback).
  const sellerSeries = csv[32];
  const sellerCount = countDistinctTransitions(sellerSeries);
  if (sellerCount !== null) return sellerCount;
  const priceSeries = csv[18];
  return countDistinctTransitions(priceSeries);
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

  const productFetchStartedAt = Date.now();
  for (let i = 0; i < need.length; i += batchSize) {
    const chunk = need.slice(i, i + batchSize);
    const chunkStartedAt = Date.now();
    await ensureTokens(chunk.length * 5 + 2);
    const { json } = await keepaFetch(
      "/product",
      {
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
      },
      {
        // Phase 79 — first bulk run had Q Power error in keepa_enrich at
        // the default 30s ceiling on this exact call. 90s covers the
        // observed tail and one retry handles transient Keepa slowness.
        timeoutMs: KEEPA_PRODUCT_HTTP_TIMEOUT_MS,
        retryOnTimeout: true,
      },
    );
    // Phase 66 — per-chunk progress log so a stuck /product batch is
    // visible in real time instead of being a silent gap in the run
    // timeline. Greppable via `event:"keepa_product_chunk"`.
    console.log(
      JSON.stringify({
        event: "keepa_product_chunk",
        chunk_index: Math.floor(i / batchSize),
        chunk_size: chunk.length,
        cumulative_fetched: i + chunk.length,
        total_to_fetch: need.length,
        chunk_elapsed_ms: Date.now() - chunkStartedAt,
        total_elapsed_ms: Date.now() - productFetchStartedAt,
        tokens_left: Number(json?.tokensLeft ?? 0),
      }),
    );
    const products = Array.isArray(json?.products) ? json.products : [];
    const tokensLeft = Number(json?.tokensLeft ?? 0);
    TOKEN_CACHE = { t: Date.now(), v: { tokens_left: tokensLeft, refill_in_ms: Number(json?.refillIn ?? 0), refill_rate: Number(json?.refillRate ?? 0) } };
    for (const p of products) {
      const asin = String(p?.asin ?? "");
      if (!asin) continue;
      try {
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

      // Phase 32 — Buy Box win frequency over the last 90 days. Sharper
      // attribution signal than review velocity for variation siblings:
      // dormant pallet listings register 0 changes, active 4-packs many.
      const buyBoxChangeCount90d = buyBoxChangeCount90d_(p);

      // Phase 34 — Amazon-published "X+ bought in past month" badge.
      // Tiered floor (50/100/200/500/1000/2000/5000+); 0 means Amazon
      // hides the badge so we treat it as null.
      const monthlySoldRaw = (p as any)?.monthlySold;
      const monthlySold: number | null =
        typeof monthlySoldRaw === "number" &&
        Number.isFinite(monthlySoldRaw) &&
        monthlySoldRaw > 0
          ? Math.trunc(monthlySoldRaw)
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
        last_updated: safeKeepaMinuteToIso(p?.lastUpdate) ?? new Date().toISOString(),
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
        buy_box_change_count_90d: buyBoxChangeCount90d,
        monthly_sold: monthlySold,
        raw: { tokensLeft, lastPriceChange: p?.lastPriceChange },
      };
      PRODUCT_CACHE.set(asin, { t: Date.now(), v: details });
      out.push(details);
      } catch (err: any) {
        // Phase 37 — defensive boundary around per-product Keepa parsing.
        // Historically a single malformed field (e.g. an unparseable
        // `lastUpdate` minute fed to `new Date(...).toISOString()`, or
        // a percentage formatter that mishandled the raw float Keepa
        // returned for top-seller share) would throw mid-loop and abort
        // the whole brand enrichment. The "string did not match the
        // expected pattern" SyntaxError variant is the platform's
        // canonical message for that family of throws. We log a
        // structured `keepa_parser_warning` line (greppable in Vercel
        // logs to pinpoint which Keepa field is unparseable) and skip
        // this product so the rest of the batch still lands.
        const message = err instanceof Error ? err.message : String(err);
        const errName = err instanceof Error ? err.name : "Error";
        console.error(
          JSON.stringify({
            event: "keepa_parser_warning",
            asin,
            field_name: "product_record",
            error_name: errName,
            error_message: message,
            // Compact peek at the inputs that most commonly trip parsers
            // (URL constructors, percentage formatters, date parsers).
            raw_value: {
              title_len: typeof p?.title === "string" ? p.title.length : null,
              monthly_sold_type: typeof (p as any)?.monthlySold,
              last_update_type: typeof (p as any)?.lastUpdate,
              variations_count: Array.isArray((p as any)?.variations)
                ? (p as any).variations.length
                : null,
              variation_csv_type: typeof (p as any)?.variationCSV,
            },
          }),
        );
      }
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
      const res = await fetchWithTimeout(url, {
        cache: "no-store",
        headers: { "Accept-Encoding": "gzip" },
        timeoutMs: KEEPA_HTTP_TIMEOUT_MS,
        label: "keepa/seller",
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