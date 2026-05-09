/**
 * Phase 8 — Per-section LLM calls for the v2 audit narrative.
 *
 * Each section is a separate OpenAI call with strict JSON output via a
 * tool-call schema. We feed in only the data relevant to that section
 * to keep prompts crisp, and we enforce the same anchor voice across
 * all calls. Word limits are inlined per section.
 *
 * If OPENAI_API_KEY is missing or any individual section call fails,
 * we fall back to a deterministic template per section so the report
 * still ships — but assemble.ts records `data_sources.openai = false`.
 */
import OpenAI from "openai";
import type { BrandEnrichmentBundle } from "@/lib/enrichment";
import type { BrandForReport } from "@/lib/report/narrative";
import { DIVERSIFIED_HOSPITALITY_CASE_STUDY } from "./case-studies";
import type { CompetitorSnapshot } from "./enrich";
import type {
  NarrativeCompetitorBenchmark,
  NarrativeCxAudit,
  NarrativeMath,
  NarrativeResellerDossier,
  NarrativeResellerReality,
} from "./types";

const ANCHOR = `You are writing a Channel Ownership Audit on behalf of Rolle Consulting Group (RCG). Voice: Steve Rolle, conversational but data-led. Never hedge with "approximately," "illustrative," "potentially," or "roughly." If a number is null, write "— not measured" rather than inventing one. Cite at least one Keepa metric AND one DataForSEO metric per claim where possible. Second person ("you", "your brand"). Short sentences. No buzzwords, no exclamation points, no flattery.`;

interface ToolSchemaParam {
  model: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  userPayload: unknown;
  userInstruction: string;
  /** Optional cap so a single section can't blow our 5K-token budget. */
  maxTokens?: number;
}

async function callJsonTool<T>(
  client: OpenAI,
  p: ToolSchemaParam,
): Promise<T | null> {
  // Phase 22 — Single attempt; the OpenAI client already retries once
  // internally on transient errors. A second app-level attempt was
  // adding up to 1.5s of sleep + a full second LLM call per failed
  // section, and with eight sections in parallel that's a real budget hit.
  for (let attempt = 0; attempt < 1; attempt++) {
    try {
      const resp = await client.chat.completions.create({
        model: p.model,
        temperature: 0.3,
        max_tokens: p.maxTokens ?? 600,
        tools: [
          {
            type: "function",
            function: {
              name: p.toolName,
              description: p.toolDescription,
              parameters: p.schema,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: p.toolName } },
        messages: [
          { role: "system", content: ANCHOR },
          {
            role: "user",
            content: `${p.userInstruction}\n\nDATA:\n${JSON.stringify(
              p.userPayload,
              null,
              2,
            )}`,
          },
        ],
      });
      const call = resp.choices?.[0]?.message?.tool_calls?.[0];
      const args =
        call && "function" in call ? call.function?.arguments : undefined;
      if (!args) throw new Error("no tool call returned");
      return JSON.parse(args) as T;
    } catch (e) {
      console.warn(`[v2/narrative] section '${p.toolName}' failed:`, e);
      return null;
    }
  }
  return null;
}

function getClient(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  // Phase 22 — Hard 45s deadline + at-most-1 retry per section so a
  // single slow section can't blow the function budget. Eight sections
  // run in Promise.all, so a worst-case path is bounded by the slowest
  // section, not by the sum.
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 45_000,
    maxRetries: 1,
  });
}

const MODEL = process.env.OPENAI_MODEL_REPORTS || "gpt-4o-mini";

// =====================================================================
// Cover headline (≤ 30 words)
// =====================================================================

// Amazon merchant IDs (e.g. AP3VA1GJZM3EQ) read like junk on the cover.
const AMAZON_SELLER_ID_RE = /^A[A-Z0-9]{12,13}$/;
function friendlyResellerLabel(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  return AMAZON_SELLER_ID_RE.test(s) ? `an unbranded 3P seller (Amazon ID: ${s})` : s;
}

// =====================================================================
// Phase 46 — Sanitizer that fail-closes against any LLM output naming a
// brand-controlled seller. The check is deliberately broad: if a seller
// the user classified `brand_owned` / `authorized` / `amazon` appears
// anywhere in the body, we treat the body as compromised and the
// caller falls back to the deterministic fallback (which is built from
// the filtered data and CAN'T name a brand-controlled seller).
// =====================================================================

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface SanitizedText {
  text: string;
  /** True when the LLM body mentioned a brand-controlled seller name —
   *  the caller treats this as a failure and uses the fallback. */
  tripped: boolean;
}

export function makeBrandOwnedNamingSanitizer(
  brandControlledNames: string[],
): (input: string) => SanitizedText {
  // Strip empties + dedupe + sort longest-first so "Bigelow Chemists LLC"
  // is matched before "Bigelow Chemists" when both are in the list.
  const names = Array.from(
    new Set(
      (brandControlledNames ?? [])
        .map((n) => (n ?? "").trim())
        .filter((n) => n.length >= 3),
    ),
  ).sort((a, b) => b.length - a.length);
  const patterns = names.map((n) => new RegExp(`\\b${escapeRegex(n)}\\b`, "i"));

  return (input: string): SanitizedText => {
    if (!input) return { text: input ?? "", tripped: false };
    for (const re of patterns) {
      if (re.test(input)) {
        return { text: input, tripped: true };
      }
    }
    return { text: input, tripped: false };
  };
}

