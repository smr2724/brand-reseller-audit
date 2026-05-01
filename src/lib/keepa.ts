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
