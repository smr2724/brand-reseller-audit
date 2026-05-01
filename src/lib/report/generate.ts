import { createSupabaseAdminClient } from "@/lib/supabase/server";
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

/**
 * Orchestrator: assumes the reports row already exists in 'generating' status.
 * Updates the row to 'completed' on success or 'failed' on error.
 */
export async function generateAuditReport(input: GenerateInput): Promise<void> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY missing — required to run report generation");
  }

  const { reportId, userId, brandId } = input;
  try {
    // 1. Load brand row
    const { data: brand, error: brandErr } = await admin
      .from("brands")
      .select("*")
      .eq("id", brandId)
      .eq("user_id", userId)
      .maybeSingle();
    if (brandErr) throw new Error(`brand lookup failed: ${brandErr.message}`);
    if (!brand) throw new Error("brand not found");

    const brandTyped = brand as BrandForReport;

    // 2. LLM narrative
    const narrative = await generateNarrative(brandTyped);

    // 3. PDF render
    const generatedAt = new Date();
    const contactEmail = (input.contactEmail || "").trim() || FALLBACK_CONTACT;
    const buffer = await renderAuditPdf({
      brand: brandTyped,
      narrative,
      contactEmail,
      generatedAt,
    });

    // 4. Upload + sign
    const { path, signedUrl } = await uploadReportPdf({
      userId,
      brandId,
      reportId,
      buffer,
    });

    // 5. Mark complete
    const { error: updErr } = await admin
      .from("reports")
      .update({
        status: "completed",
        pdf_storage_path: path,
        pdf_public_url: signedUrl,
        narrative_json: narrative as unknown as Record<string, unknown>,
        generated_at: generatedAt.toISOString(),
        title: `${brandTyped.name} — Channel Ownership Audit`,
        error_message: null,
      })
      .eq("id", reportId);
    if (updErr) throw new Error(`report update failed: ${updErr.message}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[report/generate] failed:", msg);
    await admin
      .from("reports")
      .update({
        status: "failed",
        error_message: msg.slice(0, 1000),
      })
      .eq("id", reportId);
    throw e;
  }
}
