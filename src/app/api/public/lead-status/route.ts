/**
 * Phase 21 — Public lead-status lookup for the marketing verify page.
 *
 * GET /api/public/lead-status?lead_token=<email_verify_token raw>
 *
 * Returns the current audit_status for the lead matching this verification
 * token (it's the same token the email link used). Once the cron has
 * created the reports row, the response also carries `report_token`, which
 * the verify page uses to switch to the AuditProgress polling component.
 *
 * Safe to expose publicly because the email-verify token is the secret —
 * same authorization model the verify page already uses.
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { sha256Hex } from "@/lib/audit-request/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const leadToken = (url.searchParams.get("lead_token") ?? "").trim();
  // Optional fallback: if the page already verified and has the lead id,
  // it can pass it directly so we don't need the raw verify token.
  const leadId = (url.searchParams.get("lead_id") ?? "").trim();

  if (!leadToken && !leadId) {
    return NextResponse.json({ error: "lead_token or lead_id required" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  }

  let q = admin
    .from("leads")
    .select("id, audit_status, brand_name, requested_brand_name, report_id, failure_reason");

  if (leadToken) {
    q = q.eq("email_verify_token_hash", sha256Hex(leadToken));
  } else {
    q = q.eq("id", leadId);
  }

  const { data: lead } = await q.maybeSingle();
  if (!lead) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let reportToken: string | null = null;
  if (lead.report_id) {
    const { data: report } = await admin
      .from("reports")
      .select("token, status")
      .eq("id", lead.report_id)
      .maybeSingle();
    reportToken = report?.token ?? null;
  }

  return NextResponse.json({
    lead_id: lead.id,
    audit_status: lead.audit_status,
    brand_name: lead.requested_brand_name ?? lead.brand_name,
    report_token: reportToken,
    failure_reason: lead.failure_reason ?? null,
  });
}
