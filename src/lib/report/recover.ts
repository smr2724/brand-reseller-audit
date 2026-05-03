/**
 * Phase 21 — Stuck-scan recovery helper.
 *
 * Picks reports whose `status='generating'` row has been sitting longer
 * than the threshold (default 10 minutes) and re-runs `generateAuditReport`
 * against the existing report id. The generator updates the row in place,
 * so the public token (`/r/<token>`) keeps working without churn.
 *
 * Used by:
 *   - /api/cron/recover-stuck-reports (every 5 min, defensive sweep)
 *   - /api/admin/recover-stuck-report (manual one-shot, gated by CRON_SECRET)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateAuditReport } from "@/lib/report/generate";

export interface StuckReport {
  id: string;
  user_id: string;
  brand_id: string;
  created_at: string;
  status: string;
}

export const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
export const RECOVERY_BATCH_LIMIT = 3;

export async function findStuckReports(
  admin: SupabaseClient,
  thresholdMs: number = STUCK_THRESHOLD_MS,
  limit: number = RECOVERY_BATCH_LIMIT,
): Promise<StuckReport[]> {
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();
  const { data, error } = await admin
    .from("reports")
    .select("id, user_id, brand_id, created_at, status")
    .eq("status", "generating")
    .eq("kind", "channel_ownership_audit")
    .lte("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("[recover] findStuckReports error", error);
    return [];
  }
  return (data ?? []) as StuckReport[];
}

export interface RecoverResult {
  report_id: string;
  status: "recovered" | "failed";
  error?: string;
}

export async function recoverReport(
  admin: SupabaseClient,
  reportId: string,
): Promise<RecoverResult> {
  // Re-read the row so we have user_id+brand_id authoritative.
  const { data: row, error: rowErr } = await admin
    .from("reports")
    .select("id, user_id, brand_id, status, kind")
    .eq("id", reportId)
    .maybeSingle();
  if (rowErr || !row) {
    return { report_id: reportId, status: "failed", error: rowErr?.message ?? "report not found" };
  }
  if (row.kind !== "channel_ownership_audit") {
    return { report_id: reportId, status: "failed", error: `unsupported kind: ${row.kind}` };
  }
  if (!row.user_id || !row.brand_id) {
    return { report_id: reportId, status: "failed", error: "report missing user_id or brand_id" };
  }

  // Look up the contact email from the lead row (if any) so the generator
  // can stamp it on the narrative. Falls back to FALLBACK_CONTACT inside
  // generateAuditReport otherwise.
  const { data: lead } = await admin
    .from("leads")
    .select("email")
    .eq("report_id", reportId)
    .maybeSingle();
  const contactEmail = lead?.email ?? null;

  console.log("[recover] re-running generation", {
    reportId,
    brandId: row.brand_id,
    userId: row.user_id,
    hasContactEmail: !!contactEmail,
  });

  try {
    await generateAuditReport({
      reportId,
      userId: row.user_id,
      brandId: row.brand_id,
      contactEmail,
    });
    return { report_id: reportId, status: "recovered" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { report_id: reportId, status: "failed", error: msg };
  }
}
