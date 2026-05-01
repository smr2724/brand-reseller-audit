/**
 * Phase 6 outreach draft generation.
 *
 * Produces three tone variants (direct / curious / educational) for a single
 * brand+contact pair, in Steve's operator-to-operator voice. Strictly
 * draft-only — these do NOT get sent.
 */

import OpenAI from "openai";
import { formatMoney, formatNumber } from "@/lib/utils";

export type Tone = "direct" | "curious" | "educational";
export const TONES: Tone[] = ["direct", "curious", "educational"];

export interface DraftBrandContext {
  id: string;
  name: string;
  category?: string | null;
  est_monthly_revenue?: number | null;
  trailing_12_months?: number | null;
  dominant_seller_sales_pct?: number | null;
  dominant_seller_name?: string | null;
  dominant_seller_country?: string | null;
  total_products?: number | null;
  avg_sellers?: number | null;
}

export interface DraftContactContext {
  id: string;
  full_name: string;
  first_name?: string | null;
  title?: string | null;
}

export interface DraftVariant {
  tone: Tone;
  subject: string;
  body_text: string;
  body_html: string;
  model: string;
}

export interface DraftBundle {
  variants: DraftVariant[];
  signal_used: string;
  model: string;
}

const MODEL = "gpt-4o-mini";

const SYSTEM_PROMPT = `You write first-touch outreach emails for Steve Rolle, founder of Rolle Consulting Group.

Steve helps brand owners take ownership of their Amazon channel — capturing the revenue resellers are currently pocketing. He has been the operator himself (Diversified Hospitality Solutions: Amazon revenue $8.34M → $9.02M, valuation roughly doubled). He never oversells.

VOICE — match exactly:
- Operator to operator. Second person. Brief. Confident but never pushy.
- Open with a specific observation about their Amazon footprint, often phrased as a question.
- Plain English. Short sentences. No buzzwords. No "hope this finds you well." No flattery.
- Hedge dollar/percent claims qualitatively ("looks like roughly 60% of velocity", "what looks like meaningful upside") — never invent precise numbers we don't have.
- One ask only: a 15-minute roadmap call. No double-CTAs, no calendar links, no "would love to chat."
- Never pushy. Never "amazing" or "revolutionary" or "leverage" or "synergy." No fake quotes. No fabricated stats.

CONTENT — every variant must include:
- One personalized brand signal taken from the data we provide (dominant seller %, monthly revenue, ASIN count, etc.)
- A short framing of the problem (resellers running their channel, brand-control gap, profit leakage)
- One concrete ask: "worth 15 minutes?" or "open to a quick call?"
- 110–160 words in body_text. Subject ≤ 70 chars, lowercase, mentions brand or Amazon channel.

VARIANTS:
- "direct" — pose the observation as a flat statement, end with the 15-min ask. Pattern: "Saw [signal]. Worth 15 minutes to walk through what that's costing you?"
- "curious" — open with a question, conversational. Pattern: "Quick question on [brand]'s Amazon channel — are you running it in-house, or through resellers today?"
- "educational" — briefly reference how a similar brand reclaimed their channel (DHS), then make the ask. No claims of guaranteed outcomes; hedge the dollar math.

Return JSON with key "variants" — array of three objects, in order [direct, curious, educational]:
  { "tone": "direct"|"curious"|"educational", "subject": "...", "body_text": "..." }

The signature on every body_text must be exactly:

Steve Rolle
Rolle Consulting Group
steve@rolleconsulting.com`;

