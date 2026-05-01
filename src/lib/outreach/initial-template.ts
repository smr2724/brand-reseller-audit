/**
 * Phase 6.5 — Initial outreach email template (verbatim per spec).
 *
 * Renders Steve's first-touch email for a brand+contact pair as a
 * { subject, html, text } triple ready to drop into a Microsoft Graph
 * draft. Placeholder substitution pulls from `BrandEnrichmentBundle`
 * + the `brands` row + the primary `contacts` row.
 *
 * The spec requires the literal copy below. Do not rewrite or "improve"
 * it — Steve approved this exact wording.
 */

import type { BrandEnrichmentBundle } from "@/lib/enrichment";

export interface InitialTemplateBrand {
  name: string;
  keepa_unique_seller_count: number | null;
  keepa_brand_controlled_pct: number | null; // stored as 0..1
}

export interface InitialTemplateContact {
  full_name: string | null;
  first_name: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Annual-margin assumption used to translate revenue + reseller-share into
 * an "estimated annual profit recapture" headline number.
 *
 * 0.20 (20%) is Steve's working operator-margin assumption — captures
 * gross-to-EBITDA after Amazon fees, COGS, and overhead for the typical
 * brand we audit. Documented per Phase 6.5 spec; do not change without
 * Steve's approval, since this number ends up in the subject line.
 */
const MARGIN_ASSUMPTION = 0.20;

function firstName(contact: InitialTemplateContact): string {
  if (contact.first_name && contact.first_name.trim()) return contact.first_name.trim();
  if (contact.full_name && contact.full_name.trim()) {
    const head = contact.full_name.trim().split(/\s+/)[0];
    if (head) return head;
  }
  return "there";
}

/**
 * Estimate annual Amazon revenue from the Keepa bundle. Today the bundle
 * does not surface a revenue field directly, so we lean on the brand row
 * (set by SmartScout import). The bundle is still threaded through so we
 * can swap to a richer source later without touching every caller.
 */
export interface RevenueLookup {
  trailing_12_months: number | null;
  est_monthly_revenue: number | null;
}

function annualRevenueDollars(rev: RevenueLookup): number | null {
  if (rev.trailing_12_months != null && Number.isFinite(rev.trailing_12_months) && rev.trailing_12_months > 0) {
    return Number(rev.trailing_12_months);
  }
  if (rev.est_monthly_revenue != null && Number.isFinite(rev.est_monthly_revenue) && rev.est_monthly_revenue > 0) {
    return Number(rev.est_monthly_revenue) * 12;
  }
  return null;
}

function formatRevenueShort(dollars: number): string {
  if (dollars >= 1_000_000) {
    const m = dollars / 1_000_000;
    // One decimal unless it's a clean integer million.
    return m >= 10 ? `$${Math.round(m)}M` : `$${m.toFixed(1)}M`;
  }
  if (dollars >= 1_000) {
    return `$${Math.round(dollars / 1_000)}K`;
  }
  return `$${Math.round(dollars).toLocaleString("en-US")}`;
}

/** Round to nearest $10K and format `$XXXK` or `$X.XM`. */
function formatRecaptureShort(dollars: number): string {
  const rounded = Math.round(dollars / 10_000) * 10_000;
  if (rounded >= 1_000_000) {
    const m = rounded / 1_000_000;
    return m >= 10 ? `$${Math.round(m)}M` : `$${m.toFixed(1)}M`;
  }
  return `$${Math.round(rounded / 1_000)}K`;
}

export interface RenderInitialEmailInput {
  brand: InitialTemplateBrand;
  contact: InitialTemplateContact;
  bundle: BrandEnrichmentBundle | null;
  revenue: RevenueLookup;
}

export function renderInitialEmail(input: RenderInitialEmailInput): RenderedEmail {
  const brandName = input.brand.name;
  const first = firstName(input.contact);
  const sellerCount = input.brand.keepa_unique_seller_count ?? input.bundle?.keepa.unique_seller_count ?? null;
  const brandControlled = input.brand.keepa_brand_controlled_pct ?? input.bundle?.keepa.brand_controlled_pct ?? null;
  const annualRevenue = annualRevenueDollars(input.revenue);

  // Profit recapture = revenue * (1 - brand_controlled_pct) * margin_assumption.
  // Margin assumption is documented at the top of this file. See spec §Placeholder mapping.
  let recaptureDollars: number | null = null;
  if (annualRevenue != null && brandControlled != null && Number.isFinite(brandControlled)) {
    const resellerShare = Math.max(0, Math.min(1, 1 - brandControlled));
    const dollars = annualRevenue * resellerShare * MARGIN_ASSUMPTION;
    if (dollars > 0 && Number.isFinite(dollars)) recaptureDollars = dollars;
  }

  // ---------- subject ----------
  // Fallback if recapture cannot be computed.
  const subject =
    recaptureDollars != null
      ? `${brandName} is leaving ~${formatRecaptureShort(recaptureDollars)} on the table`
      : `${brandName} — channel ownership audit`;

  // ---------- "doing around / multiple resellers" sentence ----------
  // Spec graceful fallbacks:
  //   - revenue unknown → omit "doing around" sentence and use "your products are on Amazon, and"
  //   - reseller count unknown → "multiple third-party sellers are controlling the channel"
  let openerSentence: string;
  const resellersClause =
    sellerCount != null && sellerCount > 0
      ? `${sellerCount} third-party sellers are controlling the channel`
      : `multiple third-party sellers are controlling the channel`;

  if (annualRevenue != null) {
    openerSentence =
      `The short version: your products appear to be doing around ${formatRevenueShort(annualRevenue)} per year on Amazon, ` +
      `but it looks like ${resellersClause}.`;
  } else {
    openerSentence =
      `The short version: your products are on Amazon, and it looks like ${resellersClause}.`;
  }

  // ---------- text body (verbatim per spec, with substitutions) ----------
  const text =
    `Hi ${first},\n\n` +
    `My team and I just audited ${brandName} on Amazon.\n\n` +
    `${openerSentence}\n\n` +
    `That usually creates two problems.\n\n` +
    `First, margin leaks to resellers.\n\n` +
    `Second, the customer experience gets messy — inconsistent pricing, inconsistent packaging, inconsistent listings, and nobody representing the brand the way the brand owner would.\n\n` +
    `I've lived this firsthand. When we took control of Amazon at Diversified Hospitality, we didn't just capture reseller margin. We grew the Amazon channel to roughly $10M/year because no one cared about the brand, listings, packaging, reviews, and customer experience like we did.\n\n` +
    `We put together a short report showing what we found for ${brandName}, where the profit may be leaking, and what the channel could look like if you controlled it directly.\n\n` +
    `Are you the right person to send it to?\n\n` +
    `Best,\n` +
    `Steve Rolle`;

  const html = textToHtml(text);
  return { subject, html, text };
}

function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}