export async function llmCoverHeadline(input: {
  brandName: string;
  topReseller: string | null;
  topResellerSharePct: number | null;
  annualLeak: number | null;
  exitLift: number | null;
  brandedSearchVolume: number | null;
}): Promise<string> {
  // Cover headline is purely deterministic now — the brief specifies the
  // exact template ("you can recapture $X in annual profit and $Y in
  // business value — without adding a single new customer"). LLM
  // free-text drift on this line was the failure mode of v2.0.
  return fallbackHeadline(input);
}

function fallbackHeadline(input: {
  brandName: string;
  topReseller: string | null;
  topResellerSharePct: number | null;
  annualLeak: number | null;
  exitLift: number | null;
}): string {
  const profit =
    input.annualLeak != null
      ? `$${Math.round(input.annualLeak).toLocaleString("en-US")}`
      : null;
  const value =
    input.exitLift != null
      ? `$${Math.round(input.exitLift).toLocaleString("en-US")}`
      : null;

  if (profit && value) {
    return `${input.brandName}, you can recapture ${profit} in annual profit and ${value} in business value — without adding a single new customer.`;
  }
  if (profit) {
    return `${input.brandName}, you can recapture ${profit} in annual profit — without adding a single new customer.`;
  }
  // Soft fallback when the math wasn't computable (no revenue at all).
  return `${input.brandName}, you can recapture significant profit and business value from your Amazon channel — without adding a single new customer.`;
}

// =====================================================================
// Reseller Reality one-liner
// =====================================================================

export async function llmResellerRealityLine(
  reality: NarrativeResellerReality,
  bundle: BrandEnrichmentBundle,
): Promise<string> {
  const client = getClient();
  const fb = fallbackResellerRealityLine(reality, bundle);
  if (!client) return fb;

  type Out = { one_liner: string };
  const result = await callJsonTool<Out>(client, {
    model: MODEL,
    toolName: "emit_reseller_reality_line",
    toolDescription: "One short sentence (≤ 25 words) describing the reseller landscape.",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { one_liner: { type: "string" } },
      required: ["one_liner"],
    },
    userInstruction:
      "Write one sentence (max 25 words) describing the THIRD-PARTY reseller landscape — the sellers riding on the brand's listings. " +
      "Sellers tagged `is_brand_controlled=true` are the brand's own selling entity (e.g. an LLC) and must be EXCLUDED from any reseller share you cite. " +
      "Cite the unique seller count and the top reseller's share, where 'top reseller' is the largest seller with `is_brand_controlled=false` (or null).",
    userPayload: {
      top_sellers: reality.top_sellers.slice(0, 5),
      unique_seller_count: bundle.keepa.unique_seller_count,
      brand_controlled_pct: bundle.keepa.brand_controlled_pct,
    },
    maxTokens: 100,
  });
  return result?.one_liner?.trim() || fb;
}

function fallbackResellerRealityLine(
  reality: NarrativeResellerReality,
  bundle: BrandEnrichmentBundle,
): string {
  // Phase 23 — describe the *reseller* landscape, not the brand's own
  // LLC sitting at the top.
  const top =
    reality.top_sellers.find((s) => s.is_brand_controlled !== true) ??
    reality.top_sellers[0];
  const sellers = bundle.keepa.unique_seller_count ?? reality.top_sellers.length;
  if (!top) return `Keepa captured ${sellers} sellers on your listings.`;
  const share =
    top.share_pct != null ? `${Math.round(top.share_pct * 100)}%` : "— not measured";
  return `${sellers} sellers compete on your listings; ${top.seller_name} alone holds ${share} of buy boxes.`;
}

// =====================================================================
// Reseller Dossier risk profile (≤ 200 words)
// =====================================================================

export async function llmDossierRisk(
  dossier: Omit<NarrativeResellerDossier, "risk_profile">,
  brand: BrandForReport,
): Promise<string> {
  const client = getClient();
  const fb = fallbackDossierRisk(dossier, brand);
  if (!client) return fb;

  type Out = { risk_profile: string };
  const result = await callJsonTool<Out>(client, {
    model: MODEL,
    toolName: "emit_dossier_risk_profile",
    toolDescription:
      "Write a forensic 1-paragraph profile (≤ 80 words) describing what this seller is doing on the brand's listings. Description only — no recommendations.",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { risk_profile: { type: "string" } },
      required: ["risk_profile"],
    },
    userInstruction:
      "Write ONE paragraph, max 80 words, describing what this seller is doing on the brand's listings. Forensic only: name what they're doing in concrete terms, cite their share % and ASINs-won count from the data, and end with the implication for the brand owner (margin pressure, buy-box loss, channel fragmentation). " +
      "HARD RULES (the dossier is forensic, not prescriptive — solutions live in the Five-Step Framework, NOT here): " +
      "(1) NEVER recommend MAP enforcement, MAP policy, Minimum Advertised Price, distributor terms changes, wholesale agreement updates, an in-house team, or any DIY tactic. (2) NEVER name a solution at all. No 'enforce', no 'consider', no 'should'. (3) NEVER use the words: vital, crucial, essential, leverage (as verb), stakeholder, ecosystem, synergy, best-in-class, strategic (adjective). (4) Operator voice: direct, specific, no hedging buzzwords. (5) Reference at least one concrete number from the data (share_pct, asins_won, country if present, fulfilment_mix). If the data has no measurable share_pct AND no asins_won, return an empty string — better silent than generic. " +
      "If `country` is null, OMIT geographic language entirely (do not write 'from — not measured'). Plain markdown, no headings.",
    userPayload: { dossier, brand_name: brand.name, brand_country_match: dossier.country },
    maxTokens: 500,
  });
  return result?.risk_profile?.trim() || fb;
}

