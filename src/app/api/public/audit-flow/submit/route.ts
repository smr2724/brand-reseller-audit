/**
 * Phase 43 — Public client-facing audit flow, Step 3 submit:
 * capture contact info and flip the lead to `pending` so the cron
 * processor (or an inline run) generates the report and emails it.
 *
 * Hard requirements:
 *  - Cloudflare Turnstile gate.
 *  - Free-email + per-email rate limit.
 *  - Persist phone, website, approx_amazon_revenue.
 *  - Mark `audit_status='pending'` so the existing cron picks it up.
 *    The cron has been extended to detect public-flow leads (brand_id
 *    already populated, classifications already persisted) and skip
 *    re-doing the brand search / Keepa enrichment, plus to cc Steve on
 *    the report email.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import {
  isFreeEmail,
  verifyTurnstile,
  checkAndConsumeRateLimit,
  getClientIp,
  sha256Hex,
} from "@/lib/audit-request/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const Body = z.object({
  lead_id: z.string().uuid(),
  lead_token: z.string().min(1),
  contact_name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(5).max(40),
  website: z.string().trim().min(1).max(400),
  approx_amazon_revenue: z.string().trim().min(1).max(120),
  role: z.string().trim().max(80).nullable().optional(),
  turnstile_token: z.string().nullable().optional(),
});

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
      { error: "Please fill out all required fields." },
      { status: 400 },
    );
  }
  const data = parsed.data;
  const ip = getClientIp(req);

  const admin = createSupabaseAdminClient();
  if (!admin) {
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

  // ---- Free-email blocker ----
  if (isFreeEmail(data.email)) {
    return NextResponse.json(
      {
        error:
          "Please use your work email so we can verify the brand belongs to you.",
      },
      { status: 400 },
    );
  }

  // ---- Lead lookup + token check ----
  const tokenHash = sha256Hex(data.lead_token);
  const { data: lead } = await admin
    .from("leads")
    .select("id, brand_id, brand_name, audit_status, flow_token_hash, email_verify_token_hash")
    .eq("id", data.lead_id)
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

  // ---- Rate limit (per email + global) ----
  const rate = await checkAndConsumeRateLimit(admin, { email: data.email, ip });
  if (!rate.ok) {
    const reasonMessage =
      rate.reason === "email"
        ? "We already received a request from this email in the last 24 hours. Look for the previous email or write to steve@rollemanagementgroup.com."
        : rate.reason === "ip"
        ? "We're rate-limiting requests from your network. Try again in 24 hours or email us directly."
        : "We've hit today's audit cap. Please try again tomorrow or email us directly.";
    return NextResponse.json({ error: reasonMessage }, { status: 429 });
  }

  // ---- Persist contact info + flip lead to `pending` ----
  const updatePayload: Record<string, unknown> = {
    contact_name: data.contact_name,
    email: data.email,
    phone: data.phone,
    role: data.role ?? null,
    website: data.website,
    approx_amazon_revenue: data.approx_amazon_revenue,
    audit_status: "pending",
    audit_requested_at: new Date().toISOString(),
    flow_version: "v2_wizard",
  };

  let { error: upErr } = await admin
    .from("leads")
    .update(updatePayload)
    .eq("id", data.lead_id);
  if (upErr) {
    // Older installs may not have the new columns yet. Strip them and
    // retry so the wizard still works during the deploy window.
    const drop = ["website", "approx_amazon_revenue", "flow_version"];
    let stripped = false;
    for (const k of drop) {
      if (k in updatePayload) {
        delete updatePayload[k];
        stripped = true;
      }
    }
    if (stripped) {
      const retry = await admin
        .from("leads")
        .update(updatePayload)
        .eq("id", data.lead_id);
      upErr = retry.error;
    }
    if (upErr) {
      console.error("[audit-flow/submit] lead update failed", upErr);
      return NextResponse.json(
        { error: "Could not save your contact info. Please try again." },
        { status: 500 },
      );
    }
  }

  await logSubmission(admin, {
    email: data.email,
    brand_name: lead.brand_name ?? "",
    ip,
    outcome: "accepted",
    reason: null,
  });

  return NextResponse.json({ ok: true, lead_id: data.lead_id });
}

async function logSubmission(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  args: {
    email: string;
    brand_name: string;
    ip: string | null;
    outcome:
      | "accepted"
      | "rejected_freemail"
      | "rejected_ratelimit"
      | "rejected_captcha"
      | "rejected_invalid";
    reason: string | null;
  },
) {
  if (!admin) return;
  try {
    await admin.from("public_audit_request_log").insert({
      email: args.email,
      brand_name: args.brand_name,
      ip_address: args.ip,
      outcome: args.outcome,
      reason: args.reason,
    });
  } catch (e) {
    console.warn("[audit-flow/submit] log insert failed", e);
  }
}
