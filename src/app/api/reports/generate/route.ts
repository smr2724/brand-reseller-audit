import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseAdminClient } from "@/lib/supabase/server";
import { randomBytes } from "crypto";
import { generateAuditReport } from "@/lib/report/generate";
import { freshSignedUrl } from "@/lib/report/storage";
import { waitUntil } from "@vercel/functions";
import {
  aggregateClassificationShares,
  type SellerClassification,
} from "@/lib/brand-detail/seller-classification-shares";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Phase 22 — Bumped 300 → 800 (Vercel Pro Fluid Compute ceiling). The
// audit-generation pipeline runs the full Keepa + DataForSEO + LLM
// narrative + PDF render path; even with parallelism + timeouts, cold
// runs need real headroom while we keep iterating on the stage budgets.
export const maxDuration = 800;

const VALID_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  "brand_owned",
  "authorized",
  "amazon",
  "reseller",
]);

interface SellerClassificationSnapshotEntry {
  seller_id?: string | null;
  seller_name?: string | null;
  share_pct?: number | null;
  asins_won?: number | null;
  is_fba?: boolean | null;
  classification: SellerClassification | string;
}

interface Body {
  brand_id?: string;
  /** Phase 39 — required when generating a brand-scoped report. The UI
   *  collects classifications via the SellerClassificationModal and
   *  POSTs them here so the report row stamps a reproducible snapshot
   *  alongside the four derived share_pct columns. */
  seller_classifications?: SellerClassificationSnapshotEntry[];
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

  // Phase 39 — Require fresh seller classifications captured by the
  // SellerClassificationModal. The 4 buckets feed both the report's
  // recoverable-revenue math and the brand-page financial model. Without
  // them we'd silently fall back to the keepa name-overlap heuristic
  // that misclassifies brand owners with no name match (e.g. Diversified
  // Hospitality Solutions for Terra Pure).
  const classifications = Array.isArray(body.seller_classifications)
    ? body.seller_classifications
    : null;
  if (!classifications || classifications.length === 0) {
    return NextResponse.json(
      {
        error: "missing_classifications",
        message:
          "Seller classifications are required before generating a report. Open the seller classification modal and confirm each seller's bucket.",
      },
      { status: 422 },
    );
  }
  for (const c of classifications) {
    if (!c || typeof c !== "object" || !VALID_CLASSIFICATIONS.has(String(c.classification))) {
      return NextResponse.json(
        {
          error: "invalid_classification",
          message: `Each classification must be one of brand_owned/authorized/amazon/reseller. Got "${(c as any)?.classification}".`,
        },
        { status: 400 },
      );
    }
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Server missing SUPABASE_SERVICE_ROLE_KEY — cannot run report generation" },
      { status: 500 }
    );
  }

  // Mirror the user's verdict back to brand_sellers so the brand-page
  // dossier widgets and the financial-model recompute pull from the
  // same numbers as the report. We do this before snapshotting so the
  // snapshot reflects the persisted truth at the moment of generation.
  const nowIso = new Date().toISOString();
  for (const c of classifications) {
    if (!c.seller_id && !c.seller_name) continue;
    const update = {
      classification: c.classification,
      classified_by_user_id: user.id,
      classified_at: nowIso,
      is_brand_controlled:
        c.classification === "brand_owned" || c.classification === "authorized",
    };
    let q = admin.from("brand_sellers").update(update).eq("brand_id", brand.id);
    if (c.seller_id) q = q.eq("seller_id", c.seller_id);
    else if (c.seller_name) q = q.eq("seller_name", c.seller_name);
    const { error: updErr } = await q;
    if (updErr) {
      // Non-fatal: snapshot still drives the report compute path.
      console.warn("[api/reports/generate] brand_sellers classification update failed", updErr);
    }
  }

  const shares = aggregateClassificationShares(classifications);
  const snapshot = classifications.map((c) => ({
    seller_id: c.seller_id ?? null,
    seller_name: c.seller_name ?? null,
    share_pct: typeof c.share_pct === "number" ? c.share_pct : null,
    asins_won: typeof c.asins_won === "number" ? c.asins_won : null,
    is_fba: typeof c.is_fba === "boolean" ? c.is_fba : null,
    classification: c.classification,
  }));

  const insertRow = {
    user_id: user.id,
    brand_id: brand.id,
    kind: "channel_ownership_audit",
    status: "generating" as const,
    title: `${brand.name} — Channel Ownership Audit`,
    token: makeToken(),
    seller_classifications: snapshot,
    brand_owned_share_pct: shares.brand_owned_share_pct,
    authorized_share_pct: shares.authorized_share_pct,
    amazon_share_pct: shares.amazon_share_pct,
    reseller_share_pct: shares.reseller_share_pct,
  };

  let { data: report, error: insErr } = await admin
    .from("reports")
    .insert(insertRow)
    .select("id")
    .single();
  if (insErr) {
    // Phase 39 — graceful degrade if the 0038 migration hasn't been
    // applied yet. The report row still gets written; the snapshot
    // columns just don't persist on this run.
    const msg = insErr.message ?? "";
    const looksLikeMissingColumn =
      /column .* does not exist|seller_classifications|share_pct/i.test(msg);
    if (looksLikeMissingColumn) {
      console.warn(
        `[api/reports/generate] reports insert with classification columns failed (${msg}); retrying without them.`,
      );
      const {
        seller_classifications: _sc,
        brand_owned_share_pct: _b,
        authorized_share_pct: _a,
        amazon_share_pct: _am,
        reseller_share_pct: _r,
        ...legacy
      } = insertRow;
      const retry = await admin.from("reports").insert(legacy).select("id").single();
      report = retry.data;
      insErr = retry.error;
    }
  }
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
    classificationShares: shares.has_data
      ? {
          brand_owned_share_pct: shares.brand_owned_share_pct,
          authorized_share_pct: shares.authorized_share_pct,
          amazon_share_pct: shares.amazon_share_pct,
          reseller_share_pct: shares.reseller_share_pct,
          non_reseller_share_pct: shares.non_reseller_share_pct,
        }
      : null,
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
