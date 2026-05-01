import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseAdminClient } from "@/lib/supabase/server";
import { randomBytes } from "crypto";
import { generateAuditReport } from "@/lib/report/generate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  brand_id?: string;
  // Phase-1 legacy fields — still accepted for the public share-link flow.
  supplier_id?: string;
  opportunity_id?: string;
}

function makeToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function POST(req: NextRequest) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Body;

  // ---------- Phase 1 legacy: supplier+opportunity public share token ----------
  if (body.supplier_id && body.opportunity_id) {
    return legacySupplierReport(supabase, user.id, body.supplier_id, body.opportunity_id);
  }

  // ---------- Phase 5: brand-scoped Channel Ownership Audit ----------
  if (!body.brand_id) {
    return NextResponse.json(
      { error: "brand_id required (or supplier_id+opportunity_id for legacy share reports)" },
      { status: 400 }
    );
  }

  const { data: brand } = await supabase
    .from("brands")
    .select("id, name")
    .eq("id", body.brand_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!brand) return NextResponse.json({ error: "Brand not found" }, { status: 404 });

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Server missing SUPABASE_SERVICE_ROLE_KEY — cannot run report generation" },
      { status: 500 }
    );
  }

  // Insert reports row in 'generating' state. token is left unique-but-arbitrary
  // for compatibility with the existing UNIQUE constraint.
  const insertRow = {
    user_id: user.id,
    brand_id: brand.id,
    kind: "channel_ownership_audit",
    status: "generating" as const,
    title: `${brand.name} — Channel Ownership Audit`,
    token: makeToken(),
  };

  const { data: report, error: insErr } = await admin
    .from("reports")
    .insert(insertRow)
    .select("id")
    .single();
  if (insErr || !report) {
    return NextResponse.json({ error: insErr?.message ?? "insert failed" }, { status: 500 });
  }

  // Fire-and-forget. We don't await — caller polls /api/reports/:id.
  // We intentionally do NOT use `waitUntil` to keep this portable; on Vercel
  // the maxDuration export keeps the function alive long enough.
  generateAuditReport({
    reportId: report.id,
    userId: user.id,
    brandId: brand.id,
    contactEmail: user.email ?? null,
  }).catch((err) => {
    console.error("[api/reports/generate] async generation error:", err);
  });

  return NextResponse.json({ report_id: report.id, status: "generating" });
}

// ----------------------------------------------------------------------------
// Phase 1 legacy path — preserve existing behavior so the share-link flow keeps working.
// ----------------------------------------------------------------------------
async function legacySupplierReport(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  userId: string,
  supplier_id: string,
  opportunity_id: string
) {
  const [supRes, oppRes] = await Promise.all([
    supabase.from("suppliers").select("id").eq("id", supplier_id).eq("user_id", userId).single(),
    supabase.from("opportunities").select("id").eq("id", opportunity_id).eq("user_id", userId).single(),
  ]);
  if (!supRes.data) return NextResponse.json({ error: "Supplier not found" }, { status: 404 });
  if (!oppRes.data) return NextResponse.json({ error: "Opportunity not found" }, { status: 404 });

  const { data: existing } = await supabase
    .from("reports")
    .select("id, token")
    .eq("supplier_id", supplier_id)
    .eq("opportunity_id", opportunity_id)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ||
    "https://brand-reseller-audit.vercel.app";

  if (existing && existing.token) {
    return NextResponse.json({
      token: existing.token,
      url: `${baseUrl}/r/${existing.token}`,
      reused: true,
    });
  }

  const token = makeToken();
  const { error } = await supabase.from("reports").insert({
    user_id: userId,
    supplier_id,
    opportunity_id,
    token,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    token,
    url: `${baseUrl}/r/${token}`,
    reused: false,
  });
}
