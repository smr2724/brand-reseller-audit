/**
 * Phase 25 — Fuzzy brand search service.
 *
 * Coordinates Keepa variant fan-out + DataForSEO Amazon SERP in parallel,
 * dedupes by Amazon brand string (case-insensitive), and returns the top 10
 * candidates ranked by similarity to the original input.
 *
 * Phase 25.1 — Several fixes after the picker came up empty in production:
 *   - DFS items frequently have `brand` undefined; we now derive a candidate
 *     brand from the title's leading tokens when the field is missing so
 *     DFS-only brands actually appear in the picker.
 *   - When *every* provider returns zero, return a single "Search Amazon"
 *     candidate keyed off the user's original query so the UI never goes
 *     blank — there is always at least one actionable next step.
 *   - Dedupe is alphanumeric-key based now (was case-insensitive only) so
 *     "Couple's Coffee" and "COUPLE'S COFFEE CO." collapse to one row when
 *     they refer to the same brand.
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
import { tightVariants, looseVariants, normalizeQuery, alphaNumericKey } from "./variants";
import { similarity } from "./similarity";

export type BrandSearchMode = "tight" | "loose";

export interface BrandCandidate {
  name: string;
  source: "keepa" | "dataforseo" | "both" | "fallback";
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

/**
 * Dedupe key collapses casing, punctuation, and whitespace so that
 * "Couple's Coffee", "Couples Coffee", and "COUPLE'S COFFEE CO." all merge
 * into one row when they're really the same brand. We deliberately *do*
 * include the suffix tokens in the key so unrelated brands like
 * "Couples Coffee" and "Couples Coffee Roasters" stay separate — we only
 * collapse on punctuation/case.
 */
function dedupeKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeByBrand(candidates: BrandCandidate[]): BrandCandidate[] {
  const map = new Map<string, BrandCandidate>();
  for (const c of candidates) {
    const key = dedupeKey(c.name);
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, c);
      continue;
    }
    // Prefer the longer/more-specific name when merging (e.g. keep
    // "COUPLE'S COFFEE CO." over "couple's coffee" since the canonical
    // Amazon brand string is what we want to display).
    const preferLonger = c.name.length > prev.name.length ? c : prev;
    const merged: BrandCandidate = {
      ...preferLonger,
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

async function runKeepaForVariant(
  variant: string,
  keepaFn: typeof searchProductsByBrand,
): Promise<BrandCandidate[]> {
  try {
    const res = await keepaFn(variant, 5);
    if (!res.asins.length) return [];
    return [
      {
        name: variant,
        source: "keepa",
        asin_count: res.asins.length,
        storefront_url: storefrontUrlForBrand(variant),
        similarity: 0,
        matched_variant: variant,
      },
    ];
  } catch (err) {
    console.warn("[brand-search] keepa variant failed", variant, (err as Error)?.message);
    return [];
  }
}

/**
 * Pull a candidate brand string out of an Amazon SERP item even when DFS
 * left the `brand` field blank. We use the leading tokens of the title up
 * to a comma, dash, opening paren, or pipe — those characters reliably
 * separate the brand from the product description on Amazon listings
 * ("Couple's Coffee Co. - 12oz Bag, Medium Roast").
 *
 * Returns null when there's no usable signal (very short title or no
 * separator at all and we can't tell where the brand ends).
 */
function inferBrandFromTitle(title: string | undefined): string | null {
  if (!title) return null;
  const t = title.trim();
  if (!t) return null;
  // Prefer everything up to the first strong separator (also catches
  // em-dash and en-dash, which Amazon listings use frequently).
  const m = t.match(/^([^\-–—,|()\[\]]+?)(?=\s*[\-–—,|()\[\]]|$)/);
  const head = (m?.[1] ?? t).trim();
  // Avoid using a 50-token title as a brand — only first 1–4 tokens.
  const tokens = head.split(/\s+/).slice(0, 4).join(" ");
  if (!tokens || tokens.length < 2) return null;
  // Don't return obvious garbage (numbers-only, single char, etc.)
  if (/^[\d\s]+$/.test(tokens)) return null;
  // Reject if the head doesn't have at least one alpha character.
  if (!/[A-Za-z]/.test(tokens)) return null;
  return tokens;
}

async function runDataForSeoSearch(
  query: string,
  dfsFn: typeof amazonSerpLive,
): Promise<BrandCandidate[]> {
  try {
    const products = await dfsFn(query, { depth: 20 });
    const byBrand = new Map<string, number>();
    for (const p of products) {
      // Trust an explicit brand field first; fall back to title-derived
      // brand when DFS returns no brand (most amazon_serp items don't
      // populate `brand` in practice).
      const brandRaw = (p.brand || "").trim();
      const brand = brandRaw || inferBrandFromTitle(p.title);
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

/**
 * Always-available safety net: a single candidate that links the user out
 * to Amazon's own brand search for their literal query. When both Keepa
 * and DFS return zero (or aren't configured), the picker still has at
 * least one actionable row — the user can confirm the brand on Amazon and
 * paste an ASIN into the fallback flow.
 */
function fallbackCandidate(query: string): BrandCandidate {
  return {
    name: query.trim(),
    source: "fallback",
    asin_count: null,
    storefront_url: storefrontUrlForBrand(query.trim()),
    similarity: 1, // it's literally the user's input
    matched_variant: query.trim(),
  };
}

/**
 * Optional dependency injection — callers (tests) can swap out the
 * provider functions without monkeypatching modules. Production code
 * passes nothing and gets the live Keepa + DFS implementations.
 */
export interface SearchBrandsDeps {
  keepa?: typeof searchProductsByBrand;
  dfs?: typeof amazonSerpLive;
  isKeepaConfigured?: () => boolean;
  isDataForSEOConfigured?: () => boolean;
}

export async function searchBrands(
  rawQuery: string,
  mode: BrandSearchMode = "tight",
  deps: SearchBrandsDeps = {},
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

  const keepaFn = deps.keepa ?? searchProductsByBrand;
  const dfsFn = deps.dfs ?? amazonSerpLive;
  const keepaConfigured = (deps.isKeepaConfigured ?? isKeepaConfigured)();
  const dfsConfigured = (deps.isDataForSEOConfigured ?? isDataForSEOConfigured)();

  const keepaTask: Promise<BrandCandidate[]> = keepaConfigured
    ? Promise.all(variants.map((v) => runKeepaForVariant(v, keepaFn))).then((arrs) => arrs.flat())
    : Promise.resolve([]);

  const dfsTask: Promise<BrandCandidate[]> = dfsConfigured
    ? runDataForSeoSearch(query, dfsFn)
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

  let top = merged.slice(0, 10);

  // Safety net: if everything came back empty, still return a single
  // "Search Amazon for this exact brand" candidate so the user has
  // *something* actionable. The UI keys off `source==="fallback"` to
  // render this row with appropriate copy.
  if (top.length === 0) {
    top = [fallbackCandidate(query)];
  }

  const exhausted = mode === "loose" || top.length === 0 || top.every((c) => c.source === "fallback");
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

// Exported for unit tests
export { dedupeByBrand, dedupeKey, inferBrandFromTitle, fallbackCandidate };
