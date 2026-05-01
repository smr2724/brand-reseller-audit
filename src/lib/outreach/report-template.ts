/**
 * Phase 6.5/6.7 — Report follow-up email template ("Short tease + link").
 *
 * Used by `/api/outreach/email-report` to drop a draft into the user's
 * Outlook with a public branded report URL (Phase 6.7) — `/r/{token}` on
 * our domain rather than a raw Supabase signed URL.
 *
 * Verbatim per spec — do not rewrite without Steve's approval.
 */

import type { RenderedEmail, InitialTemplateContact } from "@/lib/outreach/initial-template";

export interface ReportTemplateBrand {
  name: string;
  keepa_unique_seller_count: number | null;
  keepa_brand_controlled_pct: number | null;
}

export interface RenderReportEmailInput {
  brand: ReportTemplateBrand;
  contact: InitialTemplateContact;
  /**
   * The report's public token (`reports.token`). The renderer builds
   * `${APP_URL}/r/{token}`. Required.
   */
  reportToken: string;
}

function firstName(contact: InitialTemplateContact): string {
  if (contact.first_name && contact.first_name.trim()) return contact.first_name.trim();
  if (contact.full_name && contact.full_name.trim()) {
    const head = contact.full_name.trim().split(/\s+/)[0];
    if (head) return head;
  }
  return "there";
}

function publicReportUrl(token: string): string {
  const base =
    (process.env.NEXT_PUBLIC_APP_URL || "https://brand-reseller-audit.vercel.app").replace(/\/+$/, "");
  return `${base}/r/${encodeURIComponent(token)}`;
}

export function renderReportEmail(input: RenderReportEmailInput): RenderedEmail {
  const brandName = input.brand.name;
  const first = firstName(input.contact);
  const sellers = input.brand.keepa_unique_seller_count;
  const brandControlled = input.brand.keepa_brand_controlled_pct; // 0..1
  const reportUrl = publicReportUrl(input.reportToken);

  // Spec fallback: if channel-control % is missing, drop the second clause.
  let findingSentence: string;
  if (brandControlled != null && Number.isFinite(brandControlled)) {
    const ctrlPct = Math.round(Math.max(0, Math.min(1, brandControlled)) * 100);
    const sellerN = sellers != null && sellers > 0 ? sellers : "multiple";
    findingSentence =
      `Quick follow-up on ${brandName}: our audit found about ${sellerN} sellers competing for your buy-box ` +
      `and roughly ${ctrlPct}% brand-controlled share. Full report (10 pages, no signup): ${reportUrl}`;
  } else {
    const sellerN = sellers != null && sellers > 0 ? sellers : "multiple";
    findingSentence =
      `Quick follow-up on ${brandName}: our audit found about ${sellerN} resellers competing for your buy-box. ` +
      `Full report (10 pages, no signup): ${reportUrl}`;
  }

  const subject = `${brandName} audit — quick findings`;

  const text =
    `Hi ${first},\n\n` +
    `${findingSentence}\n\n` +
    `Worth a 15-minute call?\n\n` +
    `Best,\n` +
    `Steve Rolle`;

  // Linkify the report URL once for the HTML body so it's clickable in Outlook.
  const html = buildHtml(text, reportUrl);
  return { subject, html, text };
}

function buildHtml(text: string, reportUrl: string): string {
  const safeUrl = reportUrl.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Replace the (now-escaped) URL with an anchor tag.
  const linkified = escaped.split(safeUrl).join(`<a href="${safeUrl}">${safeUrl}</a>`);
  return linkified
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}