function fallbackDossierRisk(
  dossier: Omit<NarrativeResellerDossier, "risk_profile">,
  brand: BrandForReport,
): string {
  // Phase 55 — forensic-only fallback. No solutions, no recommendations.
  // If we have neither share_pct nor asins_won, return empty so the
  // renderer suppresses the paragraph entirely.
  const hasShare = dossier.share_pct != null;
  const hasAsins = dossier.asins_won != null && dossier.asins_won > 0;
  if (!hasShare && !hasAsins) return "";
  const share = hasShare
    ? `${Math.round((dossier.share_pct as number) * 100)}%`
    : null;
  const country = dossier.country;
  const mix = dossier.fulfilment_mix;
  const parts: string[] = [];
  if (share && hasAsins) {
    parts.push(
      `${dossier.seller_name} controls ${share} of buy-box wins across ${dossier.asins_won} ASINs on ${brand.name}'s catalog.`,
    );
  } else if (share) {
    parts.push(
      `${dossier.seller_name} controls ${share} of buy-box wins on ${brand.name}'s catalog.`,
    );
  } else if (hasAsins) {
    parts.push(
      `${dossier.seller_name} is winning the buy box on ${dossier.asins_won} of ${brand.name}'s ASINs.`,
    );
  }
  if (country) {
    parts.push(`Operates from ${country} on a ${mix} model.`);
  } else if (mix && mix !== "— not measured") {
    parts.push(`Operates on a ${mix} model.`);
  }
  parts.push(
    `That share is margin and channel control sitting outside ${brand.name}.`,
  );
  return parts.join(" ");
}

// =====================================================================
// CX Audit "what's broken" callouts (3 short bullets)
// =====================================================================

export async function llmCxBroken(
  cx: Omit<NarrativeCxAudit, "whats_broken">,
  brand: BrandForReport,
): Promise<string[]> {
  const client = getClient();
  const fb = fallbackCxBroken(cx, brand);
  if (!client) return fb;

  type Out = { callouts: string[] };
  const result = await callJsonTool<Out>(client, {
    model: MODEL,
    toolName: "emit_cx_callouts",
    toolDescription:
      "Three short bullet strings listing concrete listing problems. ≤ 22 words each.",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        callouts: {
          type: "array",
          items: { type: "string" },
          minItems: 3,
          maxItems: 3,
        },
      },
      required: ["callouts"],
    },
    userInstruction:
      "Return exactly 3 callouts. Each is ≤ 22 words and names a concrete listing problem you can infer from the data — low listing health score, missing keywords, weak SERP rank, etc. If a number is null, do not invent it.",
    userPayload: { cx, brand_name: brand.name },
    maxTokens: 300,
  });
  const arr = result?.callouts;
  return Array.isArray(arr) && arr.length === 3 ? arr.map((s) => String(s)) : fb;
}

function fallbackCxBroken(
  cx: Omit<NarrativeCxAudit, "whats_broken">,
  brand: BrandForReport,
): string[] {
  const out: string[] = [];
  // Surface concrete listing problems from the per-ASIN scorecard.
  const lowImages = cx.asin_scores.find((a) => a.images != null && a.images < 5);
  const noAPlus = cx.asin_scores.find((a) => a.has_a_plus === false);
  const noVideo = cx.asin_scores.find((a) => a.has_video === false);
  const lowRating = cx.asin_scores.find((a) => a.rating != null && a.rating < 4.0);

  if (lowImages) {
    out.push(
      `Listing ${lowImages.asin} ships with only ${lowImages.images} images — Amazon's content rubric expects 6+ for the buy-box gallery.`,
    );
  }
  if (out.length < 3 && lowRating) {
    out.push(
      `Listing ${lowRating.asin} carries a ${lowRating.rating!.toFixed(1)} star rating — every tenth of a point compounds against organic rank.`,
    );
  }
  if (out.length < 3 && noAPlus) {
    out.push(
      `Listing ${noAPlus.asin} has no A+ content — that's a free conversion lift Amazon gives Brand Registered sellers.`,
    );
  }
  if (out.length < 3 && noVideo) {
    out.push(
      `Listing ${noVideo.asin} ships without product video — a known buy-box conversion gap on Amazon.`,
    );
  }
  if (out.length < 3) {
    if (cx.branded_search_volume != null && cx.branded_search_volume > 0) {
      out.push(
        `Branded demand at ${cx.branded_search_volume.toLocaleString("en-US")}/mo (DataForSEO) is being routed to reseller storefronts, not your brand store.`,
      );
    } else {
      out.push(`Branded search volume — not measured this run; widen the keyword seed in the engagement.`);
    }
  }
  if (out.length < 3) {
    out.push(
      `Top branded keywords aren't owned by ${brand.name}'s storefront on the SERP, so paid demand converts to reseller margin.`,
    );
  }
  return out.slice(0, 3);
}

