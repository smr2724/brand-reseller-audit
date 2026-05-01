/**
 * Phase 9 — Resend transactional email helpers.
 *
 * Hybrid send strategy: prospect-facing transactional mail goes through
 * Resend from `audits@rolleconsultinggroup.com`. Steve's personal
 * follow-up still happens out of his Outlook (Phase 6.5 helpers).
 */

const RESEND_API = "https://api.resend.com/emails";

const FROM_DEFAULT =
  "Rolle Consulting Group Audits <audits@rolleconsultinggroup.com>";
const REPLY_TO = "steve@rollemanagementgroup.com";
const COMPANY = "Rolle Consulting Group";
const APP_BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ||
  "https://brand-reseller-audit.vercel.app";

export interface ResendSendResult {
  ok: boolean;
  id?: string;
  error?: string;
  status?: number;
}

interface SendInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

function from(): string {
  return process.env.RESEND_FROM_EMAIL?.trim() || FROM_DEFAULT;
}

export function isResendConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

async function sendRaw(input: SendInput): Promise<ResendSendResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    return { ok: false, error: "RESEND_API_KEY missing" };
  }
  let resp: Response;
  try {
    resp = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        from: from(),
        to: [input.to],
        reply_to: REPLY_TO,
        subject: input.subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
      }),
    });
  } catch (e) {
    return {
      ok: false,
      error: `network error: ${String((e as Error)?.message ?? e)}`,
    };
  }
  const text = await resp.text();
  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      error: `Resend ${resp.status}: ${text.slice(0, 300)}`,
    };
  }
  try {
    const data = JSON.parse(text) as { id?: string };
    return { ok: true, id: data.id };
  } catch {
    return { ok: true };
  }
}

// =============================================================
// Templates
// =============================================================

