/**
 * Report generation orchestrator.
 *
 * Phase 8 — Audit v2 is the active path. The generator runs mandatory
 * pre-generation enrichment (Keepa + DataForSEO + competitor benchmark),
 * assembles the v2 narrative_json, renders the v2 PDF, uploads it, and
 * marks the row 'completed'. If any step fails the row goes 'failed'
 * with a specific error message — never half-empty success.
 */
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { BrandForReport } from "./narrative";
import { uploadReportPdf } from "./storage";
import { runV2Enrichment, EnrichmentStepError, type BrandRowMin } from "./v2/enrich";
import { assembleV2 } from "./v2/assemble";
import { renderAuditPdfV2 } from "./v2/pdf";

const FALLBACK_CONTACT = "contact@rolleconsulting.com";

export interface GenerateInput {
  reportId: string;
  userId: string;
  brandId: string;
  contactEmail?: string | null;
}

function logStep(reportId: string, step: string, startedAt: number, extra?: Record<string, unknown>) {
  const ms = Date.now() - startedAt;
  console.log("[report.generate]", { reportId, step, ms, ...(extra ?? {}) });
}

export async function generateAuditReport(input: GenerateInput): Promise<void> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    const msg = "SUPABASE_SERVICE_ROLE_KEY missing — required to run report generation";
    console.error("[report.generate] failed", { reportId: input.reportId, step: "init", error: msg });
    throw new Error(msg);
  }

  const { reportId, userId, brandId } = input;
  let currentStep = "init";
  try {
    // 1. Load brand row.
    currentStep = "load_brand";
    let t = Date.now();
    const { data: brand, error: brandErr } = await admin
      .from("brands")
      .select("*")
      .eq("id", brandId)
      .eq("user_id", userId)
      .maybeSingle();
    if (brandErr) throw new Error(`brand lookup failed: ${brandErr.message}`);
    if (!brand) throw new Error("brand not found");
    logStep(reportId, currentStep, t);

    const brandTyped = brand as BrandForReport & BrandRowMin;

    // 2. Mandatory pre-generation enrichment (Keepa + DataForSEO +
    // competitor benchmark). Throws EnrichmentStepError on hard failure.
    currentStep = "enrich";
    t = Date.now();
    const enrichResult = await runV2Enrichment(admin, {
      id: brandTyped.id,
      name: brandTyped.name,
      user_id: userId,
      category: brandTyped.category,
      keepa_last_enriched_at: brandTyped.keepa_last_enriched_at ?? null,
      dataforseo_last_enriched_at: brandTyped.dataforseo_last_enriched_at ?? null,
    });
    logStep(reportId, currentStep, t, {
      keepa: !!enrichResult.bundle.keepa.last_enriched_at,
      dfs: !!enrichResult.bundle.dataforseo.captured_at,
      competitors: enrichResult.competitorSnapshots.length,
    });

    // Phase 23 — Amazon-1P disqualifier short-circuit. If Amazon retail
    // (ATVPDKIKX0DER) holds ≥ AMAZON_1P_THRESHOLD_PCT of buy boxes,
    // RCG's reseller-removal play doesn't apply (Amazon IS the channel
    // via 1P / Vendor Central). We flip the report to status='not_a_fit'
    // with a minimal narrative; the public page renders a clean
    // "different conversation" state instead of fake "not measured"
    // placeholders. Re-read the brand row so we observe any disqualifier
    // tags applied during enrichment.
    {
      const { data: postBrand } = await admin
        .from("brands")
        .select("disqualifier_tags")
        .eq("id", brandId)
        .maybeSingle();
      const tags: string[] = Array.isArray(postBrand?.disqualifier_tags)
        ? (postBrand!.disqualifier_tags as string[])
        : [];
      if (tags.includes("amazon_1p")) {
        // Approximate amazon share from Keepa-stamped brand_sellers — the
        // exact value already drove the tag in enrichBrandWithKeepa, but
        // surfacing it on the report aids debugging and copy.
        let amazonShare: number | null = null;
        try {
          const { data: sellers } = await admin
            .from("brand_sellers")
            .select("seller_id, share_pct")
            .eq("brand_id", brandId);
          const total = (sellers ?? []).reduce(
            (a, s) => a + (typeof s.share_pct === "number" ? s.share_pct : 0),
            0,
          );
          const amzn = (sellers ?? [])
            .filter((s) => s.seller_id === "ATVPDKIKX0DER")
            .reduce((a, s) => a + (typeof s.share_pct === "number" ? s.share_pct : 0), 0);
          if (total > 0) amazonShare = amzn / total;
        } catch {
          // soft fail — share is best-effort
        }
        await markReportNotAFit(admin, {
          reportId,
          brandName: brandTyped.name,
          brandId: brandTyped.id,
          generatedAt: new Date(),
          amazon1pShare: amazonShare,
        });
        console.log("[report.generate] short-circuited as not_a_fit (amazon_1p)", {
          reportId,
          brandId,
          amazon1pShare: amazonShare,
        });
        return;
      }
    }

    // 3. Assemble v2 narrative + per-section LLM calls.
    currentStep = "assemble_narrative";
    t = Date.now();
    const generatedAt = new Date();
    const contactEmail = (input.contactEmail || "").trim() || FALLBACK_CONTACT;
    const calendlyUrl = process.env.RCG_CALENDLY_URL || "https://calendly.com/steve-rollemanagementgroup/intro";
    const assembled = await assembleV2({
      brand: brandTyped,
      bundle: enrichResult.bundle,
      competitors: enrichResult.competitorSnapshots,
      contactEmail,
      calendlyUrl,
      generatedAt,
      asinDetails: enrichResult.asinDetails,
      revenueEstimate: enrichResult.revenueEstimate,
      spApiTrailing: enrichResult.spApiTrailing,
      productCategoryHints: enrichResult.productCategoryHints,
      auditScope: enrichResult.auditScope,
    });
    logStep(reportId, currentStep, t);

    // 4. PDF render.
    currentStep = "render_pdf";
    t = Date.now();
    const buffer = await renderAuditPdfV2({
      brand: brandTyped,
      narrative: assembled.narrative,
    });
    logStep(reportId, currentStep, t, { bytes: buffer.length });

    // 5. Upload + sign.
    currentStep = "upload_storage";
    t = Date.now();
    const { path, signedUrl } = await uploadReportPdf({
      userId,
      brandId,
      reportId,
      buffer,
    });
    logStep(reportId, currentStep, t, { path });

    // 6. Mark complete.
    currentStep = "finalize_row";
    t = Date.now();
    const { error: updErr } = await admin
      .from("reports")
      .update({
        status: "completed",
        pdf_storage_path: path,
        pdf_public_url: signedUrl,
        narrative_json: assembled.narrative as unknown as Record<string, unknown>,
        report_assumptions: assembled.assumptions as unknown as Record<string, unknown>,
        reseller_dossier: assembled.resellerDossierJson as unknown as Record<string, unknown> | null,
        competitor_benchmark: assembled.competitorBenchmarkJson as unknown as Record<string, unknown>,
        cx_audit: assembled.cxAuditJson as unknown as Record<string, unknown>,
        data_sources: assembled.narrative.data_sources as unknown as Record<string, unknown>,
        generated_at: generatedAt.toISOString(),
        title: `${brandTyped.name} — Channel Ownership Audit`,
        error_message: null,
      })
      .eq("id", reportId);
    if (updErr) throw new Error(`report update failed: ${updErr.message}`);
    logStep(reportId, currentStep, t);

    console.log("[report.generate] completed", { reportId });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const stepLabel = err instanceof EnrichmentStepError ? err.step : currentStep;
    console.error("[report.generate] failed", {
      reportId,
      step: stepLabel,
      error: err.message,
      stack: err.stack,
    });
    try {
      await admin
        .from("reports")
        .update({
          status: "failed",
          error_message: `[${stepLabel}] ${err.message}`.slice(0, 1000),
        })
        .eq("id", reportId);
    } catch (persistErr) {
      console.error("[report.generate] failed to persist failure state", {
        reportId,
        error: persistErr instanceof Error ? persistErr.message : String(persistErr),
      });
    }
    throw err;
  }
}