// =====================================================================
// Competitor Benchmark one-liner
// =====================================================================

export async function llmCompetitorLine(
  bench: NarrativeCompetitorBenchmark,
  brand: BrandForReport,
): Promise<string> {
  const client = getClient();
  const fb = fallbackCompetitorLine(bench, brand);
  if (!client) return fb;

  type Out = { one_liner: string };
  const result = await callJsonTool<Out>(client, {
    model: MODEL,
    toolName: "emit_competitor_one_liner",
    toolDescription:
      "One sentence (≤ 30 words) summarizing where the audited brand sits vs the competitor set.",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { one_liner: { type: "string" } },
      required: ["one_liner"],
    },
    userInstruction:
      "Write ONE sentence (≤ 30 words) comparing the audited brand to the competitor set on channel control. " +
      "ONLY use brand names and numbers that appear in the rows array. " +
      "Treat null fields as MISSING DATA — do not include them in averages and do not present them as zero. " +
      "If only one row is present (no competitors), respond with the literal string 'Competitor benchmark — not enough peers in this snapshot.' " +
      "If every competitor's brand_controlled_pct is null, drop the buy-box comparison and lean on the next-best measured field (listing_health, branded_search_volume, or unique_seller_count). " +
      "Do not invent brand names. Do not use 'XYZ Corp' or any placeholder.",
    userPayload: { rows: bench.rows, brand_name: brand.name },
    maxTokens: 120,
  });
  return result?.one_liner?.trim() || fb;
}

function fallbackCompetitorLine(
  bench: NarrativeCompetitorBenchmark,
  brand: BrandForReport,
): string {
  const audited = bench.rows.find((r) => r.is_audited_brand);
  const competitors = bench.rows.filter((r) => !r.is_audited_brand);
  if (!audited || competitors.length === 0) {
    return "Competitor benchmark — not enough peers in this snapshot.";
  }

  const named = competitors.map((c) => c.brand).slice(0, 2).join(" and ");
  const peerLabel = `${competitors.length} competitor${
    competitors.length === 1 ? "" : "s"
  } (${named})`;

  // Average each measured column across competitors, skipping nulls. We
  // pick the FIRST column where both the audited row and ≥ 1 competitor
  // have a number — guarantees we cite real data rather than printing
  // a bogus "0-point lead" computed against a sea of nulls.
  const auditedPct = audited.brand_controlled_pct;
  const peerPcts = competitors
    .map((r) => r.brand_controlled_pct)
    .filter((p): p is number => typeof p === "number");

  if (auditedPct != null && peerPcts.length) {
    const avgPct = peerPcts.reduce((a, b) => a + b, 0) / peerPcts.length;
    const auditedRound = Math.round(auditedPct * 100);
    const avgRound = Math.round(avgPct * 100);
    if (auditedRound === 0 && avgRound === 0) {
      return `${brand.name} and its peers (${named}) all sit at 0% brand-controlled — the whole category is owned by resellers right now.`;
    }
    const delta = auditedRound - avgRound;
    return `${brand.name} controls ${auditedRound}% of buy boxes vs ${avgRound}% peer average across ${peerLabel} — a ${Math.abs(delta)}-point ${delta >= 0 ? "lead" : "gap"}.`;
  }

  // No buy-box numbers for the peer set → fall back to listing_health,
  // then branded_search_volume, then unique_seller_count.
  const auditedHealth = audited.listing_health;
  const peerHealth = competitors
    .map((r) => r.listing_health)
    .filter((p): p is number => typeof p === "number");
  if (auditedHealth != null && peerHealth.length) {
    const avg = Math.round(peerHealth.reduce((a, b) => a + b, 0) / peerHealth.length);
    const delta = auditedHealth - avg;
    return `${brand.name}'s listing health scores ${auditedHealth}/100 vs ${avg} peer average across ${peerLabel} — a ${Math.abs(delta)}-point ${delta >= 0 ? "lead" : "gap"}.`;
  }

  const auditedVol = audited.branded_search_volume;
  const peerVol = competitors
    .map((r) => r.branded_search_volume)
    .filter((p): p is number => typeof p === "number");
  if (auditedVol != null && peerVol.length) {
    const avg = Math.round(peerVol.reduce((a, b) => a + b, 0) / peerVol.length);
    return `${brand.name}'s branded search volume sits at ${auditedVol.toLocaleString("en-US")}/mo vs a ${avg.toLocaleString("en-US")}/mo average across ${peerLabel}.`;
  }

  const auditedSellers = audited.unique_seller_count;
  const peerSellers = competitors
    .map((r) => r.unique_seller_count)
    .filter((p): p is number => typeof p === "number");
  if (auditedSellers != null && peerSellers.length) {
    const avg = Math.round(peerSellers.reduce((a, b) => a + b, 0) / peerSellers.length);
    return `${brand.name} has ${auditedSellers} sellers competing on its catalog vs ${avg} peer average across ${peerLabel}.`;
  }

  return `${brand.name} sits alongside ${named} on the same SERP — full channel-control benchmark runs in the engagement.`;
}

// =====================================================================
// Math notes (≤ 50 words)
// =====================================================================

