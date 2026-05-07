/**
 * Phase 47 — POST /api/brands/[id]/contacts/discover
 *
 * Triggers Module 2. Only allowed when qualification is `complete` AND
 * (`icp_verdict IN ('qualified','needs_review')` OR `manual_override=true`).
 */
import { NextResponse } from "next/server";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";
import { runContactDiscovery } from "@/lib/contacts/orchestrate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data: brand } = await supabase
    .from("brands")
    .select("id, qualification_state")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle<{ id: string; qualification_state: string | null }>();
  if (!brand) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const force = body?.force === true;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }
  const { data: qual } = await admin
    .from("brand_qualifications")
    .select("icp_verdict, manual_override, state")
    .eq("brand_id", params.id)
    .maybeSingle<{
      icp_verdict: string;
      manual_override: boolean;
      state: string;
    }>();

  if (!qual) {
    return NextResponse.json(
      { error: "qualification has not run yet" },
      { status: 400 },
    );
  }
  if (qual.state !== "complete") {
    return NextResponse.json(
      { error: `qualification state is ${qual.state}` },
      { status: 400 },
    );
  }
  const allowed =
    qual.icp_verdict === "qualified" ||
    qual.icp_verdict === "needs_review" ||
    qual.manual_override === true;
  if (!allowed && !force) {
    return NextResponse.json(
      {
        error:
          "verdict is disqualified — set manual_override or pass force:true to discover anyway",
      },
      { status: 400 },
    );
  }

  const result = await runContactDiscovery(params.id);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error ?? "discovery failed", state: result.state },
      { status: 500 },
    );
  }
  const { data: contacts } = await admin
    .from("brand_contacts")
    .select(
      "id, full_name, title, linkedin_url, company_domain, email, email_status, email_source, email_verifier_score, phone, phone_status, is_primary, ready_to_send",
    )
    .eq("brand_id", params.id)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });
  const { data: cache } = await admin
    .from("contact_domain_cache")
    .select("email_pattern, is_catch_all")
    .eq(
      "domain",
      (
        contacts?.find((c) => c.company_domain)?.company_domain ?? ""
      ).toLowerCase(),
    )
    .maybeSingle();
  return NextResponse.json({
    state: result.state,
    contacts: contacts ?? [],
    domain_pattern: cache?.email_pattern ?? null,
    is_catch_all: cache?.is_catch_all ?? null,
  });
}
