/**
 * Phase 20 — temporary admin endpoint to refresh the enrichment-derived
 * subtrees of an existing v2 report's narrative_json (CX scorecard,
 * keywords, competitors, A+/video, branded trend, ASIN-level $$$).
 *
 * Strategy: lightweight surgical re-compute, NOT a full Keepa/DFS
 * re-enrichment. We rely on the bundle that is already cached on
 * `brands` + `brand_asins` + `brand_sellers` + `brand_search_metrics`
 * (these were populated when the report was originally generated, and
 * the underlying upstream calls are still gated by 14-day freshness
 * windows the cron path would respect anyway).
 *
 * What this endpoint does:
 *   1. Pulls Keepa /product details for every ASIN already on the
 *      brand — supplies has_a_plus / has_video / rating / reviews /
 *      images / bullets, plus inputs to the per-ASIN revenue estimator.
 *   2. Recomputes CX scorecard + per-ASIN ttm_revenue/units.
 *   3. Recomputes reseller reality + dossier from the existing bundle.
 *   4. Pulls competitor snapshots from the cross-user
 *      `competitor_brands_cache` table (no network) to rebuild a real
 *      competitor benchmark — replaces any "XYZ Corp" hallucinated rows.
 *   5. Reruns the LLM section calls (reseller line, dossier risk, CX
 *      callouts, competitor line).
 *   6. Persists the recomputed subtrees back, preserving cover / math /
 *      plan / why_rcg / cta from the existing narrative (Phase 19).
 *
 * Auth: x-internal-token must match INTERNAL_JOB_TOKEN (server env).
 * Body: { report_id: string }
 *
 * Safe to remove after the OXO + Yeti backfill in
 * phase20_full_enrichment_oxo_yeti_brief.md.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { getProductDetails, isKeepaConfigured } from "@/lib/keepa";
import {
  getBrandEnrichmentBundle,
  type BrandEnrichmentBundle,
} from "@/lib/enrichment";
import {
  estimateBrandTtmRevenue,
  type RevenueEstimate,
} from "@/lib/enrichment/revenue-estimator";
import type { CompetitorSnapshot, KeepaAsinDetail } from "@/lib/report/v2/enrich";
import {
  computeCompetitorBenchmark,
  computeCxAuditBase,
  computeDossierBase,
  computeResellerReality,
} from "@/lib/report/v2/compute";
import {
  llmCompetitorLine,
  llmCxBroken,
  llmDossierRisk,
  llmResellerRealityLine,
} from "@/lib/report/v2/narrative";
import type { BrandForReport } from "@/lib/report/narrative";
import type {
  NarrativeCompetitorBenchmark,
  NarrativeCxAudit,
  NarrativeResellerDossier,
  NarrativeResellerReality,
  NarrativeV2,
} from "@/lib/report/v2/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface Body {
  report_id?: string;
}

function countNotMeasured(narrative: NarrativeV2): {
  asin_ttm_revenue_missing: number;
  asin_ttm_units_missing: number;
  asin_total: number;
  branded_trend_missing: boolean;
  branded_search_missing: boolean;
  competitors_real: number;
  cx_a_plus_null: number;
  cx_video_null: number;
  cx_rating_null: number;
  cx_reviews_null: number;
  cx_images_null: number;
  cx_bullets_null: number;
} {
  const cx = narrative.cx_audit;
  const asins = cx?.asin_scores ?? [];
  return {
    asin_ttm_revenue_missing: asins.filter((a) => a.ttm_revenue == null).length,
    asin_ttm_units_missing: asins.filter((a) => a.ttm_units == null).length,
    asin_total: asins.length,
    branded_trend_missing: cx?.branded_trend_pct == null,
    branded_search_missing: cx?.branded_search_volume == null,
    competitors_real:
      narrative.competitor_benchmark?.rows.filter(
        (r) => !r.is_audited_brand,
      ).length ?? 0,
    cx_a_plus_null: asins.filter((a) => a.has_a_plus == null).length,
    cx_video_null: asins.filter((a) => a.has_video == null).length,
    cx_rating_null: asins.filter((a) => a.rating == null).length,
    cx_reviews_null: asins.filter((a) => a.reviews == null).length,
    cx_images_null: asins.filter((a) => a.images == null).length,
    cx_bullets_null: asins.filter((a) => a.bullets == null).length,
  };
}

async function loadCachedCompetitorSnapshots(
  admin: SupabaseClient<any, any, any>,
  bundle: BrandEnrichmentBundle,
  brandName: string,
): Promise<CompetitorSnapshot[]> {
  const candidates = new Set<string>();
  for (const c of bundle.dataforseo?.competitor_brands ?? []) {
    if (c.brand && c.brand.toLowerCase() !== brandName.toLowerCase()) {
      candidates.add(c.brand);
    }
  }
  if (!candidates.size) return [];

  const norms = Array.from(candidates).map((b) => b.toLowerCase().trim());
  const { data, error } = await admin
    .from("competitor_brands_cache")
    .select("payload, expires_at, display_name, brand_name_norm")
    .in("brand_name_norm", norms);
  if (error || !data) return [];

  const out: CompetitorSnapshot[] = [];
  for (const row of data) {
    if (new Date(row.expires_at).getTime() < Date.now()) continue;
    const cached = row.payload as Record<string, unknown> | null;
    if (!cached || typeof cached !== "object") continue;
    const v = (cached as { __v?: number }).__v;
    if (v !== 2) continue; // only current shape
    const { __v: _v, ...rest } = cached as { __v: number } & Record<string, unknown>;
    const snap = rest as unknown as CompetitorSnapshot;
    if ((snap.enriched_asin_count ?? 0) >= 2) {
      out.push(snap);
    }
    if (out.length >= 3) break;
  }
  return out;
}

export async function POST(req: Request) {
  const expected = process.env.INTERNAL_JOB_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: "INTERNAL_JOB_TOKEN not set" }, { status: 500 });
  }
  const tok = req.headers.get("x-internal-token");
  if (tok !== expected) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!isKeepaConfigured()) {
    return NextResponse.json({ error: "KEEPA_API_KEY missing" }, { status: 500 });
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY not set" },
      { status: 500 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const reportId = (body.report_id ?? "").trim();
  if (!reportId) {
    return NextResponse.json({ error: "report_id required" }, { status: 400 });
  }

  // 1. Load report.
  const { data: reportRow, error: rErr } = await admin
    .from("reports")
    .select("id, brand_id, narrative_json")
    .eq("id", reportId)
    .maybeSingle();
  if (rErr) {
    return NextResponse.json({ error: `report lookup: ${rErr.message}` }, { status: 500 });
  }
  if (!reportRow) {
    return NextResponse.json({ error: "report not found" }, { status: 404 });
  }
  const report = reportRow as { id: string; brand_id: string | null; narrative_json: NarrativeV2 | null };
  const narrative = report.narrative_json;
  if (!narrative || (narrative as { version?: number }).version !== 2) {
    return NextResponse.json({ error: "report is not v2 narrative" }, { status: 400 });
  }
  if (!report.brand_id) {
    return NextResponse.json({ error: "report has no brand_id" }, { status: 400 });
  }

  // 2. Load brand row (full).
  const { data: brandRow, error: bErr } = await admin
    .from("brands")
    .select("*")
    .eq("id", report.brand_id)
    .maybeSingle();
  if (bErr) {
    return NextResponse.json({ error: `brand lookup: ${bErr.message}` }, { status: 500 });
  }
  if (!brandRow) {
    return NextResponse.json({ error: "brand not found" }, { status: 404 });
  }
  const brand = brandRow as BrandForReport & { user_id: string };

  // 3. Load existing bundle (Keepa + DFS — already populated when report
  // was generated; this is a cheap DB read).
  const bundle = await getBrandEnrichmentBundle(admin, brand.id);
  if (!bundle) {
    return NextResponse.json({ error: "bundle is null" }, { status: 500 });
  }

  const before = countNotMeasured(narrative);

  // 4. Pull /product details for the brand's existing ASINs. We cap at
  // the top 20 ASINs (by offers_count desc — that's how the bundle is
  // already sorted) because:
  //   • the rendered report only shows the top 10 ASIN cards
  //   • Keepa's token bucket can stall a 50-ASIN backfill past Vercel's
  //     300s ceiling
  // 20 ASINs in a single /product call costs ~100 tokens and one HTTP
  // round-trip — comfortable margin under the timeout.
  const ASIN_CAP = 10;
  const asins = (bundle.keepa.asins ?? [])
    .map((a) => a.asin)
    .filter(Boolean)
    .slice(0, ASIN_CAP);
  let asinDetails: KeepaAsinDetail[] = [];
  let revenueEstimate: RevenueEstimate | null = null;
  // Race the Keepa fetch against a soft deadline so we always have time
  // to do the LLM calls + DB persist + return a useful response. If we
  // run out of time, we fall back to whatever was already in the
  // existing bundle for the CX scorecard (per-ASIN $$$ stays missing,
  // but at least the response is observable).
  const KEEPA_DEADLINE_MS = 240_000; // 4 minutes
  let keepaTimedOut = false;
  if (asins.length) {
    const products = await Promise.race<
      Awaited<ReturnType<typeof getProductDetails>>
    >([
      getProductDetails(asins, ASIN_CAP),
      new Promise<Awaited<ReturnType<typeof getProductDetails>>>((resolve) =>
        setTimeout(() => {
          keepaTimedOut = true;
          resolve([]);
        }, KEEPA_DEADLINE_MS),
      ),
    ]);
    asinDetails = products.map((p) => ({
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
    }));
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
        category_path: p.category_tree?.map((c: { name: string }) => c.name).join(" > ") ?? null,
      })),
    );
  }

  // 5. Competitor snapshots — load from the cross-user cache only. No
  // fresh enrichment here; the cache TTL is 14 days and the cron path
  // already populates it. If empty / expired, the benchmark just shows
  // the audited row alone (which is fine — better than hallucinated
  // competitors).
  const competitorSnapshots = await loadCachedCompetitorSnapshots(
    admin,
    bundle,
    brand.name,
  );

  // 6. Pure compute.
  const reality = computeResellerReality(bundle);
  const dossierBase = computeDossierBase(bundle);
  const cxBase = computeCxAuditBase(bundle, asinDetails, revenueEstimate);
  const benchmarkBase = computeCompetitorBenchmark(
    brand,
    bundle,
    competitorSnapshots,
    cxBase,
  );

  // 7. LLM calls — fanned out in parallel.
  const [realityLine, dossierRisk, cxBroken, competitorLine] = await Promise.all([
    llmResellerRealityLine(reality, bundle),
    dossierBase.dossier ? llmDossierRisk(dossierBase.dossier, brand) : Promise.resolve(""),
    llmCxBroken(cxBase, brand),
    llmCompetitorLine(benchmarkBase, brand),
  ]);

  const finalReality: NarrativeResellerReality = {
    ...reality,
    one_liner: realityLine,
    note: reality.top_sellers.length === 0 ? "Keepa returned no sellers for this brand." : null,
  };

  // Brief: do NOT reset seller dossier (already enriched Phase 10).
  // Preserve existing dossier when fresh compute returns null. Only
  // overwrite when we have a fresh dossier — and even then, keep the
  // existing risk_profile if the LLM call returned an empty string.
  let finalDossier: NarrativeResellerDossier | null = narrative.reseller_dossier ?? null;
  if (dossierBase.dossier) {
    const risk =
      dossierRisk || narrative.reseller_dossier?.risk_profile || "";
    finalDossier = { ...dossierBase.dossier, risk_profile: risk };
  }

  const finalCx: NarrativeCxAudit = { ...cxBase, whats_broken: cxBroken };

  const finalBenchmark: NarrativeCompetitorBenchmark = {
    ...benchmarkBase,
    one_liner: competitorLine,
  };

  // 8. Compose updated narrative — preserve cover, math, plan, why_rcg,
  // cta from the existing narrative (Phase 19 cover; v2.1 plan).
  const updatedNarrative: NarrativeV2 = {
    ...narrative,
    reseller_reality: finalReality,
    reseller_dossier: finalDossier,
    cx_audit: finalCx,
    competitor_benchmark: finalBenchmark,
    data_sources: {
      ...narrative.data_sources,
      keepa: (bundle.keepa.asin_count ?? 0) > 0 || (bundle.keepa.sellers?.length ?? 0) > 0,
      keepa_freshness: bundle.keepa.last_enriched_at,
      dataforseo:
        (bundle.dataforseo?.top_keywords?.length ?? 0) > 0 ||
        (bundle.dataforseo?.competitor_brands?.length ?? 0) > 0,
      dataforseo_freshness: bundle.dataforseo?.captured_at ?? null,
      reseller_dossier: finalDossier !== null,
      competitor_benchmark: benchmarkBase.rows
        .filter((r) => !r.is_audited_brand)
        .some(
          (r) =>
            countNonNull([
              r.unique_seller_count,
              r.brand_controlled_pct,
              r.branded_search_volume,
              r.organic_serp_rank,
              r.listing_health,
            ]) >= 2,
        ),
    },
  };

  // 9. Persist. Email path is NOT touched.
  const { error: updErr } = await admin
    .from("reports")
    .update({
      narrative_json: updatedNarrative as unknown as Record<string, unknown>,
      reseller_dossier: finalDossier as unknown as Record<string, unknown> | null,
      competitor_benchmark: finalBenchmark as unknown as Record<string, unknown>,
      cx_audit: finalCx as unknown as Record<string, unknown>,
      data_sources: updatedNarrative.data_sources as unknown as Record<string, unknown>,
    } as Record<string, unknown>)
    .eq("id", reportId);
  if (updErr) {
    return NextResponse.json({ error: `update: ${updErr.message}` }, { status: 500 });
  }

  const after = countNotMeasured(updatedNarrative);

  return NextResponse.json({
    ok: true,
    report_id: reportId,
    brand_name: brand.name,
    before,
    after,
    enrichment: {
      keepa_asins_in_bundle: bundle.keepa.asins?.length ?? 0,
      keepa_sellers_in_bundle: bundle.keepa.sellers?.length ?? 0,
      dfs_keywords_in_bundle: bundle.dataforseo?.top_keywords?.length ?? 0,
      dfs_branded_search_volume: bundle.dataforseo?.branded_search_volume ?? null,
      dfs_branded_trend_pct: bundle.dataforseo?.branded_trend_pct ?? null,
      cached_competitors_used: competitorSnapshots.length,
      asin_details_pulled: asinDetails.length,
      revenue_estimate_total: revenueEstimate?.total_ttm_revenue ?? null,
      keepa_timed_out: keepaTimedOut,
    },
    cover_preserved: {
      delta_profit: updatedNarrative.cover.delta_profit ?? null,
      exit_lift: updatedNarrative.cover.exit_lift ?? null,
    },
  });
}

function countNonNull(xs: (number | null | undefined)[]): number {
  return xs.filter((x) => x != null).length;
}