export async function llmMathNotes(math: NarrativeMath): Promise<string> {
  const client = getClient();
  const fb =
    "Every line above is editable. Margin %, ops savings %, and the EBITDA multiple are RCG defaults; we tune them on your unit economics in week one.";
  if (!client) return fb;

  type Out = { notes: string };
  const result = await callJsonTool<Out>(client, {
    model: MODEL,
    toolName: "emit_math_notes",
    toolDescription:
      "≤ 50 words explaining how to read the math table and that assumptions are tunable.",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { notes: { type: "string" } },
      required: ["notes"],
    },
    userInstruction:
      "Write ≤ 50 words. Tell the prospect that every Assumption row is editable per-deal and we re-derive on their unit economics in week one. No hedging language.",
    userPayload: math,
    maxTokens: 200,
  });
  return result?.notes?.trim() || fb;
}

// =====================================================================
// 90-day plan (≤ 250 words across all bullets)
// =====================================================================

export interface PlanInput {
  brandName: string;
  /** Phase 46 — pre-filtered to the largest seller classified `reseller`.
   *  Null when no reseller is in the classification snapshot. */
  topReseller: string | null;
  uniqueSellerCount: number | null;
  brandedSearchVolume: number | null;
  /** Phase 46 — count of sellers classified `reseller`. */
  resellerSellerCount?: number;
  /** Phase 46 — see FiveStepInput. */
  brandControlledNames?: string[];
}

export async function llmPlan(p: PlanInput): Promise<{
  intro: string;
  columns: { label: string; bullets: string[] }[];
}> {
  const client = getClient();
  const fb = fallbackPlan(p);
  if (!client) return fb;

  type Out = {
    intro: string;
    columns: { label: string; bullets: string[] }[];
  };
  const result = await callJsonTool<Out>(client, {
    model: MODEL,
    toolName: "emit_90_day_plan",
    toolDescription:
      "Three columns labeled Days 1-30, 31-60, 61-90. Each has 4-5 short bullets. Total under 250 words.",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        intro: { type: "string" },
        columns: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: { type: "string" },
              bullets: {
                type: "array",
                items: { type: "string" },
                minItems: 4,
                maxItems: 5,
              },
            },
            required: ["label", "bullets"],
          },
        },
      },
      required: ["intro", "columns"],
    },
    userInstruction:
      "Write the 90-day transition plan. Use 3 columns labeled exactly 'Days 1-30', 'Days 31-60', 'Days 61-90'. 4-5 bullets each, ≤ 18 words each. Cover: Audit, Set Up, Protect (Brand Registry / monitoring / enforcement), Transition Resellers, Build Team. Use careful language ('transition', 'sequence', 'authorized seller map'). Avoid 'termination' / 'terminate' / 'unauthorized'. If many resellers exist, lean reseller transition into Days 1-30. If Brand Registry status unknown, put it in Days 1-30.\n\n" +
      "RESELLER NAMING RULE (CRITICAL): The ONLY seller you may name as a reseller, transition target, or party to be removed is `topReseller` in the data payload. That seller has been pre-filtered through the user's classification snapshot. If `topReseller` is null, do NOT name any specific seller — phrase the transition bullets generically (e.g. 'sequence reseller transition under written terms').",
    userPayload: {
      brandName: p.brandName,
      topReseller: p.topReseller,
      uniqueSellerCount: p.uniqueSellerCount,
      brandedSearchVolume: p.brandedSearchVolume,
      resellerSellerCount: p.resellerSellerCount ?? null,
      has_resellers: !!p.topReseller,
    },
    maxTokens: 700,
  });
  if (!result?.columns || result.columns.length !== 3) return fb;
  const sanitizer = makeBrandOwnedNamingSanitizer(p.brandControlledNames ?? []);
  const cleanedIntro = sanitizer((result.intro || "").trim());
  return {
    intro: (cleanedIntro.tripped ? fb.intro : cleanedIntro.text) || fb.intro,
    columns: result.columns.map((c, idx) => {
      const fbCol = fb.columns[idx];
      const bullets = (c.bullets ?? [])
        .map((b) => String(b))
        .map((b) => sanitizer(b))
        .map((s, j) => (s.tripped ? fbCol?.bullets[j] ?? s.text : s.text))
        .filter((b): b is string => !!b)
        .slice(0, 5);
      return { label: c.label, bullets };
    }),
  };
}

// =====================================================================
// Five-Step Framework (6-12 month "capture" plan)
// =====================================================================

export interface FiveStepInput {
  brandName: string;
  /** Phase 46 — the largest seller the user classified as `reseller`.
   *  NEVER pass the brand owner's own LLC here, even if it tops the
   *  raw Keepa share list. Null when no reseller exists in the
   *  classification snapshot — the prompt + fallback render an empty-
   *  resellers reference plan instead of inventing one. */
  topReseller: string | null;
  topResellerSharePct: number | null;
  uniqueSellerCount: number | null;
  brandControlledPct: number | null;
  annualLeak: number | null;
  exitLift: number | null;
  revenue: number | null;
  /** Phase 46 — count of sellers classified `reseller`. Used by Step 4
   *  copy + the empty-resellers fallback. */
  resellerSellerCount?: number;
  /** Phase 46 — seller names the user classified as brand_owned /
   *  authorized / amazon. The LLM is told NEVER to name them as
   *  resellers/transition targets, and the post-process sanitizer
   *  fail-closes against any such mention. */
  brandControlledNames?: string[];
}

