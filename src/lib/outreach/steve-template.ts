/**
 * Phase 76 — Steve's verbatim outreach copy (subject + body).
 *
 * Shared between the Phase 75 bulk worker (`src/lib/bulk/worker.ts`) and
 * the legacy per-row draft route (`/api/outreach/send-to-outlook`). Both
 * paths MUST stay in sync — that's why the construction lives in exactly
 * one place. Do not duplicate inline.
 *
 * Steve approved this exact copy. Do not rewrite or "improve" without
 * Steve's approval.
 */

import { formatAdditionalProfit } from "@/lib/format/money";

export interface SteveTemplateInput {
  brandName: string;
  firstName: string | null;
  additionalProfit: number | string | null | undefined;
}

export interface SteveTemplateOutput {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveFirstName(firstName: string | null): string {
  if (typeof firstName === "string" && firstName.trim().length > 0) {
    return firstName.trim();
  }
  return "there";
}

export function buildSteveOutreachEmail(
  input: SteveTemplateInput,
): SteveTemplateOutput {
  const safeFirst = resolveFirstName(input.firstName);
  const brand = input.brandName;
  const profit = formatAdditionalProfit(input.additionalProfit);

  const subject = `${profit} Profit for ${brand}`;

  const html =
    `<p>${escapeHtml(safeFirst)},</p>` +
    `<p>${escapeHtml(brand)} is killing it on Amazon but you're not the one selling on most of the listings.</p>` +
    `<p>I put together a report to show you what our team found with detailed numbers.</p>` +
    `<p>Are you the right person to send it to?</p>` +
    `<p>Steve Rolle</p>`;

  const text =
    `${safeFirst},\n\n` +
    `${brand} is killing it on Amazon but you're not the one selling on most of the listings.\n\n` +
    `I put together a report to show you what our team found with detailed numbers.\n\n` +
    `Are you the right person to send it to?\n\n` +
    `Steve Rolle`;

  return { subject, html, text };
}
