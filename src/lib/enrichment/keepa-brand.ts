/**
 * Phase 4 — single-brand Keepa enrichment orchestrator.
 *
 * Steps:
 *  1) Insert enrichment_runs row (status=running)
 *  2) Search Keepa for ASINs under brand name
 *  3) Batch-fetch product/offer details (chunks of 5)
 *  4) Upsert brand_asins
 *  5) Aggregate brand_sellers (replace per brand)
 *  6) Compute brand-level keepa_* summary + validation_score
 *  7) Mark run completed; stamp keepa_last_enriched_at
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  searchProductsByBrand,
  getProductDetails,
  resolveSellerNames,
  isAmazonSellerId,
  type KeepaProductDetails,
} from "@/lib/keepa";
import { makeSellerCache } from "./keepa-seller-cache";
import {
  computeValidationScore,
  computeCombinedValidationScore,
  type DataForSeoSignals,
} from "./scoring";

export interface EnrichmentSummary {
  run_id: string;
  brand_id: string;
  asin_count: number;
  unique_seller_count: number;
  brand_controlled_pct: number | null;
  top_seller: string | null;
  top_seller_share_pct: number | null;
  avg_offers: number | null;
  validation_score: number | null;
  tokens_used: number;
  amazon_1p_share: number;
  enrichment_error: string | null;
}

export interface EnrichInput {
  brand_id: string;
  brand_name: string;
  user_id: string;
  existing_disqualifier_tags?: string[];
}

export async function enrichBrandWithKeepa(
  supabase: SupabaseClient<any, any, any>,
  input: EnrichInput,
): Promise<EnrichmentSummary> {
  const { brand_id, brand_name, user_id } = input;
  const existingTags = new Set<string>(input.existing_disqualifier_tags ?? []);

  const runIns = await supabase
    .from("enrichment_runs")
    .insert({
      user_id,
      brand_id,
      source: "keepa",
      status: "running",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  const run_id: string = runIns.data?.id ?? "";

  let tokensUsed = 0;
  try {
    const search = await searchProductsByBrand(brand_name, 20);
    tokensUsed += search.tokens_used;
    const asins = search.asins;

    if (!asins.length) {
      const summary: EnrichmentSummary = {
        run_id,
        brand_id,
        asin_count: 0,
        unique_seller_count: 0,
        brand_controlled_pct: null,
        top_seller: null,
        top_seller_share_pct: null,
        avg_offers: null,
        validation_score: null,
        tokens_used: tokensUsed,
        amazon_1p_share: 0,
        enrichment_error: "No ASINs found",
      };

      await supabase
        .from("brands")
        .update({
          keepa_last_enriched_at: new Date().toISOString(),
          keepa_asin_count: 0,
          keepa_unique_seller_count: 0,
          keepa_brand_controlled_pct: null,
          keepa_top_seller: null,
          keepa_top_seller_share_pct: null,
          keepa_avg_offers: null,
          validation_score: null,
          enrichment_error: "No ASINs found",
          updated_at: new Date().toISOString(),
        })
        .eq("id", brand_id)
        .eq("user_id", user_id);

      if (run_id) {
        await supabase
          .from("enrichment_runs")
          .update({
            status: "completed",
            tokens_used: tokensUsed,
            asins_found: 0,
            completed_at: new Date().toISOString(),
            error_message: "No ASINs found",
          })
          .eq("id", run_id);
      }
      return summary;
    }

    const products = await getProductDetails(asins, 5);
    tokensUsed += products.length * 5; // rough estimate (cache hits don't count perfectly)

    // Upsert brand_asins rows
    const asinRows = products.map((p) => ({
      brand_id,
      asin: p.asin,
      title: p.title ?? null,
      buy_box_seller: p.buy_box_seller ?? null,
      buy_box_price: p.buy_box_price ?? null,
      offers_count: p.total_offers_count ?? 0,
      fba_offers_count: p.fba_offers_count ?? 0,
      is_brand_controlled: isBrandControlled(p.buy_box_seller, brand_name),
      last_checked_at: new Date().toISOString(),
    }));

    if (asinRows.length) {
      const { error: upErr } = await supabase
        .from("brand_asins")
        .upsert(asinRows, { onConflict: "brand_id,asin" });
      if (upErr) throw new Error(`brand_asins upsert: ${upErr.message}`);
    }

    // Aggregate brand_sellers: count asins won (buy-box winner) per seller
    const sellerMap = new Map<string, {
      seller_name: string;
      seller_id?: string;
      seller_country?: string;
      is_fba?: boolean;
      asins_won: number;
    }>();

    let amazonOnesP = 0;
    for (const p of products) {
      const winnerName = p.buy_box_seller ?? null;
      if (winnerName) {
        const key = (p.buy_box_seller_id || winnerName).toLowerCase();
        const existing = sellerMap.get(key);
        if (existing) existing.asins_won += 1;
        else sellerMap.set(key, {
          seller_name: winnerName,
          seller_id: p.buy_box_seller_id,
          seller_country: p.buy_box_is_amazon ? "US" : undefined,
          is_fba: !!p.buy_box_is_fba,
          asins_won: 1,
        });
      }
      if (p.buy_box_is_amazon) amazonOnesP += 1;
    }

    // Replace existing brand_sellers rows for this brand to keep aggregates fresh
    const { error: delErr } = await supabase
      .from("brand_sellers")
      .delete()
      .eq("brand_id", brand_id);
    if (delErr) throw new Error(`brand_sellers delete: ${delErr.message}`);

    // Resolve real seller names for any IDs that came back as bare
    // sellerIds (e.g. "AP3VA1GJZM3EQ"). Keepa's /seller endpoint costs
    // 1 token per ID and accepts up to 100 per call. Cached 30 days.
    const idsToResolve = new Set<string>();
    for (const s of Array.from(sellerMap.values())) {
      if (s.seller_id && isAmazonSellerId(s.seller_id) && (
        !s.seller_name ||
        s.seller_name === s.seller_id ||
        isAmazonSellerId(s.seller_name)
      )) {
        idsToResolve.add(s.seller_id);
      }
    }
    let resolvedNames: Record<string, string | null> = {};
    try {
      resolvedNames = await resolveSellerNames(idsToResolve, makeSellerCache(supabase));
    } catch {
      // soft fail — fall back to IDs
    }

    const totalWon = Array.from(sellerMap.values()).reduce((a, s) => a + s.asins_won, 0);
    const sellerRows = Array.from(sellerMap.values()).map((s) => {
      const resolved = s.seller_id ? resolvedNames[s.seller_id] : null;
      const finalName =
        resolved && resolved.trim()
          ? resolved
          : s.seller_name && !isAmazonSellerId(s.seller_name)
          ? s.seller_name
          : s.seller_id ?? s.seller_name;
      return {
        brand_id,
        seller_name: finalName,
        seller_id: s.seller_id ?? null,
        seller_country: s.seller_country ?? null,
        share_pct: totalWon > 0 ? s.asins_won / totalWon : null,
        asins_won: s.asins_won,
        is_fba: s.is_fba ?? null,
        last_seen_at: new Date().toISOString(),
      };
    });

    if (sellerRows.length) {
      const { error: insErr } = await supabase
        .from("brand_sellers")
        .insert(sellerRows);
      if (insErr) throw new Error(`brand_sellers insert: ${insErr.message}`);
    }

    // Brand-level summary
    const asin_count = products.length;
    const unique_seller_count = sellerMap.size;
    const totalOffers = products.reduce((a, p) => a + (p.total_offers_count ?? 0), 0);
    const avg_offers = asin_count ? totalOffers / asin_count : null;
    const brandCtrlCount = products.filter((p) => isBrandControlled(p.buy_box_seller, brand_name)).length;
    const brand_controlled_pct = asin_count ? brandCtrlCount / asin_count : null;
    const sortedSellers = sellerRows.slice().sort((a, b) => (b.asins_won ?? 0) - (a.asins_won ?? 0));
    const top = sortedSellers[0];
    const top_seller = top?.seller_name ?? null;
    const top_seller_share_pct = top?.share_pct ?? null;
    const top_seller_country = top?.seller_country ?? null;

    // Combine Keepa channel signals with the latest DataForSEO snapshot
    // (if any) so validation_score reflects both pillars. Falls back to
    // the legacy Keepa-only score when no DFS data exists yet.
    const dfsSignals = await loadLatestDfsSignals(supabase, brand_id);
    const validation_score = dfsSignals
      ? computeCombinedValidationScore(
          {
            top_seller_share_pct,
            brand_controlled_pct,
            unique_seller_count,
            asin_count,
            top_seller_country,
          },
          dfsSignals,
        )
      : computeValidationScore({
          top_seller_share_pct,
          brand_controlled_pct,
          unique_seller_count,
          asin_count,
          top_seller_country,
        });

    const amazon1pShare = asin_count ? amazonOnesP / asin_count : 0;
    const nextTags = new Set(existingTags);
    if (amazon1pShare > 0.5) nextTags.add("amazon_1p_vendor");

    await supabase
      .from("brands")
      .update({
        keepa_last_enriched_at: new Date().toISOString(),
        keepa_asin_count: asin_count,
        keepa_unique_seller_count: unique_seller_count,
        keepa_brand_controlled_pct: brand_controlled_pct,
        keepa_top_seller: top_seller,
        keepa_top_seller_share_pct: top_seller_share_pct,
        keepa_avg_offers: avg_offers,
        validation_score,
        enrichment_error: null,
        disqualifier_tags: Array.from(nextTags),
        updated_at: new Date().toISOString(),
      })
      .eq("id", brand_id)
      .eq("user_id", user_id);

    if (run_id) {
      await supabase
        .from("enrichment_runs")
        .update({
          status: "completed",
          tokens_used: tokensUsed,
          asins_found: asin_count,
          completed_at: new Date().toISOString(),
        })
        .eq("id", run_id);
    }

    return {
      run_id,
      brand_id,
      asin_count,
      unique_seller_count,
      brand_controlled_pct,
      top_seller,
      top_seller_share_pct,
      avg_offers,
      validation_score,
      tokens_used: tokensUsed,
      amazon_1p_share: amazon1pShare,
      enrichment_error: null,
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 500);
    if (run_id) {
      await supabase
        .from("enrichment_runs")
        .update({
          status: "failed",
          tokens_used: tokensUsed,
          completed_at: new Date().toISOString(),
          error_message: msg,
        })
        .eq("id", run_id);
    }
    await supabase
      .from("brands")
      .update({
        enrichment_error: msg,
        updated_at: new Date().toISOString(),
      })
      .eq("id", brand_id)
      .eq("user_id", user_id);
    throw err;
  }
}

async function loadLatestDfsSignals(
  supabase: SupabaseClient<any, any, any>,
  brandId: string,
): Promise<DataForSeoSignals | null> {
  try {
    const { data } = await supabase
      .from("brand_search_metrics")
      .select("branded_search_volume, branded_trend_pct, competitor_brands")
      .eq("brand_id", brandId)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    const competitors = Array.isArray(data.competitor_brands) ? data.competitor_brands : [];
    const top = competitors[0];
    return {
      branded_search_volume: data.branded_search_volume ?? null,
      branded_trend_pct: data.branded_trend_pct ?? null,
      competitor_top_share: typeof top?.share_of_serp === "number" ? top.share_of_serp : null,
      competitor_count: competitors.length || null,
    };
  } catch {
    return null;
  }
}

export function isBrandControlled(buyBoxSeller: string | null | undefined, brandName: string): boolean {
  if (!buyBoxSeller) return false;
  const a = buyBoxSeller.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = brandName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!a || !b) return false;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}