/**
 * Phase 23 — Amazon-1P short-circuit. When Amazon retail owns ≥10% of
 * buy boxes the brand is in a wholesale (1P) relationship with Amazon
 * and the reseller-removal play doesn't apply. We persist a minimal
 * `not_a_fit` narrative so the public page can render an intentional
 * "different conversation" state instead of a half-empty audit.
 *
 * Status `not_a_fit` is distinct from `failed` — the recovery cron
 * (which only picks `generating`) will not retry it.
 */
async function markReportNotAFit(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  args: {
    reportId: string;
    brandId: string;
    brandName: string;
    generatedAt: Date;
    amazon1pShare: number | null;
  },
): Promise<void> {
  if (!admin) return;
  const sharePct =
    args.amazon1pShare != null ? Math.round(args.amazon1pShare * 100) : null;
  const narrative = {
    version: 2 as const,
    kind: "not_a_fit",
    reason: "amazon_1p" as const,
    generated_at: args.generatedAt.toISOString(),
    brand_id: args.brandId,
    brand_name: args.brandName,
    headline: "Amazon is your top seller — that's a different conversation.",
    explainer:
      `Our buy-box scan shows Amazon Retail (the ATVPDKIKX0DER seller) ` +
      `${sharePct != null ? `holding ${sharePct}% of ${args.brandName}'s buy boxes` : `holding a meaningful share of ${args.brandName}'s buy boxes`}. ` +
      "When Amazon itself is the channel — not third-party resellers riding on top of it — the playbook changes. " +
      "RCG's reseller-removal motion captures margin from outside resellers; here, that margin is already inside an Amazon 1P (Vendor Central) relationship. " +
      "We can still help: the conversation shifts to Vendor vs Seller Central tradeoffs, terms negotiation, and protecting unit economics under 1P.",
    cta: {
      headline: "Book a 30-minute call about your Vendor Central setup.",
      primary_cta_url:
        process.env.RCG_CALENDLY_URL ||
        "https://calendly.com/steve-rollemanagementgroup/intro",
      primary_cta_label: "Book a strategy call",
      secondary_email: "steve@rollemanagementgroup.com",
    },
    amazon_1p_share: args.amazon1pShare,
  };

  const { error } = await admin
    .from("reports")
    .update({
      status: "not_a_fit",
      narrative_json: narrative as unknown as Record<string, unknown>,
      generated_at: args.generatedAt.toISOString(),
      title: `${args.brandName} — Amazon 1P (not a fit)`,
      error_message: null,
      pdf_storage_path: null,
      pdf_public_url: null,
    })
    .eq("id", args.reportId);
  if (error) throw new Error(`not_a_fit update failed: ${error.message}`);
}