interface FiveStepOut {
  steps: { number: number; title: string; body: string }[];
  closing: string;
}

const FIVE_STEP_TITLES: { number: number; title: string }[] = [
  { number: 1, title: "Identify the Opportunity through an Account Audit" },
  { number: 2, title: "Set Up Your Amazon Account" },
  { number: 3, title: "Protect Your Brand" },
  { number: 4, title: "Transition from Resellers Strategically" },
  { number: 5, title: "Build and Train an In-House Team" },
];

// Phase 55 — Hardcoded fallback bullets in Steve's operator voice. Used
// when the LLM-generated body trips the banned-phrase sanitizer, comes
// back empty, or otherwise contradicts Phase 1 framing. Each line is
// 1-2 sentences, references a concrete Amazon mechanic, and sits
// firmly inside Phase 1 (capture, channel control). Step 5 references
// the Phase 1 → Phase 2 hand-off without restating Phase 2 in detail.
const FIVE_STEP_FALLBACK_BULLETS: Record<number, string> = {
  1: "This report is the audit. We've measured trailing-12-month Amazon revenue, brand-controlled buy-box share, and the seller mix on your listings — those three numbers size the recoverable margin and tell us whether Phase 1 is even worth running.",
  2: "Brand Registry, A+, brand store, and storefront ownership transfer to the brand owner. Most brands either don't have these or have them stale — clean catalog mapping and fulfillment routing land here so the buy box rotates back to brand-controlled inventory, not into a vacuum.",
  3: "Brand Registry, Transparency, and third-party offer monitoring run continuously — every offer, every price move, every new listing watched and acted on. Resellers don't survive a serious enforcement program; this is what keeps the channel from re-fragmenting six months in.",
  4: "We map every active seller, classify each as authorized or unauthorized, and pursue removal in sequence — unauthorized first, authorized through written wholesale terms second. The recoverable margin moves from their P&L to yours without adding a single new customer.",
  5: "By month 9-12 the brand has the operational scaffolding to maintain Phase 1 results — the playbook, the team, the buy box. Phase 2, when you're ready, adds external strategy and execution capability on top.",
};

// Phase 55 — Banned-phrase regex sanitizer for Five-Step Framework
// bodies. The bullets read as templated filler when they contain
// "vital", "crucial", "essential", "well-structured", "comprehensive",
// "robust", "establish(ing)", "leverage" (verb), or
// "strategic" (adjective). On match, we drop the LLM output and
// substitute the hardcoded fallback for that step.
const FIVE_STEP_BANNED_PHRASES: RegExp[] = [
  /\b(?:vital|crucial|essential|well[- ]structured|comprehensive|robust)\b/gi,
  /\bestablish(?:ing|ed|es|ment)?\b/gi,
  /\bleverag(?:e|ing|ed|es)\b/gi,
  /\bstrategic(?:ally)?\b/gi,
  /\b(?:stakeholders?|ecosystems?|synergy|synergies)\b/gi,
  /\bbest[- ]in[- ]class\b/gi,
];

function fiveStepBodyTrippedSanitizer(body: string): boolean {
  for (const re of FIVE_STEP_BANNED_PHRASES) {
    re.lastIndex = 0;
    if (re.test(body)) return true;
  }
  return false;
}

const PLAN_CLOSING =
  "Year 1 is about capture — recovering the margin that's already there. Once your channel is brand-controlled and the leakage is closed, the question changes from 'how do we stop the bleeding' to 'how do we compound this into a meaningful business.' That's Phase 2, and it's a separate engagement we'll outline if and when capture lands. For now, focus on Phase 1 — the result of capture is what we're selling today, and it's what makes Phase 2 possible later.";

