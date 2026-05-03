/**
 * Phase 25 — Fuzzy brand search service.
 *
 * Phase 25.2 — Architectural rewrite. The previous implementation called
 * Keepa's strict-equality `/query` with a fan-out of variant strings and
 * then *labelled the candidate with the variant we sent in*. That meant
 * the picker could never surface Amazon's canonical brand string — the
 * candidate name was always one of our generated variants (or, if every
 * variant missed, the user's literal query echoed back through the
 * `inferBrandFromTitle` DFS fallback).
 *
 * The fix: the picker's candidate.name MUST come verbatim from an external
 * API response. We use:
 *   - Keepa `/search?type=product&term=...` — free-text product search that
 *     returns each product with its canonical `brand` field. This is the
 *     only Keepa endpoint that maps a fuzzy term to canonical brand strings.
 *   - DataForSEO Amazon SERP — we trust the explicit `brand` attribute on
 *     each result item only. We deliberately do NOT extract a brand from
 *     the title leading tokens any more, because Amazon search results
 *     typically begin with the user's search term verbatim, which made
 *     the picker echo input back as a "candidate".
 *
 * Variants are still generated, but only as Keepa /query fallbacks for
 * ASIN-count enrichment — never as the candidate label. The candidate's
 * `name` is exclusively whatever the external API returned.
 *
 * Safety net: when every external source genuinely returned zero we
 * synthesize a single "Search Amazon" candidate so the UI is never blank.
 * That row is tagged `source: "fallback"` and the UI renders it with
 * different copy (it links to amazon.com search; it does not get persisted
 * to the brands table directly via auto-create).
 */
import {
  searchProductsByBrand,
  keepaProductSearch,
  isKeepaConfigured,
} from "@/lib/keepa";
import { amazonSerpLive, isDataForSEOConfigured } from "@/lib/dataforseo";
import { normalizeQuery } from "./variants";
import { similarity } from "./similarity";

export type BrandSearchMode = "tight" | "loose";

export type BrandCandidateSource =
  | "keepa"
  | "dataforseo"
  | "both"
  | "fallback";

export interface BrandCandidate {
  /** Canonical brand string as returned by the external API. Never derived
   *  from the user's query or from variant generation. */
  name: string;
  source: BrandCandidateSource;
  asin_count: number | null;
  storefront_url: string | null;
  similarity: number;
  /** Set true for any candidate whose name didn't come from an authoritative
   *  brand index (e.g. DFS title-derived brands when the explicit `brand`
   *  field was empty). UI de-emphasizes these. Phase 25.2 zero such cases —
   *  retained on the type so future low-precision sources can opt in. */
  low_confidence?: boolean;
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
      low_confidence: prev.low_confidence === false || c.low_confidence === false
        ? false
        : prev.low_confidence ?? c.low_confidence,
      matched_variant: prev.matched_variant ?? c.matched_variant,
    };
    map.set(key, merged);
  }
  return Array.from(map.values());
}

/**
 * Hit Keepa's free-text product search and aggregate the canonical `brand`
 * field across all returned products. Each unique brand string becomes a
 * candidate; `asin_count` is the number of products in the response that
 * carry that brand (so the most-represented brand floats to the top when
 * similarity ties).
 */
async function runKeepaProductSearch(
  query: string,
  searchFn: typeof keepaProductSearch,
): Promise<BrandCandidate[]> {
  try {
    const { products } = await searchFn(query, 0);
    if (!products.length) return [];
    const counts = new Map<string, number>();
    for (const p of products) {
      if (!p.brand) continue;
      counts.set(p.brand, (counts.get(p.brand) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([name, count]) => ({
      name,
      source: "keepa" as const,
      asin_count: count,
      storefront_url: storefrontUrlForBrand(name),
      similarity: 0,
      low_confidence: false,
      matched_variant: query,
    }));
  } catch (err) {
    console.warn("[brand-search] keepa /search failed", (err as Error)?.message);
    return [];
  }
}

async function runDataForSeoSearch(
  query: string,
  dfsFn: typeof amazonSerpLive,
): Promise<BrandCandidate[]> {
  try {
    const products = await dfsFn(query, { depth: 20 });
    const byBrand = new Map<string, number>();
    for (const p of products) {
      // Trust ONLY the explicit DFS `brand` attribute. The previous
      // `inferBrandFromTitle` fallback was the bug that made the picker
      // echo the user's query back as a candidate — Amazon search result
      // titles begin with the search term, so leading tokens collapsed to
      // user input. If DFS has no brand for an item, drop it; Keepa's
      // /search will pick up canonical names for the same query.
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
      low_confidence: false,
      matched_variant: query,
    }));
  } catch (err) {
    console.warn("[brand-search] dataforseo failed", (err as Error)?.message);
    return [];
  }
}

/**
 * Always-available safety net: a single candidate that links the user out
 * to Amazon's own brand search for their literal query. When BOTH Keepa
 * `/search` and DFS return zero, the picker still has at least one
 * actionable row — the user can confirm the brand on Amazon and paste an
 * ASIN into the fallback flow.
 *
 * The fallback row is tagged `source: "fallback"` so the UI can render
 * it differently (no "Confirm + Enrich" button — only the Amazon link).
 */
function fallbackCandidate(query: string): BrandCandidate {
  return {
    name: query.trim(),
    source: "fallback",
    asin_count: null,
    storefront_url: storefrontUrlForBrand(query.trim()),
    similarity: 1,
    low_confidence: true,
    matched_variant: query.trim(),
  };
}

/**
 * Optional dependency injection — callers (tests) can swap out the
 * provider functions without monkeypatching modules. Production code
 * passes nothing and gets the live Keepa + DFS implementations.
 */
export interface SearchBrandsDeps {
  /** Free-text Keepa product search (Phase 25.2). The primary canonical
   *  brand source. */
  keepaSearch?: typeof keepaProductSearch;
  /** Strict-equality brand /query — retained for tests / future use. */
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

  const keepaSearchFn = deps.keepaSearch ?? keepaProductSearch;
  const dfsFn = deps.dfs ?? amazonSerpLive;
  const keepaConfigured = (deps.isKeepaConfigured ?? isKeepaConfigured)();
  const dfsConfigured = (deps.isDataForSEOConfigured ?? isDataForSEOConfigured)();

  // Phase 25.2: query goes to Keepa /search verbatim. Variant fan-out is
  // not needed for canonical-name discovery — /search is fuzzy-friendly.
  // We still record the user's query as the only "variant tried" for
  // logging/back-compat with the response shape.
  const variants_tried = [query];

  const keepaTask: Promise<BrandCandidate[]> = keepaConfigured
    ? runKeepaProductSearch(query, keepaSearchFn)
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

  // Safety net only when EVERY external source returned zero. With Keepa
  // `/search` being fuzzy-friendly this should be rare (typo-only inputs
  // or genuinely-non-existent brands).
  if (top.length === 0) {
    console.warn(
      "[brand-search] every external source returned 0 — surfacing fallback row",
      { query, keepaConfigured, dfsConfigured },
    );
    top = [fallbackCandidate(query)];
  }

  const exhausted =
    mode === "loose" || top.every((c) => c.source === "fallback");
  const result: BrandSearchResult = {
    candidates: top,
    exhausted,
    variants_tried,
    duration_ms: Date.now() - started,
  };
  CACHE.set(key, { t: Date.now(), v: result });
  return result;
}

export function clearBrandSearchCache() {
  CACHE.clear();
}

// Exported for unit tests
export { dedupeByBrand, dedupeKey, fallbackCandidate };