export async function generateOutreachDraftVariants(opts: {
  brand: DraftBrandContext;
  contact: DraftContactContext;
  tone?: Tone;
  reportId?: string | null;
}): Promise<DraftBundle> {
  const { brand, contact, reportId } = opts;
  const signal = pickPrimarySignal(brand);

  if (!process.env.OPENAI_API_KEY) {
    return {
      variants: TONES.map(t => placeholderVariant(t, brand, contact, signal)),
      signal_used: signal.label,
      model: "placeholder",
    };
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const userPayload = {
    brand: {
      name: brand.name,
      category: brand.category ?? null,
      est_monthly_revenue: brand.est_monthly_revenue ?? null,
      trailing_12_months: brand.trailing_12_months ?? null,
      dominant_seller_name: brand.dominant_seller_name ?? null,
      dominant_seller_sales_pct: brand.dominant_seller_sales_pct ?? null,
      dominant_seller_country: brand.dominant_seller_country ?? null,
      total_products: brand.total_products ?? null,
      avg_sellers: brand.avg_sellers ?? null,
    },
    contact: {
      first_name: contact.first_name ?? contact.full_name.split(" ")[0],
      full_name: contact.full_name,
      title: contact.title ?? null,
    },
    primary_signal: signal,
    has_audit_report: !!reportId,
    rules: [
      "Three variants: direct, curious, educational, in that order.",
      "Use the primary_signal verbatim or as a hedged paraphrase.",
      "End body_text with the signature block exactly as instructed.",
      "Each body 110-160 words.",
    ],
  };

  // 2 retries with falling-temperature.
  const temperatures = [0.55, 0.4, 0.3];
  for (const temp of temperatures) {
    try {
      const resp = await client.chat.completions.create({
        model: MODEL,
        temperature: temp,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Generate three variants for this brand/contact:\n\n${JSON.stringify(userPayload, null, 2)}` },
        ],
      });
      const txt = resp.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(txt);
      const arr = Array.isArray(parsed?.variants) ? parsed.variants : [];
      if (arr.length >= 1) {
        const variants: DraftVariant[] = TONES.map(t => {
          const found = arr.find((v: any) => String(v?.tone ?? "").toLowerCase() === t)
            ?? arr[TONES.indexOf(t)] // positional fallback
            ?? null;
          if (found && typeof found.body_text === "string" && typeof found.subject === "string") {
            const subject = String(found.subject).slice(0, 200);
            const body_text = String(found.body_text);
            return {
              tone: t,
              subject,
              body_text,
              body_html: textToHtml(body_text),
              model: MODEL,
            };
          }
          return placeholderVariant(t, brand, contact, signal);
        });
        return { variants, signal_used: signal.label, model: MODEL };
      }
    } catch {
      // try next temperature
    }
  }

  // Final fallback: deterministic templates.
  return {
    variants: TONES.map(t => placeholderVariant(t, brand, contact, signal)),
    signal_used: signal.label,
    model: "fallback-template",
  };
}

interface BrandSignal {
  label: string;
  phrase: string;
}

function pickPrimarySignal(brand: DraftBrandContext): BrandSignal {
  const dom = brand.dominant_seller_sales_pct;
  if (dom != null && dom > 0) {
    const country = brand.dominant_seller_country
      ? ` ${brand.dominant_seller_country === "US" ? "" : "non-US "}seller`
      : " seller";
    const pctText = formatNumber(dom, { decimals: 0 });
    return {
      label: "dominant_seller_pct",
      phrase: `one${country} taking what looks like roughly ${pctText}% of velocity`,
    };
  }
  if (brand.est_monthly_revenue && brand.est_monthly_revenue > 0) {
    return {
      label: "monthly_revenue",
      phrase: `Amazon channel doing in the neighborhood of ${formatMoney(brand.est_monthly_revenue)}/mo`,
    };
  }
  if (brand.trailing_12_months && brand.trailing_12_months > 0) {
    return {
      label: "trailing_12_months",
      phrase: `roughly ${formatMoney(brand.trailing_12_months)} on Amazon over the trailing twelve`,
    };
  }
  if (brand.total_products && brand.total_products > 0) {
    return {
      label: "asin_count",
      phrase: `${formatNumber(brand.total_products)} ASINs on Amazon today`,
    };
  }
  if (brand.avg_sellers && brand.avg_sellers > 1) {
    return {
      label: "avg_sellers",
      phrase: `multiple sellers (about ${formatNumber(brand.avg_sellers, { decimals: 0 })} on average) on your listings`,
    };
  }
  return {
    label: "generic",
    phrase: `your Amazon footprint looks like it's being run by someone else`,
  };
}

function placeholderVariant(
  tone: Tone,
  brand: DraftBrandContext,
  contact: DraftContactContext,
  signal: BrandSignal
): DraftVariant {
  const first = contact.first_name ?? contact.full_name.split(" ")[0] ?? "there";
  const sig = `\n\nSteve Rolle\nRolle Consulting Group\nsteve@rolleconsulting.com`;

  let subject: string;
  let body_text: string;

  if (tone === "direct") {
    subject = `${brand.name.toLowerCase()} on amazon — quick read`;
    body_text =
      `Hi ${first},\n\n` +
      `Pulled ${brand.name}'s Amazon footprint this morning. Saw ${signal.phrase} — and it doesn't look like ${brand.name} is running the channel directly.\n\n` +
      `That usually means meaningful margin sitting with resellers instead of the brand, plus inconsistent pricing and packaging on the listing. ` +
      `I'm an operator — I've been on the brand side of this exact transition before and it's usually less complicated than it looks.\n\n` +
      `Worth 15 minutes to walk through what it looks like to take that channel back? No deck, no pitch — just the numbers as I see them.${sig}`;
  } else if (tone === "curious") {
    subject = `quick question on ${brand.name.toLowerCase()}'s amazon channel`;
    body_text =
      `Hi ${first},\n\n` +
      `Quick question on ${brand.name}'s Amazon channel — are you running it in-house today, or is it mostly through resellers?\n\n` +
      `Reason I ask: I noticed ${signal.phrase}, which is the pattern I usually see right before a brand decides to take the channel back. ` +
      `I've been the brand owner who made that call myself.\n\n` +
      `Open to 15 minutes to walk through what your footprint looks like from the outside? Happy to share what I'm seeing either way.${sig}`;
  } else {
    subject = `taking ${brand.name.toLowerCase()}'s amazon channel back — the playbook`;
    body_text =
      `Hi ${first},\n\n` +
      `I help brand owners reclaim their Amazon channel from resellers. The data on ${brand.name} looks familiar — ${signal.phrase}.\n\n` +
      `A hospitality brand we worked with had the same shape: resellers running everything, inconsistent pricing, off-brand packaging. ` +
      `After they took the channel back, Amazon revenue grew from roughly $8.3M to $9M in a year and the valuation roughly doubled. ` +
      `Hedging that — every brand is different, and the path depends on your wholesale agreements and SKU mix.\n\n` +
      `Worth 15 minutes to walk through how that would map onto ${brand.name}?${sig}`;
  }

  return {
    tone,
    subject,
    body_text,
    body_html: textToHtml(body_text),
    model: "fallback-template",
  };
}

function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // double-newline → paragraph break, single newline → <br>.
  return escaped
    .split(/\n{2,}/)
    .map(p => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}
