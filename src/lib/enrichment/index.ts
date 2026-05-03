/**
 * Phase 4.5 — Public enrichment bundle.
 *
 * `getBrandEnrichmentBundle(brandId)` is the single contract used by the
 * report generator, the brand-detail page, and the smoke-test script. It
 * returns the latest cached Keepa snapshot, the latest DataForSEO
 * snapshot, the combined validation score, and a list of human-readable
 * value-add signals.
 *
 * The bundle is read-only — it never triggers Keepa or DataForSEO calls
 * directly. Use `enrichBrandWithKeepa` / `enrichBrandWithDataForSeo`
 * (called from the API routes) to refresh upstream data.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeCombinedValidationScore,
  deriveValueAddSignals,
  type ValidationSignals,
  type DataForSeoSignals,
} from "./scoring";

export interface KeepaSnapshot {
  asin_count: number | null;
  unique_seller_count: number | null;
  brand_controlled_pct: number | null;
  top_seller: string | null;
  top_seller_share_pct: number | null;
  top_seller_country: string | null;
  avg_offers: number | null;
  last_enriched_at: string | null;
  asins: KeepaAsinRow[];
  sellers: KeepaSellerRow[];
}

export interface KeepaAsinRow {
  asin: string;
  title: string | null;
  buy_box_seller: string | null;
  buy_box_price: number | null;
  offers_count: number | null;
  fba_offers_count: number | null;
  is_brand_controlled: boolean | null;
}

export interface KeepaSellerRow {
  seller_name: string;
  seller_id: string | null;
  share_pct: number | null;
  asins_won: number | null;
  is_fba: boolean | null;
  /** Phase 23 — classification verdict from `seller-classification.ts`.
   * Null on legacy rows enriched before that path shipped. */
  is_brand_controlled?: boolean | null;
  /** Phase 23 — human-readable reason persisted alongside the verdict. */
  classification_reason?: string | null;
}

export interface DataForSeoSnapshotRow {
  branded_search_volume: number | null;
  branded_trend_pct: number | null;
  top_keywords: { keyword: string; search_volume: number | null }[];
  competitor_brands: { brand: string; share_of_serp: number }[];
  serp_positions: {
    keyword: string;
    asin?: string;
    brand?: string;
    position: number;
    is_brand?: boolean;
  }[];
  organic_traffic_value: number | null;
  captured_at: string | null;
}

export interface BrandEnrichmentBundle {
  brandId: string;
  brandName: string;
  keepa: KeepaSnapshot;
  dataforseo: DataForSeoSnapshotRow;
  validationScore: number | null;
  valueAddSignals: string[];
  freshness: {
    keepa: string | null;
    dataforseo: string | null;
  };
}

const EMPTY_KEEPA: KeepaSnapshot = {
  asin_count: null,
  unique_seller_count: null,
  brand_controlled_pct: null,
  top_seller: null,
  top_seller_share_pct: null,
  top_seller_country: null,
  avg_offers: null,
  last_enriched_at: null,
  asins: [],
  sellers: [],
};

const EMPTY_DFS: DataForSeoSnapshotRow = {
  branded_search_volume: null,
  branded_trend_pct: null,
  top_keywords: [],
  competitor_brands: [],
  serp_positions: [],
  organic_traffic_value: null,
  captured_at: null,
};

