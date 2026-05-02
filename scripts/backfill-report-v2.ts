/**
 * Backfill an existing v2 report after the measurement-gaps rebuild.
 *
 * Re-runs Keepa + DFS enrichment for the report's brand, recomputes the
 * narrative_json with the new revenue estimator + CX scorecard +
 * competitor benchmark, and overwrites the persisted JSON columns.
 * Does NOT re-render the PDF — that happens on next regeneration.
 *
 * Run:
 *   KEEPA_API_KEY=... \
 *   DATAFORSEO_LOGIN=... DATAFORSEO_PASSWORD=... \
 *   NEXT_PUBLIC_SUPABASE_URL=... \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   OPENAI_API_KEY=...   (optional; LLM sections fall back to deterministic copy if missing)
 *   npx tsx scripts/backfill-report-v2.ts <reportId>
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import type { BrandForReport } from "../src/lib/report/narrative";
import { runV2Enrichment, type BrandRowMin } from "../src/lib/report/v2/enrich";
import { assembleV2 } from "../src/lib/report/v2/assemble";

const FALLBACK_CONTACT = "contact@rolleconsulting.com";

async function main() {
  const reportId = process.argv[2];
  if (!reportId) {
    console.error("usage: backfill-report-v2.ts <reportId>");
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: report, error: repErr } = await admin
    .from("reports")
    .select("*")
    .eq("id", reportId)
    .maybeSingle();
  if (repErr) throw new Error(`report lookup: ${repErr.message}`);
  if (!report) {
    console.error("report not found");
    process.exit(1);
  }

  const { data: brand, error: brandErr } = await admin
    .from("brands")
    .select("*")
    .eq("id", report.brand_id)
    .maybeSingle();
  if (brandErr) throw new Error(`brand lookup: ${brandErr.message}`);
  if (!brand) {
    console.error("brand not found");
    process.exit(1);
  }
  console.log(`[backfill] report=${reportId} brand="${(brand as any).name}" id=${brand.id}`);

  // Reset enrichment freshness so runV2Enrichment will re-pull Keepa + DFS
  // with the new code paths (otherwise the existing 14-day fresh window
  // skips the providers and the backfill is a no-op for the live numbers).
  console.log("[backfill] resetting freshness flags so enrichment re-runs");
  const { error: resetErr } = await admin
    .from("brands")
    .update({
      keepa_last_enriched_at: null,
      dataforseo_last_enriched_at: null,
    })
    .eq("id", brand.id);
  if (resetErr) console.warn("[backfill] freshness reset failed:", resetErr.message);

  const brandTyped = brand as BrandForReport & BrandRowMin;
  const brandRowMin: BrandRowMin = {
    id: brandTyped.id,
    name: brandTyped.name,
    user_id: report.user_id,
    category: brandTyped.category ?? null,
    keepa_last_enriched_at: null,
    dataforseo_last_enriched_at: null,
  };

  console.log("[backfill] running v2 enrichment (Keepa + Keepa /product + DFS + competitors)…");
  const enrich = await runV2Enrichment(admin, brandRowMin);

  console.log("[backfill] revenue estimate:", JSON.stringify({
    total_ttm_revenue: enrich.revenueEstimate?.total_ttm_revenue,
    asins_in_sum: enrich.revenueEstimate?.asins_in_sum,
    asins_excluded: enrich.revenueEstimate?.asins_excluded,
    source: enrich.revenueEstimate?.source_note,
  }, null, 2));
  if (enrich.spApiTrailing) {
    console.log("[backfill] SP-API override ACTIVE:", JSON.stringify({
      trailing_12mo_revenue: enrich.spApiTrailing.trailing_12mo_revenue,
      asins: enrich.spApiTrailing.asins.length,
      source: enrich.spApiTrailing.source_note,
    }, null, 2));
  }
  if (enrich.revenueEstimate?.per_asin) {
    const tiers = new Map<string, number>();
    for (const a of enrich.revenueEstimate.per_asin) {
      const k = a.velocity_tier ?? "n/a";
      tiers.set(k, (tiers.get(k) ?? 0) + 1);
    }
    console.log("[backfill] velocity tier breakdown:", JSON.stringify(Object.fromEntries(tiers)));
    const top = enrich.revenueEstimate.per_asin
      .filter((a) => a.ttm_revenue != null)
      .sort((a, b) => (b.ttm_revenue ?? 0) - (a.ttm_revenue ?? 0))
      .slice(0, 8);
    console.log("[backfill] top revenue ASINs:");
    for (const a of top) {
      console.log(
        `  ${a.asin} rank=${a.sales_rank} price=$${a.buy_box_price?.toFixed(2)} tier=${a.velocity_tier} units/mo=${a.monthly_units} ttm=$${a.ttm_revenue?.toLocaleString("en-US")}`,
      );
    }
  }
  console.log(`[backfill] asin_details=${enrich.asinDetails.length} competitor_snapshots=${enrich.competitorSnapshots.length} category_hints=${enrich.productCategoryHints.join(", ") || "(none)"}`);

  console.log("[backfill] assembling v2 narrative_json…");
  const generatedAt = new Date();
  const calendlyUrl = process.env.RCG_CALENDLY_URL || "https://calendly.com/steve-rollemanagementgroup/intro";
  const contactEmail =
    (typeof (report as any).contact_email === "string" && (report as any).contact_email.trim()) ||
    FALLBACK_CONTACT;

  const assembled = await assembleV2({
    brand: brandTyped,
    bundle: enrich.bundle,
    competitors: enrich.competitorSnapshots,
    brandLogoUrl: enrich.brandLogoUrl,
    contactEmail,
    calendlyUrl,
    generatedAt,
    asinDetails: enrich.asinDetails,
    revenueEstimate: enrich.revenueEstimate,
    spApiTrailing: enrich.spApiTrailing,
    productCategoryHints: enrich.productCategoryHints,
  });

  // Console-summarize the math table so the operator can sanity-check
  // before clicking through to the live URL.
  console.log("[backfill] math lines:");
  for (const l of assembled.narrative.math.lines) {
    console.log(
      `  ${l.key.padEnd(18)} ${String(l.value ?? "—").padStart(14)}  (${l.source})`,
    );
  }
  console.log("[backfill] cx asin_scores:");
  for (const s of assembled.narrative.cx_audit.asin_scores) {
    console.log(
      `  ${s.asin}  score=${s.score}  rating=${s.rating}  reviews=${s.reviews}  images=${s.images}  bullets=${s.bullets}  a+=${s.has_a_plus}  video=${s.has_video}`,
    );
  }
  console.log("[backfill] competitor_benchmark.rows:");
  for (const r of assembled.narrative.competitor_benchmark.rows) {
    console.log(
      `  ${r.is_audited_brand ? "*" : " "} ${r.brand}  brand_pct=${r.brand_controlled_pct}  branded_vol=${r.branded_search_volume}  sellers=${r.unique_seller_count}`,
    );
  }
  console.log("[backfill] competitor one_liner:", assembled.narrative.competitor_benchmark.one_liner);
  console.log("[backfill] cx top_keywords:", assembled.narrative.cx_audit.top_keywords.length);
  console.log("[backfill] branded_trend_pct:", assembled.narrative.cx_audit.branded_trend_pct);

  console.log("[backfill] persisting updated jsonb columns on reports…");
  const { error: updErr } = await admin
    .from("reports")
    .update({
      narrative_json: assembled.narrative as any,
      report_assumptions: assembled.assumptions as any,
      reseller_dossier: assembled.resellerDossierJson as any,
      competitor_benchmark: assembled.competitorBenchmarkJson as any,
      cx_audit: assembled.cxAuditJson as any,
      data_sources: assembled.narrative.data_sources as any,
    })
    .eq("id", reportId);
  if (updErr) throw new Error(`reports update: ${updErr.message}`);

  console.log("[backfill] done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
