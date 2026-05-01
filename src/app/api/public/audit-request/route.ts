import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import {
  isFreeEmail,
  verifyTurnstile,
  checkAndConsumeRateLimit,
  generateVerificationToken,
  getClientIp,
} from "@/lib/audit-request/security";
import { sendVerificationEmail, isResendConfigured } from "@/lib/email/resend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const Body = z.object({
  brand_name: z.string().trim().min(1).max(200),
  contact_name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(5).max(40),
  role: z.string().trim().max(80).nullable().optional(),
  pain_point: z.string().trim().max(200).nullable().optional(),
  turnstile_token: z.string().nullable().optional(),
  utm_source: z.string().trim().max(200).nullable().optional(),
  utm_medium: z.string().trim().max(200).nullable().optional(),
  utm_campaign: z.string().trim().max(200).nullable().optional(),
});

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

export async function POST(req: Request) {
  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(bodyJson);
  if (!parsed.success) {
    return NextResponse.json({ error: "Please fill out all required fields." }, { status: 400 });
  }
  const data = parsed.data;
  const ip = getClientIp(req);

  const admin = createSupabaseAdminClient();
  if (!admin) {
    console.error("[audit-request] missing SUPABASE_SERVICE_ROLE_KEY");
    return NextResponse.json({ error: "Service is not configured" }, { status: 500 });
  }

  // ---- Step 1: Free-email blocker (no DB writes yet) ----
  if (isFreeEmail(data.email)) {
    await logSubmission(admin, {
      email: data.email,
      brand_name: data.brand_name,
      ip,
      outcome: "rejected_freemail",
      reason: "free email provider",
    });
    return NextResponse.json(
      { error: "Please use your work email so we can verify the brand belongs to you." },
      { status: 400 },
    );
  }

  // ---- Step 2: Turnstile ----
  const turnstileResult = await verifyTurnstile(data.turnstile_token ?? "", ip);
  if (!turnstileResult.ok) {
    await logSubmission(admin, {
      email: data.email,
      brand_name: data.brand_name,
      ip,
      outcome: "rejected_captcha",
      reason: turnstileResult.error ?? "turnstile failed",
    });
    return NextResponse.json(
      { error: "Captcha verification failed. Please refresh and try again." },
      { status: 400 },
    );
  }

  // ---- Step 3: Rate limit ----
  const rate = await checkAndConsumeRateLimit(admin, { email: data.email, ip });
  if (!rate.ok) {
    await logSubmission(admin, {
      email: data.email,
      brand_name: data.brand_name,
      ip,
      outcome: "rejected_ratelimit",
      reason: rate.reason ?? "limit",
    });
    const reasonMessage =
      rate.reason === "email"
        ? "We already received a request from this email in the last 24 hours. Look for the previous email or write to steve@rollemanagementgroup.com."
        : rate.reason === "ip"
        ? "We're rate-limiting requests from your network. Try again in 24 hours or email us directly."
        : "We've hit today's audit cap. Please try again tomorrow or email us directly.";
    return NextResponse.json({ error: reasonMessage }, { status: 429 });
  }

  // ---- Step 4: Insert lead with pending_verification status ----
  const { plain: token, hash: tokenHash } = generateVerificationToken();
  const expiresAt = new Date(Date.now() + VERIFY_TTL_MS).toISOString();

  const { data: lead, error: insErr } = await admin
    .from("leads")
    .insert({
      brand_name: data.brand_name,
      requested_brand_name: data.brand_name,
      contact_name: data.contact_name,
      email: data.email,
      phone: data.phone,
      role: data.role ?? null,
      pain_point: data.pain_point ?? null,
      ip_address: ip,
      source: "public_audit_request",
      source_page: "/audit-request",
      audit_status: "pending_verification",
      audit_requested_at: new Date().toISOString(),
      email_verify_token_hash: tokenHash,
      email_verify_expires_at: expiresAt,
      utm_source: data.utm_source ?? null,
      utm_medium: data.utm_medium ?? null,
      utm_campaign: data.utm_campaign ?? null,
    })
    .select("id")
    .single();
  if (insErr || !lead) {
    console.error("[audit-request] lead insert failed", insErr);
    return NextResponse.json({ error: "Could not save your request. Please try again." }, { status: 500 });
  }

  // ---- Step 5: Send verification email ----
  if (isResendConfigured()) {
    const send = await sendVerificationEmail({
      to: data.email,
      brandName: data.brand_name,
      token,
    });
    if (!send.ok) {
      console.error("[audit-request] verification email failed", send.error);
      // Don't 500 the user — the lead exists. They can request a resend.
    }
  } else {
    console.warn("[audit-request] RESEND_API_KEY missing — verification email not sent");
  }

  await logSubmission(admin, {
    email: data.email,
    brand_name: data.brand_name,
    ip,
    outcome: "accepted",
    reason: null,
  });

  return NextResponse.json({ ok: true });
}

async function logSubmission(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  args: {
    email: string;
    brand_name: string;
    ip: string | null;
    outcome: "accepted" | "rejected_freemail" | "rejected_ratelimit" | "rejected_captcha" | "rejected_invalid";
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
    console.warn("[audit-request] log insert failed", e);
  }
}