export async function llmFiveStepPlan(p: FiveStepInput): Promise<FiveStepOut> {
  const client = getClient();
  const fb = fallbackFiveStep(p);
  if (!client) return fb;

  // Phase 46 — Build a payload that EXCLUDES brand-controlled seller
  // names entirely. The model only ever sees the largest seller the
  // user classified as `reseller`. If no reseller exists, the model is
  // told to render reference copy without naming any seller.
  // Phase 55 — pre-round the dollar values BEFORE handing them to the
  // LLM. The Five-Step prompt was previously receiving the un-rounded
  // float (e.g. 135898.7), the LLM was free-styling the rendered string
  // ("$135,898" vs "$135,899"), and the executive summary used
  // Math.round() — producing the off-by-one inconsistency reviewers
  // flagged. Pre-rounding makes the LLM and the deterministic
  // formatter share the exact same source value.
  const annualLeakRounded =
    p.annualLeak != null ? Math.round(p.annualLeak) : null;
  const exitLiftRounded =
    p.exitLift != null ? Math.round(p.exitLift) : null;
  const revenueRounded =
    p.revenue != null ? Math.round(p.revenue) : null;
  const safePayload = {
    brandName: p.brandName,
    topReseller: p.topReseller,
    topResellerSharePct: p.topResellerSharePct,
    uniqueSellerCount: p.uniqueSellerCount,
    brandControlledPct: p.brandControlledPct,
    annualLeak: annualLeakRounded,
    exitLift: exitLiftRounded,
    revenue: revenueRounded,
    resellerSellerCount: p.resellerSellerCount ?? null,
    has_resellers: !!p.topReseller,
  };

  const result = await callJsonTool<FiveStepOut>(client, {
    model: MODEL,
    toolName: "emit_five_step_plan",
    toolDescription:
      "Emit the five-step capture plan, customized to this brand. Each step has a fixed title and a 2-3 sentence brand-specific body.",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        steps: {
          type: "array",
          minItems: 5,
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              number: { type: "integer", minimum: 1, maximum: 5 },
              title: { type: "string" },
              body: { type: "string" },
            },
            required: ["number", "title", "body"],
          },
        },
        closing: { type: "string" },
      },
      required: ["steps", "closing"],
    },
    userInstruction:
      "Return the Five-Step Framework with these EXACT titles, in order:\n" +
      FIVE_STEP_TITLES.map((s) => `${s.number}. ${s.title}`).join("\n") +
      "\n\nFor each step write a 1-2 sentence brand-specific body, max ~45 words. Write in second person ('your brand', 'your listings'). Reference the real numbers passed in (revenue, top reseller name + share %, unique seller count, annualLeak, exitLift) where relevant. Each body must reference ONE of: a dollar number, a percentage, a specific Amazon mechanic (buy box, BSR, A+, FBA, Brand Registry, Transparency, MAP infrastructure, storefront), or a specific transition risk.\n\n" +
      "HARD RULE — PHASE 1 ONLY: The Five-Step Framework is about Phase 1 — capture and channel control. Bullets stay focused on capture: removing resellers, taking the buy box, recovering margin on existing demand. DO NOT make growth promises. DO NOT detail advertising, paid media, DTC, new marketplaces, subscriptions, growth campaigns, international expansion, or net-new customer acquisition — those belong to Phase 2, covered elsewhere. You MAY reference Phase 2 as the destination once capture is complete (e.g. \"this sets up Phase 2\"), but the bullets themselves are Phase 1.\n\n" +
      "HARD RULE — VOICE: NEVER use the words: vital, crucial, essential, well-structured, comprehensive, robust, establish (or any inflection: establishing, established, establishment), leverage (as verb), strategic (as adjective), stakeholder, ecosystem, synergy, best-in-class. NEVER use templated phrases like 'Establishing a well-structured Amazon account is crucial.' Operator voice: direct, specific, concrete. If you can't write a step body that satisfies the rules above, return the empty string for `body` and the renderer will use a hardcoded fallback.\n\n" +
      "RESELLER NAMING RULE (CRITICAL): The ONLY seller you may name as a reseller, transition target, or party to be removed is `topReseller` in the data payload. That seller has been pre-filtered through the user's classification snapshot. If `topReseller` is null (or `has_resellers` is false), do NOT name any specific seller in Step 4 — write a brand-controlled reference body explaining that the channel is already brand-controlled and the reseller-transition step is offered as ongoing protection. Never reference any other seller name from training data, and never paraphrase a name the reader supplied elsewhere.\n\n" +
      "For the `closing` field, return verbatim: " + JSON.stringify(PLAN_CLOSING),
    userPayload: safePayload,
    maxTokens: 1200,
  });
  if (!result?.steps || result.steps.length !== 5) return fb;
  // Always force the canonical titles + ordering — LLM is allowed to
  // freelance on bodies but never on the framework names.
  const sanitizer = makeBrandOwnedNamingSanitizer(p.brandControlledNames ?? []);
  const steps = FIVE_STEP_TITLES.map(({ number, title }) => {
    const match = result.steps.find((s) => s.number === number);
    const fbBody = fb.steps.find((s) => s.number === number)!.body;
    const hardcodedFallback = FIVE_STEP_FALLBACK_BULLETS[number] ?? fbBody;
    const rawBody = (match?.body ?? "").trim();
    if (!rawBody) {
      // Phase 55 — empty LLM body falls through to the hardcoded
      // operator-voice fallback rather than to the older templated
      // fallback that used buzzwords.
      return { number, title, body: hardcodedFallback };
    }
    const sanitized = sanitizer(rawBody);
    // Fail-closed: if the LLM tried to name a brand-controlled seller in
    // a reseller context, drop the body entirely and use the fallback.
    if (sanitized.tripped) return { number, title, body: hardcodedFallback };
    // Phase 55 — banned-phrase guard. If the LLM emitted templated
    // filler ("vital", "crucial", "establish", etc.) we drop the body
    // and use the operator-voice hardcoded fallback for that step.
    if (fiveStepBodyTrippedSanitizer(sanitized.text)) {
      console.warn(
        `[v2/narrative] five-step body for step ${number} tripped banned-phrase sanitizer; using hardcoded fallback.`,
      );
      return { number, title, body: hardcodedFallback };
    }
    return { number, title, body: sanitized.text };
  });
  return { steps, closing: PLAN_CLOSING };
}