function shell(bodyHtml: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f1ec;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px;">
    <div style="background:#ffffff;border:1px solid #e7e2d9;padding:36px 32px;">
      <div style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#7a6a4f;margin-bottom:18px;">${COMPANY}</div>
      ${bodyHtml}
    </div>
    <div style="text-align:center;font-size:11px;color:#8a8275;padding:18px 4px 0;line-height:1.55;">
      ${COMPANY}<br/>
      Reply directly to this email or write to
      <a href="mailto:${REPLY_TO}" style="color:#7a6a4f;">${REPLY_TO}</a>.
    </div>
  </div>
</body></html>`;
}

function btn(href: string, label: string): string {
  return `<div style="margin:26px 0;"><a href="${href}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:13px 22px;font-size:14px;letter-spacing:0.04em;">${label}</a></div>`;
}

export interface VerificationEmailInput {
  to: string;
  brandName: string;
  token: string;
}

export function renderVerificationEmail({ brandName, token }: { brandName: string; token: string }) {
  const url = `${APP_BASE_URL}/audit-request/verify?token=${encodeURIComponent(token)}`;
  const subject = `Confirm your Channel Ownership Audit for ${brandName}`;
  const safeBrand = escapeHtml(brandName);
  const html = shell(`
    <h1 style="font-size:22px;margin:0 0 14px;font-weight:500;letter-spacing:-0.01em;">Confirm your audit request</h1>
    <p style="margin:0 0 14px;line-height:1.6;">Click below to confirm we have the right inbox for your <strong>${safeBrand}</strong> Channel Ownership Audit. As soon as you confirm, we&rsquo;ll start the analysis &mdash; you&rsquo;ll have the full report in your inbox in 5&ndash;10 minutes.</p>
    ${btn(url, "Confirm and start my audit")}
    <p style="margin:18px 0 0;font-size:12px;color:#7a6a4f;line-height:1.55;">Link expires in 24 hours. If you didn&rsquo;t request this, ignore this email.</p>
  `);
  const text = `Confirm your Channel Ownership Audit for ${brandName}.\n\nOpen: ${url}\n\nLink expires in 24 hours.`;
  return { subject, html, text };
}

export async function sendVerificationEmail(input: VerificationEmailInput): Promise<ResendSendResult> {
  const r = renderVerificationEmail({ brandName: input.brandName, token: input.token });
  return sendRaw({ to: input.to, subject: r.subject, html: r.html, text: r.text });
}

export interface ReportReadyEmailInput {
  to: string;
  firstName: string | null;
  brandName: string;
  reportToken: string;
}

export function renderReportReadyEmail({
  firstName,
  brandName,
  reportToken,
}: {
  firstName: string | null;
  brandName: string;
  reportToken: string;
}) {
  const reportUrl = `${APP_BASE_URL}/r/${encodeURIComponent(reportToken)}`;
  const calendly =
    process.env.RCG_CALENDLY_URL ||
    "https://calendly.com/steve-rollemanagementgroup/intro";
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : "Hi there,";
  const safeBrand = escapeHtml(brandName);
  const subject = `Your ${brandName} Channel Ownership Audit is ready`;
  const html = shell(`
    <h1 style="font-size:22px;margin:0 0 14px;font-weight:500;letter-spacing:-0.01em;">Your audit is ready</h1>
    <p style="margin:0 0 14px;line-height:1.6;">${greeting}</p>
    <p style="margin:0 0 14px;line-height:1.6;">We finished your <strong>${safeBrand}</strong> Channel Ownership Audit. It maps every reseller currently sitting on your Buy Box, the share of your sales they&rsquo;re pulling, and a real-numbers estimate of the margin we believe you can recapture.</p>
    ${btn(reportUrl, "Open my audit report")}
    <p style="margin:0 0 14px;line-height:1.6;">If the math is interesting, the fastest next step is a 15-minute call to walk through it together:</p>
    <p style="margin:0 0 18px;line-height:1.6;"><a href="${calendly}" style="color:#7a6a4f;">${calendly}</a></p>
    <p style="margin:0;line-height:1.6;">&mdash; Steve<br/><span style="color:#7a6a4f;font-size:13px;">${COMPANY}</span></p>
  `);
  const text = `${firstName ? `Hi ${firstName},` : "Hi there,"}\n\nYour ${brandName} Channel Ownership Audit is ready: ${reportUrl}\n\nGrab a 15-minute walkthrough: ${calendly}\n\n— Steve\n${COMPANY}`;
  return { subject, html, text, reportUrl };
}

export async function sendReportReadyEmail(input: ReportReadyEmailInput): Promise<ResendSendResult> {
  const r = renderReportReadyEmail({
    firstName: input.firstName,
    brandName: input.brandName,
    reportToken: input.reportToken,
  });
  return sendRaw({ to: input.to, subject: r.subject, html: r.html, text: r.text });
}

export interface BrandNotFoundEmailInput {
  to: string;
  firstName: string | null;
  brandName: string;
}

export function renderBrandNotFoundEmail({
  firstName,
  brandName,
}: {
  firstName: string | null;
  brandName: string;
}) {
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : "Hi there,";
  const safeBrand = escapeHtml(brandName);
  const subject = `Couldn't locate ${brandName} on Amazon US`;
  const html = shell(`
    <h1 style="font-size:22px;margin:0 0 14px;font-weight:500;letter-spacing:-0.01em;">We need a hand finding you</h1>
    <p style="margin:0 0 14px;line-height:1.6;">${greeting}</p>
    <p style="margin:0 0 14px;line-height:1.6;">We searched Amazon US for <strong>${safeBrand}</strong> and didn&rsquo;t see active listings under that name. Could you reply with:</p>
    <ul style="margin:0 0 14px 20px;padding:0;line-height:1.7;">
      <li>Your Amazon storefront URL, or</li>
      <li>One example ASIN, or</li>
      <li>The exact brand name as it appears on Amazon (sometimes there&rsquo;s a stray space or accent)</li>
    </ul>
    <p style="margin:0 0 14px;line-height:1.6;">As soon as you reply, we&rsquo;ll re-run the audit and send the report within an hour.</p>
    <p style="margin:0;line-height:1.6;">&mdash; Steve<br/><span style="color:#7a6a4f;font-size:13px;">${COMPANY}</span></p>
  `);
  const text = `${firstName ? `Hi ${firstName},` : "Hi there,"}\n\nWe couldn't find ${brandName} on Amazon US. Reply with your storefront URL or one example ASIN and we'll re-run the audit.\n\n— Steve\n${COMPANY}`;
  return { subject, html, text };
}

export async function sendBrandNotFoundEmail(input: BrandNotFoundEmailInput): Promise<ResendSendResult> {
  const r = renderBrandNotFoundEmail({ firstName: input.firstName, brandName: input.brandName });
  return sendRaw({ to: input.to, subject: r.subject, html: r.html, text: r.text });
}

// =============================================================
// Utils
// =============================================================

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const _internal = { escapeHtml };
