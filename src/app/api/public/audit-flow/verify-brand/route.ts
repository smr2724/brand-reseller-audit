/**
 * Phase 43 — Public client-facing audit flow, Step 1: verify brand.
 *
 * The wizard's first step. Takes a brand name (and optional sample ASIN
 * or storefront URL hint), runs the Keepa-backed brand lookup, creates a
 * draft `leads` row plus a draft `brands` row, and kicks off Keepa
 * enrichment so `brand_sellers` is populated by the time the user
 * reaches Step 2.
 *
 * Hard requirements:
 *  - Cloudflare Turnstile gate (re-uses lib/audit-request/security).
 *  - Daily / IP rate limits (separate keyed bucket from the legacy
 *    submit endpoint so a verify attempt doesn't burn the user's
 *    final-submit quota).
 *  - Returns `{ lead_id, lead_token, candidates }` where lead_token is a
 *    one-time secret the wizard echoes back on every subsequent call.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import {
  verifyTurnstile,
  checkAndConsumeRateLimit,
  generateVerificationToken,
  getClientIp,
} from "@/lib/audit-request/security";
import { lookupBrand } from "@/lib/brand-lookup";
import { normalizeName } from "@/lib/importer/merge";
import { enrichBrandWithKeepa } from "@/lib/enrichment/keepa-brand";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({
  brand_name: z.string().trim().min(1).max(200),
  sample_asin_or_url: z.string().trim().max(400).nullable().optional(),
  turnstile_token: z.string().nullable().optional(),
  utm_source: z.string().trim().max(200).nullable().optional(),
  utm_medium: z.string().trim().max(200).nullable().optional(),
  utm_campaign: z.string().trim().max(200).nullable().optional(),
});

function ownerUserId(): string {
  return (
    process.env.RCG_OWNER_USER_ID ??
    "f425219b-c4a8-402b-bcec-4b149d833c68" // steve@rollemanagementgroup.com
  );
}

export async function POST(req: Request) {
  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(bodyJson);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please enter a brand name." },
      { status: 400 },
    );
  }
  const data = parsed.data;
  const ip = getClientIp(req);

  const admin = createSupabaseAdminClient();
  if (!admin) {
    console.error("[audit-flow/verify-brand] missing SUPABASE_SERVICE_ROLE_KEY");
    return NextResponse.json({ error: "Service is not configured" }, { status: 500 });
  }

  // ---- Turnstile ----
  const turnstileResult = await verifyTurnstile(data.turnstile_token ?? "", ip);
  if (!turnstileResult.ok) {
    return NextResponse.json(
      { error: "Captcha verification failed. Please refresh and try again." },
      { status: 400 },
    );
  }

  // ---- Rate limit (IP / global only — no email yet at this step). We
  //      consume an `email:` bucket too but key it on the IP since we
  //      don't have a contact email until step 3. ----
  const rateKey = `verify:${ip ?? "anon"}`;
  const rate = await checkAndConsumeRateLimit(admin, { email: rateKey, ip });
  if (!rate.ok) {
    return NextResponse.json(
      {
        error:
          "We're rate-limiting requests from your network. Try again in 24 hours or email steve@rollemanagementgroup.com.",
      },
      { status: 429 },
    );
  }

  // ---- Keepa brand lookup ----
  const lookup = await lookupBrand(admin, data.brand_name, { maxAsins: 20 });
  if (!lookup.candidates.length) {
    return NextResponse.json({
      ok: false,
      not_found: true,
      message:
        "We couldn't find that brand on Amazon US. Email steve@rollemanagementgroup.com with your storefront URL or one example ASIN and we'll run the audit manually.",
    });
  }

  // Pick the highest-confidence candidate as the default match — the
  // wizard surfaces alternates so the user can pick a different one.
  const top = lookup.candidates[0];
  const ownerId = ownerUserId();

  // ---- Resolve / create the brand row under the RCG owner ----
  const norm = normalizeName(top.brand);
  let brandId: string | null = null;
  const { data: existing } = await admin
    .from("brands")
    .select("id")
    .eq("user_id", ownerId)
    .eq("name_normalized", norm)
    .maybeSingle();
  if (existing?.id) {
    brandId = existing.id;
  } else {
    const { data: created, error: insErr } = await admin
      .from("brands")
      .insert({
        user_id: ownerId,
        name: top.brand,
        name_normalized: norm,
        status: "lead_request",
      })
      .select("id")
      .single();
    if (insErr || !created) {
      console.error("[audit-flow/verify-brand] brand insert failed", insErr);
      return NextResponse.json(
        { error: "Could not save your brand. Please try again." },
        { status: 500 },
      );
    }
    brandId = created.id;
  }
  if (!brandId) {
    return NextResponse.json({ error: "brand resolution failed" }, { status: 500 });
  }

  // ---- Create draft lead row ----
  const { plain: token, hash: tokenHash } = generateVerificationToken();
  const { data: lead, error: leadErr } = await admin
    .from("leads")
    .insert({
      brand_name: top.brand,
      requested_brand_name: data.brand_name,
      contact_name: null,
      email: null as unknown as string, // filled in at submit step
      phone: null,
      role: null,
      pain_point: null,
      ip_address: ip,
      source: "public_audit_request",
      source_page: "/audit-request",
      audit_status: "verifying_brand",
      audit_requested_at: new Date().toISOString(),
      flow_token_hash: tokenHash,
      flow_version: "v2_wizard",
      brand_id: brandId,
      utm_source: data.utm_source ?? null,
      utm_medium: data.utm_medium ?? null,
      utm_campaign: data.utm_campaign ?? null,
    })
    .select("id")
    .single();
  if (leadErr || !lead) {
    // Some installs may not yet have flow_token_hash / flow_version
    // columns. Fall back to a minimal insert so the wizard still works.
    console.warn(
      "[audit-flow/verify-brand] full insert failed, retrying minimal:",
      leadErr?.message,
    );
    const { data: lead2, error: lead2Err } = await admin
      .from("leads")
      .insert({
        brand_name: top.brand,
        requested_brand_name: data.brand_name,
        email: `pending+${tokenHash.slice(0, 8)}@flow.invalid`,
        phone: "pending",
        ip_address: ip,
        source: "public_audit_request",
        source_page: "/audit-request",
        audit_status: "verifying_brand",
        audit_requested_at: new Date().toISOString(),
        email_verify_token_hash: tokenHash,
        brand_id: brandId,
      })
      .select("id")
      .single();
    if (lead2Err || !lead2) {
      console.error("[audit-flow/verify-brand] lead insert failed", lead2Err);
      return NextResponse.json(
        { error: "Could not save your request. Please try again." },
        { status: 500 },
      );
    }
    return enrichAndRespond(admin, brandId, top.brand, lead2.id, token, lookup.candidates);
  }

  return enrichAndRespond(admin, brandId, top.brand, lead.id, token, lookup.candidates);
}

async function enrichAndRespond(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  brandId: string,
  brandName: string,
  leadId: string,
  token: string,
  candidates: { brand: string; asin_count: number; confidence: number }[],
) {
  const ownerId = ownerUserId();

  // Run Keepa enrichment so brand_sellers is populated. This is the
  // expensive step (5–30s typical). We do it inline so the wizard can
  // immediately fetch the seller list in Step 2 — the user is staring
  // at a "verifying" spinner regardless. If enrichment fails we still
  // return the lead id so the wizard can surface the error and let the
  // user retry.
  let enrichmentError: string | null = null;
  try {
    const { data: brandRow } = await admin
      .from("brands")
      .select("disqualifier_tags")
      .eq("id", brandId)
      .maybeSingle();
    const existingTags: string[] = Array.isArray(brandRow?.disqualifier_tags)
      ? (brandRow!.disqualifier_tags as string[])
      : [];
    await enrichBrandWithKeepa(admin, {
      brand_id: brandId,
      brand_name: brandName,
      user_id: ownerId,
      existing_disqualifier_tags: existingTags,
    });
  } catch (e) {
    enrichmentError = e instanceof Error ? e.message : String(e);
    console.warn("[audit-flow/verify-brand] keepa enrichment failed", enrichmentError);
  }

  // Mark lead as awaiting classifications.
  await admin
    .from("leads")
    .update({ audit_status: "awaiting_classifications" })
    .eq("id", leadId);

  return NextResponse.json({
    ok: true,
    lead_id: leadId,
    lead_token: token,
    brand_id: brandId,
    brand_name: brandName,
    candidates: candidates.slice(0, 5).map((c) => ({
      brand: c.brand,
      asin_count: c.asin_count,
      confidence: c.confidence,
    })),
    enrichment_error: enrichmentError,
  });
}
