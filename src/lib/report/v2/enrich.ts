/**
 * Phase 8 — Mandatory pre-generation enrichment for v2 audit reports.
 *
 * Unlike v1, where the generator silently fell through to a half-empty
 * narrative if Keepa or DataForSEO had no data, v2 *requires* both
 * sources before rendering. If either step fails, the orchestrator
 * surfaces a specific error so the report row goes to status='failed'
 * with a useful error_message.
 *
 * We piggy-back on the existing per-source helpers
 * (`enrichBrandWithKeepa`, `enrichBrandWithDataForSeo`) and the public
 * bundle helper. Cache windows: 14 days.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getBrandEnrichmentBundle,
  type BrandEnrichmentBundle,
} from "@/lib/enrichment";
import { enrichBrandWithKeepa } from "@/lib/enrichment/keepa-brand";
import { enrichBrandWithDataForSeo } from "@/lib/enrichment/dataforseo";
import { fetchBrandKeywords, fetchBrandSerp } from "@/lib/enrichment/dataforseo";
import {
  estimateBrandTtmRevenue,
  type RevenueEstimate,
} from "@/lib/enrichment/revenue-estimator";
import {
  pullTrailing12FromSpApi,
  type SpApiTrailingResult,
} from "@/lib/enrichment/sp-api-override";
import {
  getProductDetails,
  isKeepaConfigured,
  searchProductsByBrand,
  type KeepaProductDetails,
} from "@/lib/keepa";
import { isBrandControlled } from "@/lib/enrichment/keepa-brand";

const FRESH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export class EnrichmentStepError extends Error {
  step: string;
  constructor(step: string, message: string) {
    super(`[${step}] ${message}`);
    this.step = step;
    this.name = "EnrichmentStepError";
  }
}

export interface BrandRowMin {
  id: string;
  name: string;
  user_id: string;
  category: string | null;
  keepa_last_enriched_at: string | null;
  dataforseo_last_enriched_at: string | null;
}

export interface CompetitorSnapshot {
  brand: string;
  unique_seller_count: number | null;
  brand_controlled_pct: number | null;
  branded_search_volume: number | null;
  organic_serp_rank: number | null;
  /** Listing-health score (0-100) computed from the same CX rubric we
   * apply to the audited brand: rating + reviews + images + bullets +
   * A+ + video, averaged across the competitor's enriched ASINs. */
  listing_health: number | null;
  /** Number of ASINs Keepa returned for the competitor brand search +
   * for which we successfully pulled /product details. Used by
   * `runV2Enrichment` to drop competitors with insufficient signal so
   * we don't ship a row of nulls in the benchmark table. */
  enriched_asin_count: number;
}

export interface KeepaAsinDetail {
  asin: string;
  title: string | null;
  rating: number | null;
  review_count: number | null;
  images_count: number | null;
  features_count: number | null;
  has_video: boolean | null;
  has_a_plus: boolean | null;
  buy_box_avg365: number | null;
  sales_rank_avg365: number | null;
  product_group: string | null;
  category_tree: { catId: number; name: string }[] | null;
  root_category: number | null;
}

export interface EnrichResult {
  bundle: BrandEnrichmentBundle;
  competitorSnapshots: CompetitorSnapshot[];
  brandLogoUrl: string | null;
  /** Keepa /product details mapped per ASIN (CX scorecard inputs). */
  asinDetails: KeepaAsinDetail[];
  /** Keepa salesRank+price-derived TTM revenue estimate. */
  revenueEstimate: RevenueEstimate | null;
  /** Real SP-API trailing-12mo pull when the brand has an override row.
   * Null for cold prospects (the common case). When non-null, downstream
   * code uses this in place of `revenueEstimate` and labels the math
   * source as "Amazon SP-API · trailing 12 months". */
  spApiTrailing: SpApiTrailingResult | null;
  /** Inferred from the most-common product titles — used to seed extra
   * top_keywords beyond the bare brand name. */
  productCategoryHints: string[];
}