export async function getBrandEnrichmentBundle(
  supabase: SupabaseClient<any, any, any>,
  brandId: string,
): Promise<BrandEnrichmentBundle | null> {
  // 1. Brand row — source of truth for both summary fields.
  const { data: brand } = await supabase
    .from("brands")
    .select("*")
    .eq("id", brandId)
    .maybeSingle();
  if (!brand) return null;

  // 2. Keepa: child rows (asins + sellers) for chart rendering and tables.
  const sellersWithClassification = supabase
    .from("brand_sellers")
    .select(
      "seller_name, seller_id, share_pct, asins_won, is_fba, seller_country, is_brand_controlled, classification_reason",
    )
    .eq("brand_id", brandId)
    .order("share_pct", { ascending: false })
    .limit(20);

  const [asinsRes, sellersRes] = await Promise.all([
    supabase
      .from("brand_asins")
      .select("asin, title, buy_box_seller, buy_box_price, offers_count, fba_offers_count, is_brand_controlled")
      .eq("brand_id", brandId)
      .order("offers_count", { ascending: false })
      .limit(50),
    sellersWithClassification,
  ]);

  // Phase 23 — fall back to the legacy column set when the new
  // classification columns haven't been migrated in yet.
  let sellers: Array<KeepaSellerRow & { seller_country: string | null }>;
  if (sellersRes.error) {
    const msg = sellersRes.error.message ?? "";
    if (/column .* does not exist|is_brand_controlled|classification_reason/i.test(msg)) {
      const legacy = await supabase
        .from("brand_sellers")
        .select("seller_name, seller_id, share_pct, asins_won, is_fba, seller_country")
        .eq("brand_id", brandId)
        .order("share_pct", { ascending: false })
        .limit(20);
      sellers = (legacy.data ?? []) as Array<
        KeepaSellerRow & { seller_country: string | null }
      >;
    } else {
      sellers = [];
    }
  } else {
    sellers = (sellersRes.data ?? []) as Array<
      KeepaSellerRow & { seller_country: string | null }
    >;
  }
  const topSellerCountry = sellers[0]?.seller_country ?? null;

  const keepa: KeepaSnapshot = {
    asin_count: brand.keepa_asin_count ?? null,
    unique_seller_count: brand.keepa_unique_seller_count ?? null,
    brand_controlled_pct: brand.keepa_brand_controlled_pct ?? null,
    top_seller: brand.keepa_top_seller ?? null,
    top_seller_share_pct: brand.keepa_top_seller_share_pct ?? null,
    top_seller_country: topSellerCountry,
    avg_offers: brand.keepa_avg_offers ?? null,
    last_enriched_at: brand.keepa_last_enriched_at ?? null,
    asins: (asinsRes.data ?? []) as KeepaAsinRow[],
    sellers: sellers.map((s) => ({
      seller_name: s.seller_name,
      seller_id: s.seller_id,
      share_pct: s.share_pct,
      asins_won: s.asins_won,
      is_fba: s.is_fba,
      is_brand_controlled: s.is_brand_controlled ?? null,
      classification_reason: s.classification_reason ?? null,
    })),
  };

  // 3. DataForSEO: latest brand_search_metrics row.
  const { data: dfsRow } = await supabase
    .from("brand_search_metrics")
    .select(
      "branded_search_volume, branded_trend_pct, top_keywords, competitor_brands, serp_positions, organic_traffic_value, captured_at",
    )
    .eq("brand_id", brandId)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const dataforseo: DataForSeoSnapshotRow = dfsRow
    ? {
        branded_search_volume: dfsRow.branded_search_volume ?? null,
        branded_trend_pct: dfsRow.branded_trend_pct ?? null,
        top_keywords: Array.isArray(dfsRow.top_keywords) ? dfsRow.top_keywords : [],
        competitor_brands: Array.isArray(dfsRow.competitor_brands)
          ? dfsRow.competitor_brands
          : [],
        serp_positions: Array.isArray(dfsRow.serp_positions) ? dfsRow.serp_positions : [],
        organic_traffic_value: dfsRow.organic_traffic_value ?? null,
        captured_at: dfsRow.captured_at ?? null,
      }
    : EMPTY_DFS;

  // 4. Combined score + signals.
  const keepaSignals: ValidationSignals = {
    top_seller_share_pct: keepa.top_seller_share_pct,
    brand_controlled_pct: keepa.brand_controlled_pct,
    unique_seller_count: keepa.unique_seller_count,
    asin_count: keepa.asin_count,
    top_seller_country: keepa.top_seller_country,
  };
  const competitor_top_share = dataforseo.competitor_brands?.[0]?.share_of_serp ?? null;
  const dfsSignals: DataForSeoSignals = {
    branded_search_volume: dataforseo.branded_search_volume,
    branded_trend_pct: dataforseo.branded_trend_pct,
    competitor_top_share,
    competitor_count: dataforseo.competitor_brands?.length ?? null,
  };

  const validationScore = computeCombinedValidationScore(keepaSignals, dfsSignals);
  const valueAddSignals = deriveValueAddSignals(keepaSignals, dfsSignals);

  return {
    brandId,
    brandName: brand.name,
    keepa,
    dataforseo,
    validationScore,
    valueAddSignals,
    freshness: {
      keepa: keepa.last_enriched_at,
      dataforseo: dataforseo.captured_at,
    },
  };
}

/** Convenience for callers that already have just the bundle and want the
 * data_sources jsonb to persist on a `reports` row. */
export function buildDataSourcesProvenance(
  bundle: Pick<BrandEnrichmentBundle, "freshness" | "keepa" | "dataforseo">,
): Record<string, unknown> {
  const keepa_present =
    !!bundle.freshness.keepa || (bundle.keepa.asins?.length ?? 0) > 0;
  const dfs_present =
    !!bundle.freshness.dataforseo ||
    (bundle.dataforseo.top_keywords?.length ?? 0) > 0;
  return {
    keepa: keepa_present,
    dataforseo: dfs_present,
    keepa_freshness: bundle.freshness.keepa,
    dataforseo_freshness: bundle.freshness.dataforseo,
  };
}

export {
  // Re-export so consumers don't reach into ./scoring directly.
  computeCombinedValidationScore,
  deriveValueAddSignals,
} from "./scoring";
export type { ValidationSignals, DataForSeoSignals } from "./scoring";
