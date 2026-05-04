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
  resolveSellerInfo,
  isAmazonSellerId,
  expandVariationAsins,
  type KeepaProductDetails,
} from "@/lib/keepa";
import { makeSellerCache } from "./keepa-seller-cache";
import {
  computeValidationScore,
  computeCombinedValidationScore,
  type DataForSeoSignals,
} from "./scoring";
import {
  classifySellers,
  aggregateBrandControlledShare,
  amazon1pThreshold,
  isAmazon1pBrand,
  AMAZON_RETAIL_SELLER_ID,
  type SellerClassification,
} from "./seller-classification";
import { rankToMonthlyUnits } from "./revenue-estimator";
import {
  attributeVariationSales,
  indexAttributionByAsin,
} from "./variation-attribution";

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
  /** Phase 23 — true when Amazon retail (ATVPDKIKX0DER) holds ≥
   * AMAZON_1P_THRESHOLD_PCT of buy boxes. Triggers the not_a_fit report
   * shape upstream. */
  amazon_1p_disqualified: boolean;
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
    // Phase 33 — request up to 500 brand parents. The Phase 11 cap of 40
    // silently dropped the long tail of large catalogs (Terra Pure
    // 663 → 44, Yeti 8,486 → 20, OXO 6,517 → 45). The 500 ceiling is
    // enforced inside `searchProductsByBrand` via KEEPA_MAX_PAGES_PER_BRAND
    // (5 pages × perPage 100), with an in-loop token-budget guard so a
    // single big brand can't drain Keepa's ~3,900-token bucket.
    // Variation expansion below still bounds children at 200 combined.
    const search = await searchProductsByBrand(brand_name, 500);
    tokensUsed += search.tokens_used;
    // Keepa's brand search returns parents only. Expand child variations
    // so Beauty/Health/Grocery brands (where 1 parent listing maps to
    // 5–20 child SKUs each with its own BSR + price) get fully measured.
    // Cap at 200 to bound Keepa token cost.
    let asins = search.asins;
    let expansion: { children: string[]; hit_cap: boolean } = { children: [], hit_cap: false };
    if (asins.length) {
      try {
        const exp = await expandVariationAsins(asins, 200);
        asins = exp.combined;
        expansion = { children: exp.children, hit_cap: exp.hit_cap };
        if (exp.hit_cap) {
          console.warn(
            `[keepa-brand] variation cap hit for "${brand_name}" — capped at 200 ASINs`,
          );
        }
        console.log(
          `[keepa-brand] "${brand_name}" expanded: parents=${search.asins.length} children=${exp.children.length} total=${asins.length}`,
        );
      } catch (e) {
        console.warn(`[keepa-brand] variation expansion failed for "${brand_name}":`, e);
      }
    }

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
        amazon_1p_disqualified: false,
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
    // Resolve every seller (not just unresolved-name IDs) so we pick up
    // a country for sellers whose names already came back from /product.
    const allSellerIds = new Set<string>();
    for (const s of Array.from(sellerMap.values())) {
      if (s.seller_id && isAmazonSellerId(s.seller_id)) {
        allSellerIds.add(s.seller_id);
      }
    }
    let resolvedInfo: Record<string, { name: string | null; country: string | null }> = {};
    try {
      resolvedInfo = await resolveSellerInfo(allSellerIds, makeSellerCache(supabase));
    } catch {
      // soft fail — fall back to IDs
    }

    const totalWon = Array.from(sellerMap.values()).reduce((a, s) => a + s.asins_won, 0);
    const preResolved = Array.from(sellerMap.values()).map((s) => {
      const resolved = s.seller_id ? resolvedInfo[s.seller_id] : null;
      const resolvedName = resolved?.name?.trim() || null;
      // Hotfix — May 2026: when Keepa's /seller endpoint can't resolve a
      // storefront name, persist NULL instead of falling back to the raw
      // seller_id. The renderer (`friendlySellerName`) already shows
      // "Unknown 3P seller (ID: …)" for IDs masquerading as names — but
      // by storing NULL we let the classifier skip these rows cleanly
      // and the renderer fall through to its NULL branch.
      const finalName: string | null =
        resolvedName
          ? resolvedName
          : s.seller_name && !isAmazonSellerId(s.seller_name)
          ? s.seller_name
          : null;
      const country = resolved?.country ?? s.seller_country ?? null;
      return {
        seller_name: finalName,
        seller_id: s.seller_id ?? null,
        seller_country: country,
        share_pct: totalWon > 0 ? s.asins_won / totalWon : null,
        asins_won: s.asins_won,
        is_fba: s.is_fba ?? null,
      };
    });

    // Phase 23 — classify each seller against the brand AFTER name
    // resolution (the Phase 4 path classified pre-resolution against
    // raw seller-ids, which is why "Fantaswick LLC" was tagged a
    // reseller). Cap the LLM tiebreaker at 5 calls per scan so the
    // ambiguous-band fallback can never blow our budget.
    const classified = await classifySellers(brand_name, preResolved, {
      llm_budget: 5,
    });

    const sellerRows = classified.map((s) => ({
      brand_id,
      seller_name: s.seller_name,
      seller_id: s.seller_id ?? null,
      seller_country: s.seller_country,
      share_pct: s.share_pct,
      asins_won: s.asins_won,
      is_fba: s.is_fba,
      is_brand_controlled: s.classification.is_brand_controlled,
      classification_reason: s.classification.reason.slice(0, 500),
      last_seen_at: new Date().toISOString(),
    }));

    if (sellerRows.length) {
      const { error: insErr } = await supabase
        .from("brand_sellers")
        .insert(sellerRows);
      if (insErr) {
        // Phase 23 — retry without the new classification columns when
        // the migration hasn't landed yet. The classifier still drives
        // brand_controlled_pct + top_seller below; persistence of the
        // reason on brand_sellers is best-effort transparency.
        const msg = insErr.message ?? "";
        const looksLikeMissingColumn = /column .* does not exist|is_brand_controlled|classification_reason/i.test(msg);
        if (looksLikeMissingColumn) {
          console.warn(
            `[keepa-brand] brand_sellers insert with classification columns failed (${msg}); retrying without them.`,
          );
          const legacyRows = sellerRows.map(({ is_brand_controlled, classification_reason, ...rest }) => rest);
          const { error: retryErr } = await supabase
            .from("brand_sellers")
            .insert(legacyRows);
          if (retryErr) throw new Error(`brand_sellers insert: ${retryErr.message}`);
        } else {
          throw new Error(`brand_sellers insert: ${msg}`);
        }
      }
    }

    // Build a seller-key → classification map so per-ASIN
    // is_brand_controlled lines up with the seller-level verdict.
    const classificationByKey = new Map<string, SellerClassification>();
    for (const c of classified) {
      const idKey = c.seller_id ? c.seller_id.toLowerCase() : null;
      const nameKey = c.seller_name?.toLowerCase() ?? null;
      if (idKey) classificationByKey.set(idKey, c.classification);
      if (nameKey) classificationByKey.set(nameKey, c.classification);
    }

    // Phase 31 — compute pre-attribution monthly-units for each ASIN
    // (rank → units lookup, same curves the brand-level estimator uses)
    // and then run variation-aware attribution so per-ASIN persistence
    // already carries the post-attribution numbers. Sibling pallet ASINs
    // sharing a parent listing with active 4-pack/12-pack siblings
    // collapse to ~0 attributed units, and the brand's TTM sum stops
    // double-counting.
    // Phase 34 — Amazon's published "X+ bought in past month" badge
    // (Keepa `monthlySold`) takes precedence over the BSR-curve estimate
    // when present. The curve still acts as a defensive floor via
    // `Math.max` in case Amazon temporarily strips the badge from a
    // high-velocity ASIN. Per-row `units_source` is captured for
    // diagnostics / log-line summaries.
    type UnitsSource =
      | "keepa_monthly_sold"
      | "bsr_curve"
      | "keepa_monthly_sold_floored"
      | "none";
    const unitsSourceByAsin = new Map<string, UnitsSource>();
    let withMonthlySoldCount = 0;
    let monthlySoldTotal = 0;
    let curveTotal = 0;
    const attributionInputs = products.map((p) => {
      const rank = p.sales_rank_avg365 ?? p.sales_rank_current ?? null;
      const categoryPath = p.category_tree?.map((c) => c.name).join(" > ") ?? null;
      const fromKeepa = p.monthly_sold ?? null;
      const fromCurve = rankToMonthlyUnits(rank, p.product_group ?? null, categoryPath);
      const raw =
        fromKeepa != null ? Math.max(fromKeepa, fromCurve ?? 0) : fromCurve;
      let source: UnitsSource;
      if (fromKeepa != null) {
        withMonthlySoldCount += 1;
        monthlySoldTotal += fromKeepa;
        source =
          fromCurve != null && fromCurve > fromKeepa
            ? "keepa_monthly_sold_floored"
            : "keepa_monthly_sold";
      } else if (fromCurve != null) {
        source = "bsr_curve";
      } else {
        source = "none";
      }
      if (fromCurve != null) curveTotal += fromCurve;
      unitsSourceByAsin.set(p.asin, source);
      return {
        asin: p.asin,
        parent_asin: p.parent_asin ?? null,
        raw_monthly_units: raw,
        // Without paying for full review history, total review_count is
        // the best free proxy for "is this variation actually selling".
        // Pallet/dead variations carry near-zero reviews; active 4-pack
        // / 12-pack siblings carry hundreds. The brief allows this
        // fallback explicitly.
        recent_review_count: p.review_count ?? null,
        // Phase 32 — sharper attribution signal: Buy Box winner churn
        // in the last 90 days. Combined with reviews via blend weights.
        buy_box_change_count_90d: p.buy_box_change_count_90d ?? null,
        // Phase 36 — Amazon's per-ASIN published monthlySold badge.
        // When non-null, attributeVariationSales bypasses the
        // re-attribution split for this sibling (Phase 32.1 zero-signal
        // still wins for parent shells / dormant pallets).
        keepa_monthly_sold: p.monthly_sold ?? null,
      };
    });
    const attribution = indexAttributionByAsin(
      attributeVariationSales(attributionInputs),
    );

    // Phase 34 — diagnostic summary: how many ASINs received a Keepa
    // `monthlySold` value, and how the totals stack up vs the curve-only
    // estimate. Intentionally pre-attribution so it reflects the raw
    // signal Keepa published (not the post-variation-weighting result).
    const blendedTotal = attributionInputs.reduce(
      (a, r) => a + (r.raw_monthly_units ?? 0),
      0,
    );
    console.log(
      `[phase34] units derivation — brand="${brand_name}", ` +
        `asins_total=${products.length}, ` +
        `with_monthly_sold=${withMonthlySoldCount}, ` +
        `monthly_sold_total_units=${monthlySoldTotal}, ` +
        `curve_total_units=${curveTotal}, ` +
        `blended_total_units=${blendedTotal}`,
    );

    // Upsert brand_asins. is_brand_controlled is derived from the
    // already-classified seller list (resolved name + Jaccard / LLM
    // signals) rather than a raw substring match against
    // p.buy_box_seller, which can be a Keepa seller-id pre-resolution.
    const asinRows = products.map((p) => {
      const idKey = p.buy_box_seller_id?.toLowerCase() ?? null;
      const nameKey = p.buy_box_seller?.toLowerCase() ?? null;
      const cls =
        (idKey ? classificationByKey.get(idKey) : undefined) ??
        (nameKey ? classificationByKey.get(nameKey) : undefined);
      const isBrand = cls
        ? cls.is_brand_controlled
        : isBrandControlled(p.buy_box_seller, brand_name);
      const att = attribution.get(p.asin) ?? null;
      return {
        brand_id,
        asin: p.asin,
        title: p.title ?? null,
        buy_box_seller: p.buy_box_seller ?? null,
        buy_box_price: p.buy_box_price ?? null,
        offers_count: p.total_offers_count ?? 0,
        fba_offers_count: p.fba_offers_count ?? 0,
        is_brand_controlled: isBrand,
        last_checked_at: new Date().toISOString(),
        // Phase 31/32 — variation attribution.
        parent_asin: att?.parent_asin ?? p.parent_asin ?? null,
        variation_group_size: att?.variation_group_size ?? 1,
        variation_weight: att?.variation_weight ?? 1,
        recent_review_count: p.review_count ?? null,
        buy_box_change_count_90d: p.buy_box_change_count_90d ?? null,
        raw_monthly_units: att?.raw_monthly_units ?? null,
        attributed_monthly_units: att?.attributed_monthly_units ?? null,
        // Phase 34 — Amazon-published monthly_sold badge (or null).
        keepa_monthly_sold: p.monthly_sold ?? null,
      };
    });

    if (asinRows.length) {
      const { error: upErr } = await supabase
        .from("brand_asins")
        .upsert(asinRows, { onConflict: "brand_id,asin" });
      if (upErr) {
        // Pre-migration soft fall back: retry without the new
        // variation-attribution columns so older environments don't
        // block the whole enrichment run on a missing column.
        const msg = upErr.message ?? "";
        const looksLikeMissingColumn = /column .* does not exist|parent_asin|variation_group_size|variation_weight|recent_review_count|buy_box_change_count_90d|raw_monthly_units|attributed_monthly_units|keepa_monthly_sold/i.test(msg);
        if (looksLikeMissingColumn) {
          console.warn(
            `[keepa-brand] brand_asins upsert with variation columns failed (${msg}); retrying without them.`,
          );
          const legacyRows = asinRows.map(({
            parent_asin: _p,
            variation_group_size: _gs,
            variation_weight: _w,
            recent_review_count: _rr,
            buy_box_change_count_90d: _bb,
            raw_monthly_units: _rm,
            attributed_monthly_units: _am,
            keepa_monthly_sold: _km,
            ...rest
          }) => rest);
          const { error: retryErr } = await supabase
            .from("brand_asins")
            .upsert(legacyRows, { onConflict: "brand_id,asin" });
          if (retryErr) throw new Error(`brand_asins upsert: ${retryErr.message}`);
        } else {
          throw new Error(`brand_asins upsert: ${msg}`);
        }
      }
    }

    // Brand-level summary
    const asin_count = products.length;
    const unique_seller_count = sellerMap.size;
    const totalOffers = products.reduce((a, p) => a + (p.total_offers_count ?? 0), 0);
    const avg_offers = asin_count ? totalOffers / asin_count : null;

    // Brand-controlled share is now derived from the classified seller
    // list (weighted by share_pct, falling back to asins_won) instead
    // of a per-ASIN exact-string match against the buy-box winner.
    const brand_controlled_pct = aggregateBrandControlledShare(classified);

    // Top reseller = the classified-as-reseller seller with the largest
    // share. The dossier and cover hero want the actionable outsider,
    // not the brand's own LLC (Fantaswick LLC) sitting at the top.
    const resellersSorted = classified
      .filter((s) => !s.classification.is_brand_controlled)
      .sort((a, b) => (b.asins_won ?? 0) - (a.asins_won ?? 0));
    const topReseller = resellersSorted[0] ?? null;
    const top_seller = topReseller?.seller_name ?? null;
    const top_seller_share_pct = topReseller?.share_pct ?? null;
    const top_seller_country = topReseller?.seller_country ?? null;

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

    // Amazon-1P share — what fraction of buy boxes is Amazon retail
    // (ATVPDKIKX0DER) winning? Computed from products (winner buyer)
    // for stability against the seller-aggregation step.
    const amazon1pShare = asin_count ? amazonOnesP / asin_count : 0;

    const nextTags = new Set(existingTags);
    // Phase 23 — if Amazon retail holds >= AMAZON_1P_THRESHOLD_PCT of
    // buy boxes, the brand has a wholesale (1P) relationship with
    // Amazon. RCG's reseller-removal play doesn't apply, so the report
    // should short-circuit to a "not a fit" page. Threshold is
    // configurable via AMAZON_1P_THRESHOLD_PCT (default 0.10).
    const amazon1pDisqualified = isAmazon1pBrand(amazon1pShare);
    if (amazon1pDisqualified) {
      nextTags.add("amazon_1p");
      // Keep the legacy ≥50% tag for downstream review consumers.
      if (amazon1pShare > 0.5) nextTags.add("amazon_1p_vendor");
    } else if (amazon1pShare > 0.5) {
      nextTags.add("amazon_1p_vendor");
    }
    console.log(
      `[keepa-brand] "${brand_name}" classification: brand_controlled_pct=${brand_controlled_pct?.toFixed(3) ?? "null"} ` +
      `amazon_1p_share=${amazon1pShare.toFixed(3)} (threshold=${amazon1pThreshold().toFixed(2)}, disqualified=${amazon1pDisqualified}) ` +
      `top_reseller="${top_seller ?? "—"}" (${top_seller_share_pct?.toFixed(3) ?? "null"})`,
    );

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
      amazon_1p_disqualified: amazon1pDisqualified,
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
