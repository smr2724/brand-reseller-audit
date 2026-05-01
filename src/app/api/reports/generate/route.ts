import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseAdminClient } from "@/lib/supabase/server";
import { randomBytes } from "crypto";
import { generateAuditReport } from "@/lib/report/generate";
import { freshSignedUrl } from "@/lib/report/storage";
import { waitUntil } from "@vercel/functions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel Pro allows up to 300s on the Node runtime. Report generation
// (Keepa lookup + LLM narrative + PDF render + Supabase storage upload) can
// take 60-120s on cold paths, so 60s was too tight.
export const maxDuration = 300;

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

  console.log("[api/reports/generate] starting", {
    reportId: report.id,
    brandId: brand.id,
    userId: user.id,
  });

  // Kick off the generation promise once. We `await` it below for a
  // synchronous response, AND register it with `waitUntil` so that if the
  // request handler is interrupted (client disconnect, edge timeout) the
  // platform keeps the function alive until generation completes and the
  // reports row is finalized. Both refer to the same promise.
  const genPromise = generateAuditReport({
    reportId: report.id,
    userId: user.id,
    brandId: brand.id,
    contactEmail: user.email ?? null,
  });
  try {
    waitUntil(genPromise);
  } catch (e) {
    // waitUntil only works on Vercel; in other environments it may throw —
    // that's fine because we still await below.
    console.warn("[api/reports/generate] waitUntil unavailable:", e);
  }

  try {
    await genPromise;
  } catch (err) {
    // generateAuditReport already persisted status='failed' + error_message
    // on the reports row. Surface the error to the client so the UI can
    // show it immediately instead of waiting on the next poll.
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/reports/generate] generation failed", {
      reportId: report.id,
      error: msg,
    });
    return NextResponse.json(
      {
        report_id: report.id,
        status: "failed",
        error: msg,
      },
      { status: 500 }
    );
  }

  // Re-read the finalized row so we can return the signed URL + path.
  const { data: finalRow } = await admin
    .from("reports")
    .select("id, status, pdf_storage_path, error_message")
    .eq("id", report.id)
    .maybeSingle();

  let signed_url: string | null = null;
  if (finalRow?.status === "completed" && finalRow.pdf_storage_path) {
    try {
      signed_url = await freshSignedUrl(finalRow.pdf_storage_path);
    } catch (e) {
      console.warn("[api/reports/generate] signed url failed:", e);
    }
  }

  return NextResponse.json({
    report_id: report.id,
    status: finalRow?.status ?? "completed",
    pdf_storage_path: finalRow?.pdf_storage_path ?? null,
    signed_url,
    error_message: finalRow?.error_message ?? null,
  });
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