function fallbackFiveStep(p: FiveStepInput): FiveStepOut {
  const profit =
    p.annualLeak != null
      ? `$${Math.round(p.annualLeak).toLocaleString("en-US")}`
      : "the recoverable margin";
  const value =
    p.exitLift != null
      ? `$${Math.round(p.exitLift).toLocaleString("en-US")}`
      : "meaningful business value";
  const sellerCount =
    p.uniqueSellerCount != null ? `${p.uniqueSellerCount}` : "multiple";
  const brandPct =
    p.brandControlledPct != null
      ? `${Math.round(p.brandControlledPct * 100)}%`
      : "limited";
  const revenue =
    p.revenue != null
      ? `$${Math.round(p.revenue).toLocaleString("en-US")}`
      : "your trailing-12-month";

  // Phase 46 — Step 4 must NEVER name a brand-controlled seller. When
  // the user's classification snapshot leaves no reseller, render the
  // step as a reference protection plan instead of pretending one
  // exists. `topReseller` here is already filtered upstream by
  // `getLargestReseller(classificationSnapshot)`.
  const hasReseller = !!p.topReseller;
  const reseller = p.topReseller ?? "the leading reseller";
  const share =
    p.topResellerSharePct != null
      ? `${Math.round(p.topResellerSharePct * 100)}%`
      : null;

  const step1Body = hasReseller
    ? `Step 1 is already underway — this very report is your audit. We've measured ${revenue} in trailing 12-month Amazon revenue with only ${brandPct} brand-controlled buy box and ${sellerCount} third-party sellers (authorization unknown) led by ${reseller}${share ? ` at ${share} share` : ""}. The recoverable opportunity: ${profit}/year in margin and ${value} in business value.`
    : `Step 1 is already underway — this very report is your audit. We've measured ${revenue} in trailing 12-month Amazon revenue with ${brandPct} brand-controlled buy box. Based on your classifications, the channel is already operating under brand control; the framework below is offered as a reference plan for protecting that position long-term.`;

  const step4Body = hasReseller
    ? `Resellers come off the listings sequentially, not all at once — written terms, MAP enforcement, distribution-agreement controls. ${reseller}${share ? ` (${share} of buy box)` : ""} is first; the long tail follows. ${profit} in annual margin moves from their P&L to yours, without you adding a single new customer.`
    : `Based on your classifications, the channel is already brand-controlled — there are no third-party resellers to transition off your listings today. The framework below is offered as a reference for protecting that position long-term: written distribution terms, MAP enforcement, and a monitored authorized-seller list keep new resellers from showing up six months from now.`;

  return {
    steps: [
      {
        number: 1,
        title: "Identify the Opportunity through an Account Audit",
        body: step1Body,
      },
      {
        number: 2,
        title: "Set Up Your Amazon Account",
        body: `We stand up brand-controlled Seller Central or Vendor Central operations on ${p.brandName}'s behalf — clean catalog mapping, MAP infrastructure, fulfillment routing — so that when resellers come off the listings the buy box rotates back to you, not into a vacuum. No new SKUs, no new customers — same demand, owned correctly.`,
      },
      {
        number: 3,
        title: "Protect Your Brand",
        body: `Brand Registry, Transparency, and our 3rd-party monitoring stack go live for ${p.brandName} on Day 1. We watch every offer, every price move, every new listing — and enforce. The ${sellerCount} sellers competing on your catalog today don't survive a serious enforcement program.`,
      },
      {
        number: 4,
        title: "Transition from Resellers Strategically",
        body: step4Body,
      },
      {
        number: 5,
        title: "Build and Train an In-House Team",
        body: `${DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.narrativeStep5} By month 12, ${p.brandName} owns the channel: the playbook, the team, the buy box.`,
      },
    ],
    closing: PLAN_CLOSING,
  };
}

function fallbackPlan(p: PlanInput): {
  intro: string;
  columns: { label: string; bullets: string[] }[];
} {
  const heavyResellers = (p.uniqueSellerCount ?? 0) >= 6;
  // Phase 46 — Step 4 must NEVER name a brand-controlled seller.
  // `p.topReseller` is already filtered upstream to the largest seller
  // classified `reseller`; if that's null, render generic phrasing.
  const ceaseAndDesistBullet = p.topReseller
    ? `Issue cease-and-desist to ${p.topReseller} and 2–3 next worst`
    : "Sequence reseller transition under written terms; sell-out windows where appropriate";
  return {
    intro: `Here is exactly how we take ${p.brandName}'s channel back over the next ninety days. No black box.`,
    columns: [
      {
        label: "Days 1-30",
        bullets: [
          "Full audit: SKU map, every reseller, MAP gaps, Brand Registry status",
          heavyResellers
            ? ceaseAndDesistBullet
            : "Open dialogue with top reseller; lock distribution agreements",
          "Lock pricing controls and MAP enforcement infrastructure",
          "Stand up brand-controlled Seller Central or Vendor Central operations",
          "Open weekly status review with brand leadership",
        ],
      },
      {
        label: "Days 31-60",
        bullets: [
          "Reclaim buy box on top 10 ASINs through brand-controlled offers",
          "Listing rebuild: A+, video, Brand Story, image stack to spec",
          "Enforce MAP on residual resellers; remove holdouts",
          "Spin up branded paid search defending top branded keywords",
          "Begin DTC + Subscribe & Save funnels for repeat-purchase SKUs",
        ],
      },
      {
        label: "Days 61-90",
        bullets: [
          "Hand off day-to-day operations to brand team or RCG-staffed team",
          "Quarterly buy-box, pricing, review-velocity dashboards live",
          "Performance-based compensation review against pre-engagement baseline",
          "Roadmap for international expansion (Canada, EU, MX)",
          "Document the playbook so the brand owns it forever",
        ],
      },
    ],
  };
}
