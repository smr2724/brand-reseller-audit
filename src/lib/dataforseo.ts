/**
 * DataForSEO client — Amazon keyword data + Amazon SERP/product data.
 *
 * Endpoints used:
 *   - /v3/dataforseo_labs/amazon/related_keywords/live  (Labs uses language_name)
 *   - /v3/dataforseo_labs/amazon/bulk_search_volume/live
 *   - /v3/merchant/amazon/products/task_post + task_get/advanced/{id}
 *
 * Auth: HTTP Basic with login:password (base64-encoded in Authorization header).
 */

const BASE = "https://api.dataforseo.com";

function authHeader() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) return null;
  const token = Buffer.from(`${login}:${password}`).toString("base64");
  return `Basic ${token}`;
}

export function isDataForSEOConfigured() {
  return !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

async function dfs<T = any>(path: string, body?: any, method: "GET" | "POST" = "POST"): Promise<T> {
  const auth = authHeader();
  if (!auth) throw new Error("DataForSEO credentials missing");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Authorization": auth,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DataForSEO ${path} ${res.status}: ${text.slice(0, 400)}`);
  }
  return (await res.json()) as T;
}

export async function testDataForSEO() {
  try {
    const out = await dfs<any>("/v3/appendix/user_data", null, "GET");
    const status = out?.status_code;
    const user = out?.tasks?.[0]?.result?.[0];
    return {
      ok: status === 20000,
      status_code: status,
      status_message: out?.status_message,
      login: user?.login,
      money: user?.money,
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// -----------------------------------------------------------------------------
// Keyword expansion + search volume (DataForSEO Labs Amazon)
// Labs Amazon endpoints require language_name (not language_code).
// -----------------------------------------------------------------------------
export interface DfsKeyword { keyword: string; search_volume: number | null; }

export async function amazonRelatedKeywords(seed: string, opts: { limit?: number; locationCode?: number } = {}): Promise<DfsKeyword[]> {
  const body = [{
    keyword: seed,
    location_code: opts.locationCode ?? 2840, // US
    language_name: "English",
    limit: opts.limit ?? 100,
    depth: 1,
    include_seed_keyword: true,
  }];
  const out = await dfs<any>("/v3/dataforseo_labs/amazon/related_keywords/live", body);
  const items = out?.tasks?.[0]?.result?.[0]?.items ?? [];
  const list: DfsKeyword[] = [];
  for (const it of items) {
    const kd = it?.keyword_data ?? it;
    const kw = kd?.keyword;
    const sv = kd?.keyword_info?.search_volume ?? null;
    if (kw) list.push({ keyword: String(kw), search_volume: typeof sv === "number" ? sv : null });
  }
  return list;
}

/** Fallback: bulk search volume for a given list of keywords. */
export async function amazonBulkSearchVolume(keywords: string[], opts: { locationCode?: number } = {}): Promise<DfsKeyword[]> {
  if (!keywords.length) return [];
  // API limit is 1000 per call; we won't exceed that here.
  const body = [{
    keywords: keywords.slice(0, 1000),
    location_code: opts.locationCode ?? 2840,
    language_name: "English",
  }];
  const out = await dfs<any>("/v3/dataforseo_labs/amazon/bulk_search_volume/live", body);
  const items = out?.tasks?.[0]?.result?.[0]?.items ?? [];
  const list: DfsKeyword[] = [];
  for (const it of items) {
    const kw = it?.keyword;
    const sv = it?.keyword_info?.search_volume ?? it?.search_volume ?? null;
    if (kw) list.push({ keyword: String(kw), search_volume: typeof sv === "number" ? sv : null });
  }
  return list;
}

// -----------------------------------------------------------------------------
// Amazon SERP / Product listing (Merchant Amazon Products)
// No live endpoint — must use task_post then poll task_get/advanced/{id}.
// -----------------------------------------------------------------------------
export interface DfsProduct {
  asin?: string;
  title?: string;
  brand?: string;
  price?: number;
  rating?: number;
  review_count?: number;
  image_url?: string;
  product_url?: string;
  position?: number;
  is_sponsored?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function amazonSerpLive(keyword: string, opts: { depth?: number; locationCode?: number } = {}): Promise<DfsProduct[]> {
  const body = [{
    keyword,
    location_code: opts.locationCode ?? 2840,
    language_code: "en_US", // Merchant Amazon uses language_code
    depth: opts.depth ?? 40,
    se_domain: "amazon.com",
    priority: 2, // high priority for faster turnaround
  }];

  // 1. Post the task
  const post = await dfs<any>("/v3/merchant/amazon/products/task_post", body);
  const task = post?.tasks?.[0];
  const taskStatus = task?.status_code;
  const taskId = task?.id;
  if (!taskId || (taskStatus !== 20100 && taskStatus !== 20000)) {
    throw new Error(`DataForSEO task_post failed: ${taskStatus} ${task?.status_message ?? "no id"}`);
  }

  // 2. Poll for completion (max ~60s)
  const maxAttempts = 30;
  const intervalMs = 2000;
  let result: any = null;
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(i === 0 ? 4000 : intervalMs);
    try {
      const get = await dfs<any>(`/v3/merchant/amazon/products/task_get/advanced/${taskId}`, null, "GET");
      const t = get?.tasks?.[0];
      const sc = t?.status_code;
      // 20000 ok, 40602 task in queue, 40601 task handed
      if (sc === 20000 && t?.result) {
        result = t.result;
        break;
      }
      // Not ready yet, keep polling
    } catch (e: any) {
      // 404 while task still queued — keep going
      if (!String(e?.message ?? "").includes("404")) {
        // Other error — give up
        throw e;
      }
    }
  }

  if (!result) {
    throw new Error(`DataForSEO task ${taskId} did not complete within timeout`);
  }

  const items = result?.[0]?.items ?? [];
  const products: DfsProduct[] = [];
  for (const it of items) {
    const type = it?.type;
    // Real organic + sponsored Amazon SERP entries
    if (type !== "amazon_serp" && type !== "amazon_paid" && type !== "amazon_product") continue;
    const price = (typeof it?.price?.current === "number" ? it.price.current : null)
      ?? (typeof it?.price_from === "number" ? it.price_from : null)
      ?? (typeof it?.price === "number" ? it.price : null);
    const asin = it?.data_asin ?? it?.asin ?? null;
    const imageUrl = it?.image_url ?? null;
    const url = it?.url ?? (asin ? `https://www.amazon.com/dp/${asin}` : null);
    const ratingValue = typeof it?.rating?.value === "number"
      ? it.rating.value
      : (typeof it?.rating?.rating === "number" ? it.rating.rating : undefined);
    products.push({
      asin: asin ?? undefined,
      title: it?.title ?? undefined,
      brand: it?.brand ?? undefined,
      price: typeof price === "number" ? price : undefined,
      rating: ratingValue,
      review_count: typeof it?.rating?.votes_count === "number" ? it.rating.votes_count : undefined,
      image_url: imageUrl ?? undefined,
      product_url: url ?? undefined,
      position: typeof it?.rank_absolute === "number" ? it.rank_absolute : undefined,
      is_sponsored: type === "amazon_paid" || !!it?.is_paid,
    });
  }
  // Dedupe by ASIN preserving first (best) position
  const seen = new Set<string>();
  const deduped: DfsProduct[] = [];
  for (const p of products) {
    const k = p.asin ?? `${p.title}|${p.position}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(p);
  }
  return deduped;
}

// -----------------------------------------------------------------------------
// Google SERP (live) — used for supplier discovery on the open web.
// -----------------------------------------------------------------------------
export interface GoogleSerpItem {
  title?: string;
  url?: string;
  domain?: string;
  description?: string;
  rank_absolute?: number;
  type?: string;
}

export async function googleSerpLive(query: string, opts: { depth?: number; locationCode?: number } = {}): Promise<GoogleSerpItem[]> {
  const body = [{
    keyword: query,
    location_code: opts.locationCode ?? 2840, // US
    language_code: "en",
    depth: opts.depth ?? 40,
    device: "desktop",
  }];
  const out = await dfs<any>("/v3/serp/google/organic/live/advanced", body);
  const items = out?.tasks?.[0]?.result?.[0]?.items ?? [];
  const results: GoogleSerpItem[] = [];
  for (const it of items) {
    if (it?.type !== "organic") continue;
    const url: string | undefined = it?.url ?? undefined;
    let domain = it?.domain ?? undefined;
    if (!domain && url) {
      try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch {}
    }
    results.push({
      title: it?.title ?? undefined,
      url,
      domain,
      description: it?.description ?? it?.snippet ?? undefined,
      rank_absolute: typeof it?.rank_absolute === "number" ? it.rank_absolute : undefined,
      type: it?.type,
    });
  }
  return results;
}