function isFresh(iso: string | null | undefined, windowMs = FRESH_WINDOW_MS): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < windowMs;
}

/**
 * Run all v2-required enrichment steps. Throws EnrichmentStepError on
 * the first hard failure (so the caller can mark the report 'failed'
 * with a specific message).
 */
export async function runV2Enrichment(
  admin: SupabaseClient<any, any, any>,
  brand: BrandRowMin,
): Promise<EnrichResult> {
  // 0. SP-API override — if the brand has a row in brand_sp_api_links,
  // attempt to pull real trailing-12mo sales from the seller's SP-API
  // before doing any Keepa work. We still run Keepa for the
  // reseller / CX / benchmark sections (those don't need seller-side
  // data), but the math section will use SP-API revenue when available.
  let spApiTrailing: SpApiTrailingResult | null = null;
  try {
    const spResult = await pullTrailing12FromSpApi(admin, brand.id);
    if (spResult.ok) {
      spApiTrailing = spResult;
      console.log(
        `[v2/enrich] SP-API override succeeded for "${brand.name}" — $${spResult.trailing_12mo_revenue.toLocaleString("en-US")} across ${spResult.asins.length} ASINs`,
      );
    } else if (spResult.reason !== "no_link") {
      console.warn(
        `[v2/enrich] SP-API override miss for "${brand.name}": ${spResult.reason}${spResult.detail ? ` (${spResult.detail})` : ""}`,
      );
    }
  } catch (e) {
    console.warn("[v2/enrich] SP-API override failed:", e);
  }

  // 1. Keepa.
  if (!isFresh(brand.keepa_last_enriched_at)) {
    try {
      const summary = await enrichBrandWithKeepa(admin, {
        brand_id: brand.id,
        brand_name: brand.name,
        user_id: brand.user_id,
      });
      if (summary.enrichment_error) {
        throw new EnrichmentStepError(
          "keepa",
          summary.enrichment_error.slice(0, 200),
        );
      }
    } catch (e) {
      if (e instanceof EnrichmentStepError) throw e;
      throw new EnrichmentStepError(
        "keepa",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // 2. Load partial bundle so we can pull /product details + infer
  // category seeds before DFS runs (so DFS can pull related_keywords for
  // those seeds in the same enrichment cycle).
  let bundle: BrandEnrichmentBundle | null = null;
  try {
    bundle = await getBrandEnrichmentBundle(admin, brand.id);
  } catch (e) {
    throw new EnrichmentStepError(
      "load_bundle",
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!bundle) {
    throw new EnrichmentStepError("load_bundle", "bundle is null after enrichment");
  }

  // Hard guard: at least Keepa must have produced data, otherwise the report
  // can't render its core sections. DataForSEO can be partially empty (e.g.
  // very small brand, no branded volume) — we still allow that, but flag it.
  const keepaPresent =
    (bundle.keepa.asin_count ?? 0) > 0 || (bundle.keepa.sellers?.length ?? 0) > 0;
  if (!keepaPresent) {
    throw new EnrichmentStepError(
      "keepa",
      "no Keepa ASINs or sellers were captured for this brand",
    );
  }

  // 3. Pull Keepa /product details for the brand's ASINs (cache-friendly:
  // getProductDetails de-dupes against an in-memory 24h cache, and we
  // already paid the tokens during enrichBrandWithKeepa earlier in this
  // request). These power the CX scorecard fields (rating, reviews,
  // images, A+, video) and the salesRank+price revenue estimator.
  let asinDetails: KeepaAsinDetail[] = [];
  let revenueEstimate: RevenueEstimate | null = null;
  let productCategoryHints: string[] = [];
  let titleVocab: string[] = [];
  try {
    const asins = (bundle.keepa.asins ?? []).map((a) => a.asin).filter(Boolean);
    if (asins.length) {
      const products = await getProductDetails(asins, 5);
      asinDetails = products.map(toAsinDetail);
      revenueEstimate = estimateBrandTtmRevenue(
        products.map((p) => ({
          asin: p.asin,
          sales_rank_avg365: p.sales_rank_avg365 ?? null,
          sales_rank_current: p.sales_rank_current ?? null,
          buy_box_avg365: p.buy_box_avg365 ?? null,
          buy_box_current: p.buy_box_current ?? null,
          buy_box_now: p.buy_box_price ?? null,
          product_group: p.product_group ?? null,
          root_category: p.root_category ?? null,
          category_path: p.category_tree?.map((c) => c.name).join(" > ") ?? null,
        })),
      );
      const inferred = inferProductCategoryHints(products, brand.name);
      productCategoryHints = inferred.seeds;
      titleVocab = inferred.titleVocab;
    }
  } catch (e) {
    console.warn("[v2/enrich] keepa /product details fetch failed:", e);
  }

  // 4. DataForSEO — runs after the Keepa /product fetch so we can pass
  // category-seed phrases ("makeup remover wipes" etc) inferred from
  // ASIN titles. Without seeds, related_keywords would only return the
  // brand name itself for many small brands.
  if (!isFresh(brand.dataforseo_last_enriched_at)) {
    try {
      const snap = await enrichBrandWithDataForSeo(admin, {
        brand_id: brand.id,
        brand_name: brand.name,
        user_id: brand.user_id,
        category_seeds: productCategoryHints,
        title_vocab: titleVocab,
      });
      if (snap.enrichment_error) {
        throw new EnrichmentStepError(
          "dataforseo",
          snap.enrichment_error.slice(0, 200),
        );
      }
    } catch (e) {
      if (e instanceof EnrichmentStepError) throw e;
      throw new EnrichmentStepError(
        "dataforseo",
        e instanceof Error ? e.message : String(e),
      );
    }
    // Reload bundle so DFS data is visible to compute().
    try {
      bundle = await getBrandEnrichmentBundle(admin, brand.id);
      if (!bundle) {
        throw new EnrichmentStepError("load_bundle", "bundle is null after DFS enrichment");
      }
    } catch (e) {
      if (e instanceof EnrichmentStepError) throw e;
      throw new EnrichmentStepError(
        "load_bundle",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // 5. Competitor benchmark — top non-brand competitors from DataForSEO
  // SERP, augmented with related_keywords-derived brand candidates and
  // run through the lite Keepa+DFS pipeline so we can ship real numbers
  // (no LLM hallucination). Best effort: failure leaves the section
  // showing only the audited brand.
  const competitorSnapshots = await collectCompetitorSnapshots(
    admin,
    brand.name,
    bundle,
    productCategoryHints,
  );

  // 6. Brand logo (best effort, no network during render).
  // We don't have a website column on `brands`, so we only attempt a
  // Clearbit lookup using the brand name normalized into a guessed
  // domain. Most prospects don't resolve cleanly, so we treat this as a
  // soft try and fall back to initials in the renderer.
  const brandLogoUrl = guessClearbitLogo(brand.name);

  return {
    bundle,
    competitorSnapshots,
    brandLogoUrl,
    asinDetails,
    revenueEstimate,
    spApiTrailing,
    productCategoryHints,
  };
}

function toAsinDetail(p: KeepaProductDetails): KeepaAsinDetail {
  return {
    asin: p.asin,
    title: p.title ?? null,
    rating: p.rating ?? null,
    review_count: p.review_count ?? null,
    images_count: p.images_count ?? null,
    features_count: p.features_count ?? null,
    has_video: p.has_video ?? null,
    has_a_plus: p.has_a_plus ?? null,
    buy_box_avg365: p.buy_box_avg365 ?? null,
    sales_rank_avg365: p.sales_rank_avg365 ?? null,
    product_group: p.product_group ?? null,
    category_tree: p.category_tree ?? null,
    root_category: p.root_category ?? null,
  };
}

/**
 * Infer product-category seed phrases + a per-title vocabulary set
 * from the brand's ASIN titles.
 *
 *   • `seeds` is up to 3 noun-phrase bigrams used to seed DFS
 *     related_keywords (e.g. "makeup remover wipes", "hand wash").
 *   • `titleVocab` is every non-stopword, non-brand token appearing in
 *     ≥ 2 distinct titles. Used downstream to filter the related-keyword
 *     expansion so off-topic SERP drift (e.g. "butcher paper" leaking
 *     in from a single "kraft paper sachet" SKU) gets dropped before
 *     it reaches the report.
 *
 * We deliberately pull bigrams (not single words) because Amazon search
 * intent maps to phrases ("makeup remover" converts; "remover" alone
 * does not).
 */
function inferProductCategoryHints(
  products: KeepaProductDetails[],
  brandName: string,
): { seeds: string[]; titleVocab: string[] } {
  const STOP = new Set([
    "the", "and", "for", "with", "from", "into", "your", "you", "our",
    "this", "that", "use", "uses", "made", "pack", "set", "size",
    "count", "ct", "oz", "ounce", "pcs", "piece", "pieces", "fl", "fluid",
    "inch", "inches", "lb", "lbs", "kg", "g", "ml", "mg", "amazon",
    "free", "new", "best", "top", "premium", "professional", "natural",
    "organic", "fresh", "pure", "great", "value", "small", "large",
    "medium", "x", "xl", "xs",
    "alcohol", "individually", "wrapped", "travel", "friendly", "sensitive",
    "skin", "comfort", "long", "lasting", "deep", "all", "type", "types",
    "hotel", "hotels", "airbnb", "airbnbs", "rental", "rentals", "suitable",
  ]);
  const brandTokens = new Set(
    brandName.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean),
  );
  const tokenize = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter(
        (w) =>
          w.length >= 3 &&
          !STOP.has(w) &&
          !brandTokens.has(w) &&
          !/^\d+$/.test(w),
      );

  // Per-title token sets (so we count distinct titles, not raw repeats
  // — a brand-name string repeated in every title shouldn't dominate).
  const titlesTokenSets: Set<string>[] = [];
  for (const p of products) {
    if (!p.title) continue;
    titlesTokenSets.push(new Set(tokenize(p.title)));
  }
  const totalTitles = titlesTokenSets.length || 1;

  const tokenDocFreq = new Map<string, number>();
  for (const set of titlesTokenSets) {
    set.forEach((w) => tokenDocFreq.set(w, (tokenDocFreq.get(w) ?? 0) + 1));
  }
  // titleVocab = words appearing in ≥ 2 distinct titles.
  const titleVocab = Array.from(tokenDocFreq.entries())
    .filter(([, n]) => n >= 2)
    .map(([w]) => w);

  // Bigram doc-frequency (count distinct titles that contain each bigram).
  const bigramDocFreq = new Map<string, number>();
  for (const p of products) {
    if (!p.title) continue;
    const seq = tokenize(p.title);
    const seen = new Set<string>();
    for (let i = 0; i < seq.length - 1; i++) {
      const bg = `${seq[i]} ${seq[i + 1]}`;
      if (seen.has(bg)) continue;
      seen.add(bg);
      bigramDocFreq.set(bg, (bigramDocFreq.get(bg) ?? 0) + 1);
    }
  }

  // Keep only bigrams whose BOTH tokens land in the per-title vocab —
  // this kills "kraft sachet" / "remover wipes" trailing off-topic
  // partials that come from a single SKU.
  const vocabSet = new Set(titleVocab);
  const seeds = Array.from(bigramDocFreq.entries())
    .filter(
      ([bg, n]) =>
        n >= 2 &&
        !/\d/.test(bg) &&
        bg.split(" ").every((tok) => vocabSet.has(tok)),
    )
    // Tie-break: prefer bigrams that cover a larger share of the catalog.
    .sort((a, b) => b[1] - a[1])
    .map(([bg]) => bg);

  // Require a seed bigram to cover ≥ max(2 titles, 15% of catalog) so
  // a single-SKU outlier (e.g. one "kraft paper sachet" listing in a
  // 23-ASIN wipes-and-lotion catalog) can't seed an entire off-topic
  // category. Cap at 3 — DFS related_keywords on each one already
  // returns ~60 keywords to filter against.
  const COVERAGE_MIN = Math.max(2, Math.ceil(totalTitles * 0.15));
  const filteredSeeds = seeds
    .filter((bg) => (bigramDocFreq.get(bg) ?? 0) >= COVERAGE_MIN)
    .slice(0, 3);

  // Fallback: if nothing meets coverage, take the top 2 by raw doc-freq
  // (still requiring both tokens in vocab) so we still feed DFS something.
  const finalSeeds = filteredSeeds.length ? filteredSeeds : seeds.slice(0, 2);

  return { seeds: finalSeeds, titleVocab };
}

// ----------------------------------------------------------------------
// Competitor benchmark
// ----------------------------------------------------------------------

async function collectCompetitorSnapshots(
  admin: SupabaseClient<any, any, any>,
  brandName: string,
  bundle: BrandEnrichmentBundle,
  productCategoryHints: string[] = [],
): Promise<CompetitorSnapshot[]> {
  // Source competitor candidates from two places:
  //   1. SERP-derived competitor brands captured during DFS enrichment
  //      (most reliable signal — they actually rank against this brand).
  //   2. Brands surfaced on the SERPs for the brand's product-category
  //      seed phrases (e.g. "makeup remover wipes") — fills gaps when
  //      DFS competitor_brands is thin.
  const candidates = new Set<string>();
  for (const c of bundle.dataforseo?.competitor_brands ?? []) {
    if (c.brand) candidates.add(c.brand);
  }

  if (candidates.size < 3 && productCategoryHints.length) {
    // Pull the top SERP ASINs for category-seed phrases and resolve
    // their brand names via a Keepa /product call. DFS returns ASIN +
    // position but rarely the brand text; Keepa does, and one batched
    // /product call (≤ 20 ASINs) is cheap relative to the value of a
    // real competitor row.
    const competingAsins = new Set<string>();
    for (const seed of productCategoryHints.slice(0, 2)) {
      try {
        const products = await fetchBrandSerp(admin, seed);
        for (const p of products.slice(0, 12)) {
          if (p.brand && p.brand.trim().toLowerCase() !== brandName.toLowerCase()) {
            candidates.add(p.brand.trim());
          } else if (p.asin) {
            competingAsins.add(p.asin);
          }
        }
      } catch (e) {
        console.warn("[v2/enrich] category-seed SERP failed:", seed, e);
      }
    }

    if (candidates.size < 3 && competingAsins.size && isKeepaConfigured()) {
      try {
        // Cap at 10 competing ASINs (50 tokens) to leave headroom for
        // the per-competitor enrichment that follows. The flow is
        // already biased toward DFS-supplied competitor brand names
        // first; this Keepa lookup is only a top-up.
        const products = await getProductDetails(Array.from(competingAsins).slice(0, 10), 5);
        const brandCounts = new Map<string, number>();
        for (const p of products) {
          const b = (p.brand ?? "").trim();
          if (!b) continue;
          if (b.toLowerCase() === brandName.toLowerCase()) continue;
          brandCounts.set(b, (brandCounts.get(b) ?? 0) + 1);
        }
        const ranked = Array.from(brandCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([b]) => b);
        for (const b of ranked) {
          candidates.add(b);
          if (candidates.size >= 6) break;
        }
      } catch (e) {
        console.warn("[v2/enrich] competing-asin Keepa /product fetch failed:", e);
      }
    }
  }

  // We may need to walk more than 3 candidates because some will fail
  // the "≥ 2 enriched ASINs" coverage gate and get dropped — better to
  // ship 1-2 real competitors than 3 hollow rows.
  const candidatePool = Array.from(candidates)
    .filter((b) => b.toLowerCase().trim() !== brandName.toLowerCase().trim())
    .slice(0, 8);
  if (!candidatePool.length) return [];

  const out: CompetitorSnapshot[] = [];
  for (const name of candidatePool) {
    if (out.length >= 3) break;
    let snap: CompetitorSnapshot;
    try {
      snap = await getOrFetchCompetitorSnapshot(admin, name);
    } catch (e) {
      console.warn("[v2/enrich] competitor snapshot failed:", name, e);
      continue;
    }
    if (snap.enriched_asin_count < 2) {
      console.log(
        `[v2/enrich] competitor "${name}" dropped — only ${snap.enriched_asin_count} ASIN(s) enriched`,
      );
      continue;
    }
    out.push(snap);
    // Throttle between competitors so we don't slam Keepa's per-second
    // limit. Two ~50-token calls per competitor is comfortable at 1Hz.
    await new Promise((r) => setTimeout(r, 1500));
  }
  return out;
}

// Cache schema version — bumped any time CompetitorSnapshot's shape
// changes so an older serialized payload doesn't poison fresh runs.
const COMPETITOR_CACHE_VERSION = 2;

async function getOrFetchCompetitorSnapshot(
  admin: SupabaseClient<any, any, any>,
  competitorBrand: string,
): Promise<CompetitorSnapshot> {
  const norm = competitorBrand.toLowerCase().trim();

  // Cache hit? Only if the cached payload is at the current shape
  // version (otherwise we'd silently keep returning the v1 hollow row).
  try {
    const { data } = await admin
      .from("competitor_brands_cache")
      .select("payload, expires_at")
      .eq("brand_name_norm", norm)
      .maybeSingle();
    if (data && new Date(data.expires_at).getTime() > Date.now()) {
      const cached = data.payload as any;
      if (
        cached &&
        typeof cached === "object" &&
        cached.__v === COMPETITOR_CACHE_VERSION
      ) {
        const { __v: _v, ...rest } = cached;
        return rest as CompetitorSnapshot;
      }
    }
  } catch {
    // proceed to refresh
  }

  // Refresh — run the same enrichment we run for the audited brand:
  //   • Keepa brand search → /product (offers + stats + aplus + videos)
  //     → derive brand_controlled_pct, unique_seller_count, listing_health
  //   • DataForSEO related_keywords → branded_search_volume + SERP rank
  // Cached cross-user for 14 days (keyed by `__v` so a future shape
  // change automatically invalidates).
  let branded_search_volume: number | null = null;
  let organic_serp_rank: number | null = null;
  try {
    const kws = await fetchBrandKeywords(admin, competitorBrand);
    branded_search_volume = kws
      .filter((k) =>
        k.keyword.toLowerCase().includes(competitorBrand.toLowerCase()),
      )
      .reduce((a, k) => a + (k.search_volume ?? 0), 0);
    if (!branded_search_volume) branded_search_volume = null;

    // Top branded keyword's first product brand match position.
    const topKw = kws
      .slice()
      .sort((a, b) => (b.search_volume ?? 0) - (a.search_volume ?? 0))[0];
    if (topKw?.keyword) {
      const products = await fetchBrandSerp(admin, topKw.keyword);
      const hit = products.find((p) =>
        (p.brand ?? "").toLowerCase().includes(competitorBrand.toLowerCase()),
      );
      organic_serp_rank = hit?.position ?? null;
    }
  } catch {
    // soft fail
  }

  let unique_seller_count: number | null = null;
  let brand_controlled_pct: number | null = null;
  let listing_health: number | null = null;
  let enriched_asin_count = 0;
  if (isKeepaConfigured()) {
    try {
      const search = await searchProductsByBrand(competitorBrand, 10);
      if (search.asins.length) {
        const products = await getProductDetails(search.asins, 5);
        enriched_asin_count = products.length;
        const sellers = new Set<string>();
        let brandControlled = 0;
        let counted = 0;
        for (const p of products) {
          const winner = p.buy_box_seller ?? p.buy_box_seller_id;
          if (winner) sellers.add(winner.toLowerCase());
          if (p.buy_box_seller) {
            counted += 1;
            if (isBrandControlled(p.buy_box_seller, competitorBrand)) {
              brandControlled += 1;
            }
          }
        }
        if (sellers.size) unique_seller_count = sellers.size;
        if (counted > 0) brand_controlled_pct = brandControlled / counted;

        // Listing health — same rubric as computeCxAuditBase, averaged.
        const scores: number[] = [];
        for (const p of products) {
          const s = scoreProductListing(p);
          if (s != null) scores.push(s);
        }
        if (scores.length) {
          listing_health = Math.round(
            scores.reduce((a, b) => a + b, 0) / scores.length,
          );
        }
      }
    } catch (e) {
      console.warn("[v2/enrich] competitor Keepa lookup failed:", competitorBrand, e);
    }
  }

  const snapshot: CompetitorSnapshot = {
    brand: competitorBrand,
    unique_seller_count,
    brand_controlled_pct,
    branded_search_volume,
    organic_serp_rank,
    listing_health,
    enriched_asin_count,
  };

  try {
    const expires_at = new Date(Date.now() + FRESH_WINDOW_MS).toISOString();
    await admin.from("competitor_brands_cache").upsert(
      {
        brand_name_norm: norm,
        display_name: competitorBrand,
        payload: { __v: COMPETITOR_CACHE_VERSION, ...snapshot },
        fetched_at: new Date().toISOString(),
        expires_at,
      },
      { onConflict: "brand_name_norm" },
    );
  } catch {
    // cache failure is fine
  }

  return snapshot;
}

/**
 * Score a single Keepa /product listing on the same 0-100 rubric the
 * audited brand uses in computeCxAuditBase (compute.ts). Returns null
 * if no measurable fields landed — caller should skip.
 */
function scoreProductListing(p: {
  images_count?: number | null;
  features_count?: number | null;
  has_a_plus?: boolean | null;
  has_video?: boolean | null;
  rating?: number | null;
  review_count?: number | null;
}): number | null {
  let score = 0;
  let measured = 0;
  if (p.images_count != null) {
    score += Math.min(25, Math.round((p.images_count / 6) * 25));
    measured += 1;
  }
  if (p.features_count != null) {
    score += Math.min(15, Math.round((p.features_count / 5) * 15));
    measured += 1;
  }
  if (p.has_a_plus === true) {
    score += 10;
    measured += 1;
  } else if (p.has_a_plus === false) {
    measured += 1;
  }
  if (p.has_video === true) {
    score += 10;
    measured += 1;
  } else if (p.has_video === false) {
    measured += 1;
  }
  if (p.rating != null) {
    if (p.rating >= 4.5) score += 20;
    else if (p.rating >= 4.0) score += 14;
    else if (p.rating >= 3.5) score += 7;
    measured += 1;
  }
  if (p.review_count != null) {
    const r = Math.max(0, Math.min(4, Math.log10(Math.max(1, p.review_count))));
    score += Math.round((r / 4) * 20);
    measured += 1;
  }
  if (measured === 0) return null;
  return Math.min(100, score);
}

// ----------------------------------------------------------------------
// Logo
// ----------------------------------------------------------------------

function guessClearbitLogo(brandName: string): string | null {
  // Best-effort domain guess. The renderer falls back to initials if
  // Clearbit returns 404, so a wrong guess is harmless.
  const slug = brandName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 32);
  if (!slug) return null;
  return `https://logo.clearbit.com/${slug}.com`;
}
