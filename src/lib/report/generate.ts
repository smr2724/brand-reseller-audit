import { createSupabaseAdminClient } from "@/lib/supabase/server";
import {
  getBrandEnrichmentBundle,
  buildDataSourcesProvenance,
  type BrandEnrichmentBundle,
} from "@/lib/enrichment";
import { generateNarrative, type BrandForReport } from "./narrative";
import { renderAuditPdf } from "./pdf";
import { uploadReportPdf } from "./storage";

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

/**
 * Orchestrator: assumes the reports row already exists in 'generating' status.
 * Updates the row to 'completed' on success or 'failed' on error.
 *
 * Reports consume `getBrandEnrichmentBundle` only — never call Keepa or
 * DataForSEO directly from this file.
 */
export async function generateAuditReport(input: GenerateInput): Promise<void> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    // Fail fast and persist so the row never gets stuck in `generating`.
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

    const brandTyped = brand as BrandForReport;

    // 2. Enrichment bundle (best-effort).
    currentStep = "load_enrichment";
    t = Date.now();
    let bundle: BrandEnrichmentBundle | null = null;
    try {
      bundle = await getBrandEnrichmentBundle(admin, brandId);
    } catch (e) {
      console.warn("[report.generate] enrichment bundle fetch failed:", e);
      bundle = null;
    }
    logStep(reportId, currentStep, t, { hasBundle: !!bundle });

    const dataSources = bundle
      ? buildDataSourcesProvenance(bundle)
      : { keepa: false, dataforseo: false, keepa_freshness: null, dataforseo_freshness: null };

    // 3. LLM narrative.
    currentStep = "render_narrative";
    t = Date.now();
    const narrative = await generateNarrative(brandTyped, bundle);
    logStep(reportId, currentStep, t);

    // 4. PDF render.
    currentStep = "render_pdf";
    t = Date.now();
    const generatedAt = new Date();
    const contactEmail = (input.contactEmail || "").trim() || FALLBACK_CONTACT;
    const buffer = await renderAuditPdf({
      brand: brandTyped,
      narrative,
      bundle,
      contactEmail,
      generatedAt,
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
        narrative_json: narrative as unknown as Record<string, unknown>,
        data_sources: dataSources,
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
    console.error("[report.generate] failed", {
      reportId,
      step: currentStep,
      error: err.message,
      stack: err.stack,
    });
    // Always persist failure so the row never gets stuck in 'generating'.
    try {
      await admin
        .from("reports")
        .update({
          status: "failed",
          error_message: `[${currentStep}] ${err.message}`.slice(0, 1000),
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
