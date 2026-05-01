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
  for (let attempt = 0; attempt < 2; attempt++) {
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
      if (attempt === 1) {
        console.warn(`[v2/narrative] section '${p.toolName}' failed:`, e);
        return null;
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return null;
}

function getClient(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

export async function llmCoverHeadline(input: {
  brandName: string;
  topReseller: string | null;
  topResellerSharePct: number | null;
  annualLeak: number | null;
  brandedSearchVolume: number | null;
}): Promise<string> {
  const client = getClient();
  const friendlyTopReseller = friendlyResellerLabel(input.topReseller);
  const promptInput = { ...input, topReseller: friendlyTopReseller };
  const fb = fallbackHeadline(promptInput);
  if (!client) return fb;

  type Out = { headline: string };
  const result = await callJsonTool<Out>(client, {
    model: MODEL,
    toolName: "emit_cover_headline",
    toolDescription:
      "Emit one sentence (≤ 30 words) summarizing the brand's reseller exposure for the cover of the audit.",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        headline: { type: "string" },
      },
      required: ["headline"],
    },
    userInstruction:
      "Write one sentence headline (max 30 words) for the audit cover. " +
      "If `annualLeak` is a number, lead with the dollar leak — e.g. " +
      "\"<Brand> is on track to lose $<X> to Amazon resellers over the next 12 months.\" " +
      "If `annualLeak` is null, do NOT say \"not measured\"; instead lead with " +
      "the buy-box exposure — e.g. \"<Brand> has measurable reseller exposure on Amazon, with the top reseller <Y> holding a <Z>% share.\" " +
      "Always cite the top reseller and their % share when both are present. " +
      "No 'approximately', no exclamation points, no hedging.",
    userPayload: promptInput,
    maxTokens: 140,
  });
  const out = result?.headline?.trim();
  return out || fb;
}

function fallbackHeadline(input: {
  brandName: string;
  topReseller: string | null;
  topResellerSharePct: number | null;
  annualLeak: number | null;
}): string {
  const sharePct =
    input.topResellerSharePct != null ? Math.round(input.topResellerSharePct * 100) : null;
  const reseller = input.topReseller;

  if (input.annualLeak != null) {
    const leak = `$${Math.round(input.annualLeak).toLocaleString("en-US")}`;
    const tail =
      reseller && sharePct != null
        ? ` ${reseller} alone holds ${sharePct}% of buy-box share.`
        : "";
    return `${input.brandName} is on track to lose ${leak} in profit to Amazon resellers over the next 12 months.${tail}`.trim();
  }

  // No revenue / margin inputs — soften the headline rather than print
  // "— not measured" on the cover.
  if (reseller && sharePct != null) {
    return `${input.brandName} has measurable reseller exposure on Amazon, with the top reseller ${reseller} holding a ${sharePct}% share.`;
  }
  if (sharePct != null) {
    return `${input.brandName} has measurable reseller exposure on Amazon, with the top reseller holding a ${sharePct}% share.`;
  }
  return `${input.brandName} has measurable reseller exposure on Amazon — buy-box ownership is split across multiple third-party sellers.`;
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
      "Write one sentence (max 25 words) describing the reseller landscape. Cite the unique seller count and the top seller's share.",
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
  const top = reality.top_sellers[0];
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
      "Write a 150–200 word risk profile of the dominant reseller. Classify them and explain what to do about it.",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { risk_profile: { type: "string" } },
      required: ["risk_profile"],
    },
    userInstruction:
      "Write a 150–200 word risk profile of this reseller. Classify them as one of: classic 3PL diverter, unauthorized importer, authorized but undercutting, or arbitrage seller — pick whichever fits the data. Explain the risk to the brand in plain English. End with the practical move (terminate, MAP-enforce, or buy them out). Do not invent facts about who owns the seller — work only from the data provided. Plain markdown, no headings.",
    userPayload: { dossier, brand_name: brand.name, brand_country_match: dossier.country },
    maxTokens: 500,
  });
  return result?.risk_profile?.trim() || fb;
}

function fallbackDossierRisk(
  dossier: Omit<NarrativeResellerDossier, "risk_profile">,
  brand: BrandForReport,
): string {
  const share =
    dossier.share_pct != null
      ? `${Math.round(dossier.share_pct * 100)}%`
      : "— not measured";
  const country = dossier.country ?? "— not measured";
  const mix = dossier.fulfilment_mix;
  return `${dossier.seller_name} is the dominant seller on ${brand.name}'s catalog, holding ${share} of buy-box wins (Keepa). They operate from ${country} on a ${mix} model. Without a written authorization, they are running your channel without a contract — every margin point they keep is one you wrote off. The pattern fits a classic 3PL diverter: low overhead, no investment in the brand, undercutting MSRP to win the buy box. The practical move is one of three: (1) terminate and enforce MAP plus distribution-agreement controls, (2) bring them on as an authorized partner under written terms, or (3) buy them out on a one-time basis. We will run that decision tree with you in the first two weeks.`;
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
  topReseller: string | null;
  uniqueSellerCount: number | null;
  brandedSearchVolume: number | null;
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
      "Write the 90-day takeover plan. Use 3 columns labeled exactly 'Days 1-30', 'Days 31-60', 'Days 61-90'. 4-5 bullets each, ≤ 18 words each. Cover: Audit, Set Up, Protect (Brand Registry / monitoring / enforcement), Transition / Remove Resellers, Build Team. If many resellers exist, lean reseller termination into Days 1-30. If Brand Registry status unknown, put it in Days 1-30.",
    userPayload: p,
    maxTokens: 700,
  });
  if (!result?.columns || result.columns.length !== 3) return fb;
  return {
    intro: (result.intro || "").trim() || fb.intro,
    columns: result.columns.map((c) => ({
      label: c.label,
      bullets: (c.bullets ?? []).map((b) => String(b)).slice(0, 5),
    })),
  };
}

function fallbackPlan(p: PlanInput): {
  intro: string;
  columns: { label: string; bullets: string[] }[];
} {
  const heavyResellers = (p.uniqueSellerCount ?? 0) >= 6;
  return {
    intro: `Here is exactly how we take ${p.brandName}'s channel back over the next ninety days. No black box.`,
    columns: [
      {
        label: "Days 1-30",
        bullets: [
          "Full audit: SKU map, every reseller, MAP gaps, Brand Registry status",
          heavyResellers
            ? `Issue cease-and-desist to ${p.topReseller ?? "the dominant reseller"} and 2–3 next worst`
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
