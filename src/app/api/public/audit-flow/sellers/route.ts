/**
 * Phase 43 — Public client-facing audit flow, Step 2 data: seller list.
 *
 * GET /api/public/audit-flow/sellers?lead_id=&lead_token=
 *
 * Returns the brand_sellers rows for the brand attached to the
 * in-progress lead. The lead_token (raw) is the secret — we look it up
 * by sha256(lead_token) against `flow_token_hash` (or
 * `email_verify_token_hash` as a fallback for installs where the
 * migration hasn't applied yet).
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { sha256Hex } from "@/lib/audit-request/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const leadId = (url.searchParams.get("lead_id") ?? "").trim();
  const leadToken = (url.searchParams.get("lead_token") ?? "").trim();
  if (!leadId || !leadToken) {
    return NextResponse.json(
      { error: "lead_id and lead_token required" },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  }

  const tokenHash = sha256Hex(leadToken);
  const { data: lead } = await admin
    .from("leads")
    .select("id, brand_id, flow_token_hash, email_verify_token_hash, audit_status")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const ok =
    lead.flow_token_hash === tokenHash ||
    lead.email_verify_token_hash === tokenHash;
  if (!ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!lead.brand_id) {
    return NextResponse.json({ error: "brand not resolved yet" }, { status: 409 });
  }

  const { data: sellers, error } = await admin
    .from("brand_sellers")
    .select(
      "id, seller_name, seller_id, seller_country, share_pct, asins_won, is_fba, is_brand_controlled, classification_reason, classification, classified_at",
    )
    .eq("brand_id", lead.brand_id)
    .order("share_pct", { ascending: false, nullsFirst: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    sellers: sellers ?? [],
    audit_status: lead.audit_status,
    brand_id: lead.brand_id,
  });
}
