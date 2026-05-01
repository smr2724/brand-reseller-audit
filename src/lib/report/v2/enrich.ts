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
}

export interface EnrichResult {
  bundle: BrandEnrichmentBundle;
  competitorSnapshots: CompetitorSnapshot[];
  brandLogoUrl: string | null;
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

  // 2. DataForSEO.
  if (!isFresh(brand.dataforseo_last_enriched_at)) {
    try {
      const snap = await enrichBrandWithDataForSeo(admin, {
        brand_id: brand.id,
        brand_name: brand.name,
        user_id: brand.user_id,
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
  }

  // 3. Read the unified bundle.
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

  // 4. Competitor benchmark — top non-brand competitors from DataForSEO
  // SERP. Pull a lite snapshot for each (cached cross-user). Best effort:
  // if it fails, we still ship the report but the competitor section
  // will fall back to "— not measured" rows.
  const competitorSnapshots = await collectCompetitorSnapshots(
    admin,
    brand.name,
    bundle,
  );

  // 5. Brand logo (best effort, no network during render).
  // We don't have a website column on `brands`, so we only attempt a
  // Clearbit lookup using the brand name normalized into a guessed
  // domain. Most prospects don't resolve cleanly, so we treat this as a
  // soft try and fall back to initials in the renderer.
  const brandLogoUrl = guessClearbitLogo(brand.name);

  return { bundle, competitorSnapshots, brandLogoUrl };
}

// ----------------------------------------------------------------------
// Competitor benchmark
// ----------------------------------------------------------------------

async function collectCompetitorSnapshots(
  admin: SupabaseClient<any, any, any>,
  brandName: string,
  bundle: BrandEnrichmentBundle,
): Promise<CompetitorSnapshot[]> {
  const competitors = (bundle.dataforseo?.competitor_brands ?? [])
    .map((c) => c.brand)
    .filter((b) => !!b)
    .slice(0, 5);
  if (!competitors.length) return [];

  const out: CompetitorSnapshot[] = [];
  for (const name of competitors) {
    try {
      const snap = await getOrFetchCompetitorSnapshot(admin, name);
      out.push(snap);
    } catch (e) {
      console.warn("[v2/enrich] competitor snapshot failed:", name, e);
      out.push({
        brand: name,
        unique_seller_count: null,
        brand_controlled_pct: null,
        branded_search_volume: null,
        organic_serp_rank: null,
      });
    }
    if (out.length >= 4) break;
  }
  return out;
}

async function getOrFetchCompetitorSnapshot(
  admin: SupabaseClient<any, any, any>,
  competitorBrand: string,
): Promise<CompetitorSnapshot> {
  const norm = competitorBrand.toLowerCase().trim();

  // Cache hit?
  try {
    const { data } = await admin
      .from("competitor_brands_cache")
      .select("payload, expires_at")
      .eq("brand_name_norm", norm)
      .maybeSingle();
    if (data && new Date(data.expires_at).getTime() > Date.now()) {
      return data.payload as CompetitorSnapshot;
    }
  } catch {
    // proceed to refresh
  }

  // Refresh — DataForSEO only (lightweight). We don't run Keepa here
  // because the competitor isn't in our `brands` table; that would
  // explode token budget per report. Keepa fields stay null.
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

  const snapshot: CompetitorSnapshot = {
    brand: competitorBrand,
    unique_seller_count: null,
    brand_controlled_pct: null,
    branded_search_volume,
    organic_serp_rank,
  };

  try {
    const expires_at = new Date(Date.now() + FRESH_WINDOW_MS).toISOString();
    await admin.from("competitor_brands_cache").upsert(
      {
        brand_name_norm: norm,
        display_name: competitorBrand,
        payload: snapshot,
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
