/**
 * Phase 20 — temporary admin endpoint to re-run the FULL enrichment
 * pipeline (CX scorecard, keywords, competitors, A+/video, branded
 * trend, ASIN-level $$$ fields) for an existing report and persist the
 * recomputed sub-narratives, WITHOUT disturbing the cover/math/plan
 * fields that Phase 19 already backfilled.
 *
 * Auth: x-internal-token must match INTERNAL_JOB_TOKEN (server env).
 * Body: { report_id: string }
 *
 * Safe to remove after the OXO + Yeti backfill in
 * phase20_full_enrichment_oxo_yeti_brief.md.
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { isKeepaConfigured } from "@/lib/keepa";
import {
  runV2Enrichment,
  type BrandRowMin,
} from "@/lib/report/v2/enrich";
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

function countNotMeasuredAsinFields(narrative: NarrativeV2): {
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

export async function POST(req: Request) {
  const expected = process.env.INTERNAL_JOB_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: "INTERNAL_JOB_TOKEN not set" },
      { status: 500 },
    );
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
    return NextResponse.json(
      { error: `report lookup: ${rErr.message}` },
      { status: 500 },
    );
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

  // 2. Load brand row (full, for BrandForReport fields).
  const { data: brandRow, error: bErr } = await admin
    .from("brands")
    .select("*")
    .eq("id", report.brand_id)
    .maybeSingle();
  if (bErr) {
    return NextResponse.json(
      { error: `brand lookup: ${bErr.message}` },
      { status: 500 },
    );
  }
  if (!brandRow) {
    return NextResponse.json({ error: "brand not found" }, { status: 404 });
  }
  const brand = brandRow as BrandForReport & BrandRowMin & { user_id: string };

  // Snapshot before-state for the response.
  const before = countNotMeasuredAsinFields(narrative);

  // 3. Force a fresh enrichment cycle. We bypass freshness windows by
  // null-ing the timestamps so runV2Enrichment will re-pull Keepa + DFS
  // + /product details + competitor snapshots.
  const enrichResult = await runV2Enrichment(admin, {
    id: brand.id,
    name: brand.name,
    user_id: brand.user_id,
    category: brand.category,
    keepa_last_enriched_at: null,
    dataforseo_last_enriched_at: null,
  });

  // 4. Recompute sub-narratives.
  const reality = computeResellerReality(enrichResult.bundle);
  const dossierBase = computeDossierBase(enrichResult.bundle);
  const cxBase = computeCxAuditBase(
    enrichResult.bundle,
    enrichResult.asinDetails,
    enrichResult.revenueEstimate,
  );
  const benchmarkBase = computeCompetitorBenchmark(
    brand,
    enrichResult.bundle,
    enrichResult.competitorSnapshots,
    cxBase,
  );

  // 5. LLM section calls — fanned out in parallel.
  const [realityLine, dossierRisk, cxBroken, competitorLine] = await Promise.all([
    llmResellerRealityLine(reality, enrichResult.bundle),
    dossierBase.dossier ? llmDossierRisk(dossierBase.dossier, brand) : Promise.resolve(""),
    llmCxBroken(cxBase, brand),
    llmCompetitorLine(benchmarkBase, brand),
  ]);

  const finalReality: NarrativeResellerReality = {
    ...reality,
    one_liner: realityLine,
    note: reality.top_sellers.length === 0 ? "Keepa returned no sellers for this brand." : null,
  };

  // Preserve the existing dossier when the fresh compute returns null
  // (e.g. fresh run sees < 20% top-seller share but the report's
  // existing dossier was richer). Brief: "do NOT re-run dossier unless
  // rows are missing". So we only overwrite when we have a fresh dossier.
  let finalDossier: NarrativeResellerDossier | null = narrative.reseller_dossier ?? null;
  if (dossierBase.dossier) {
    finalDossier = { ...dossierBase.dossier, risk_profile: dossierRisk || "" };
  }

  const finalCx: NarrativeCxAudit = { ...cxBase, whats_broken: cxBroken };

  const finalBenchmark: NarrativeCompetitorBenchmark = {
    ...benchmarkBase,
    one_liner: competitorLine,
  };

  // 6. Compose updated narrative — preserve cover, math, plan, why_rcg,
  // cta from the existing narrative (Phase 19 cover; v2.1 plan).
  const updatedNarrative: NarrativeV2 = {
    ...narrative,
    reseller_reality: finalReality,
    reseller_dossier: finalDossier,
    cx_audit: finalCx,
    competitor_benchmark: finalBenchmark,
    data_sources: {
      ...narrative.data_sources,
      keepa:
        (enrichResult.bundle.keepa.asin_count ?? 0) > 0 ||
        (enrichResult.bundle.keepa.sellers?.length ?? 0) > 0,
      keepa_freshness: enrichResult.bundle.keepa.last_enriched_at,
      dataforseo:
        (enrichResult.bundle.dataforseo?.top_keywords?.length ?? 0) > 0 ||
        (enrichResult.bundle.dataforseo?.competitor_brands?.length ?? 0) > 0,
      dataforseo_freshness: enrichResult.bundle.dataforseo?.captured_at ?? null,
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

  // 7. Persist — update narrative_json plus the side jsonb columns the
  // generator writes alongside it. Email path is NOT touched.
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
    return NextResponse.json(
      { error: `update: ${updErr.message}` },
      { status: 500 },
    );
  }

  const after = countNotMeasuredAsinFields(updatedNarrative);

  return NextResponse.json({
    ok: true,
    report_id: reportId,
    brand_name: brand.name,
    before,
    after,
    enrichment: {
      keepa_asins: enrichResult.bundle.keepa.asins?.length ?? 0,
      keepa_sellers: enrichResult.bundle.keepa.sellers?.length ?? 0,
      dfs_keywords: enrichResult.bundle.dataforseo?.top_keywords?.length ?? 0,
      dfs_branded_search_volume: enrichResult.bundle.dataforseo?.branded_search_volume ?? null,
      dfs_branded_trend_pct: enrichResult.bundle.dataforseo?.branded_trend_pct ?? null,
      competitors_returned: enrichResult.competitorSnapshots.length,
      asin_details: enrichResult.asinDetails.length,
      revenue_estimate_total: enrichResult.revenueEstimate?.total_ttm_revenue ?? null,
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
