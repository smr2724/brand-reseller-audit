import OpenAI from "openai";

export function isOpenAIConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

export async function testOpenAI() {
  if (!process.env.OPENAI_API_KEY) return { ok: false, error: "OPENAI_API_KEY missing" };
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const r = await client.models.list();
    return { ok: true, models_count: r.data.length };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export interface MemoInput {
  seedKeyword: string;
  topKeywords: { keyword: string; search_volume: number | null }[];
  topProducts: { title?: string; brand?: string; price?: number; rating?: number; review_count?: number; asin?: string }[];
  scores: {
    legion_score: number;
    demand_score: number;
    competition_weakness_score: number;
    product_advantage_score: number;
    visual_demo_score: number;
    economics_score: number;
    partner_score: number;
    recommended_path: string;
  };
  metrics: {
    monthly_search_volume: number;
    total_cluster_search_volume: number;
    top_10_avg_reviews: number;
    top_10_avg_rating: number;
    avg_price: number;
  };
}

export interface MemoOutput {
  summary: string;
  why_excited: string;
  why_skeptical: string;
  product_advantage_hypothesis: string;
  visual_demo_notes: string;
  economics_notes: string;
  partner_notes: string;
  recommended_path: "partner" | "launch" | "acquire" | "avoid";
}

const SYSTEM_PROMPT = `You are a senior Amazon category analyst advising Steve Rolle, an operator with deep experience in specialty chemicals, hospitality manufacturing, wholesale distribution, and Amazon private-label launches. You understand the "Legion Chemicals" case study: Legion took concrete remover from $0 to ~$100k/mo on Amazon in under a year by entering an ignored, boring, industrial category where demand existed, competition was weak, no clear winner owned page one, and product efficacy mattered.

Your job is to evaluate new Amazon category candidates with the SAME mental model. You are SKEPTICAL and OPERATOR-LEVEL, not hypey. Honest when data is weak. You never oversell.

Return JSON with exact keys: summary, why_excited, why_skeptical, product_advantage_hypothesis, visual_demo_notes, economics_notes, partner_notes, recommended_path.

- recommended_path must be one of: partner, launch, acquire, avoid.
- Each text field should be 2-5 sentences, sharp and concrete. No filler.
- Cite specific numbers from the input (search volume, avg reviews, avg rating, avg price, top brands) when making claims.
- "why_skeptical" is NOT optional — always identify at least one real trap or reason this might not work.`;

export async function generateMemo(input: MemoInput): Promise<MemoOutput> {
  if (!process.env.OPENAI_API_KEY) return placeholderMemo(input);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const userMessage = JSON.stringify({
    seed_keyword: input.seedKeyword,
    top_keywords: input.topKeywords.slice(0, 15),
    top_products: input.topProducts.slice(0, 10).map(p => ({
      title: (p.title ?? "").slice(0, 120),
      brand: p.brand,
      price: p.price,
      rating: p.rating,
      review_count: p.review_count,
      asin: p.asin,
    })),
    scores: input.scores,
    metrics: input.metrics,
  }, null, 2);

  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Evaluate this Amazon category opportunity. Input data:\n\n${userMessage}\n\nReturn JSON with keys: summary, why_excited, why_skeptical, product_advantage_hypothesis, visual_demo_notes, economics_notes, partner_notes, recommended_path.` },
      ],
    });
    const text = resp.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(text);
    return normalizeMemo(parsed, input);
  } catch (e) {
    return placeholderMemo(input);
  }
}

function normalizeMemo(raw: any, input: MemoInput): MemoOutput {
  const path = (raw?.recommended_path ?? input.scores.recommended_path ?? "launch").toLowerCase();
  const valid = ["partner", "launch", "acquire", "avoid"].includes(path) ? path : "launch";
  return {
    summary: raw?.summary ?? "",
    why_excited: raw?.why_excited ?? "",
    why_skeptical: raw?.why_skeptical ?? "",
    product_advantage_hypothesis: raw?.product_advantage_hypothesis ?? "",
    visual_demo_notes: raw?.visual_demo_notes ?? "",
    economics_notes: raw?.economics_notes ?? "",
    partner_notes: raw?.partner_notes ?? "",
    recommended_path: valid as MemoOutput["recommended_path"],
  };
}

// =====================================================================
//  CRM: rank Apollo candidates and pick the 3 best contacts to enrich.
// =====================================================================

export interface RankInput {
  companyName: string;
  productContext: string;          // "Concrete remover, $1M+/yr Amazon channel"
  candidates: { id: string; name?: string; title?: string; seniority?: string; departments?: string[] }[];
}

export interface RankedPick {
  apollo_id: string;
  rank: number;          // 1, 2, 3
  reason: string;
}

const RANK_SYSTEM_PROMPT = `You are picking the 3 best people at a manufacturer for Steve Rolle to email about an Amazon partnership. Steve operates the Amazon channel for established manufacturers — he can buy wholesale, run the channel under their brand, or build a private label.

Target order of preference:
1. Owner / Founder / President / CEO at small to mid-size manufacturers (they make the call themselves).
2. VP Sales / Sales Director / Director of Business Development / Director of Channel.
3. VP / Director of E-commerce / Marketing / Digital — only if no clear sales leader exists.

Avoid: HR, IT, finance, individual sales reps without manager titles, support, interns, marketing coordinators.

Return JSON with exact key 'picks' = array of 3 objects: { apollo_id, rank (1-3), reason (one sentence, why they are the right person to email) }. Choose only from the candidates given. If fewer than 3 valid candidates exist, return as many as you can.`;

export async function rankContacts(input: RankInput): Promise<RankedPick[]> {
  if (!process.env.OPENAI_API_KEY) return heuristicRank(input.candidates);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: RANK_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Company: ${input.companyName}\nProduct context: ${input.productContext}\n\nCandidates:\n${JSON.stringify(input.candidates, null, 2)}`,
        },
      ],
    });
    const txt = resp.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(txt);
    const picks = Array.isArray(parsed?.picks) ? parsed.picks : [];
    return picks
      .filter((p: any) => p && typeof p.apollo_id === "string")
      .slice(0, 3)
      .map((p: any, i: number) => ({
        apollo_id: p.apollo_id,
        rank: Number(p.rank ?? i + 1),
        reason: String(p.reason ?? "").slice(0, 280),
      }));
  } catch {
    return heuristicRank(input.candidates);
  }
}

function heuristicRank(candidates: RankInput["candidates"]): RankedPick[] {
  // Fallback: simple keyword scoring when OpenAI is unavailable.
  const score = (t = "") => {
    const s = t.toLowerCase();
    if (/\b(owner|founder|president|ceo)\b/.test(s)) return 100;
    if (/\b(vp|vice president).*\b(sales|business)/.test(s)) return 90;
    if (/\b(director|head).*\b(sales|business)/.test(s)) return 85;
    if (/\bsales manager\b/.test(s)) return 70;
    if (/\b(vp|director|head).*\b(e-?commerce|ecommerce|digital)/.test(s)) return 65;
    if (/\bmarketing director\b/.test(s)) return 50;
    return 20;
  };
  return [...candidates]
    .map(c => ({ c, s: score(c.title) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map(({ c }, i) => ({
      apollo_id: c.id,
      rank: i + 1,
      reason: `${c.title ?? "Contact"} — heuristic pick (configure OpenAI for AI reasoning).`,
    }));
}

// =====================================================================
//  CRM: draft outreach email per contact using product + supplier context.
// =====================================================================

export interface OutreachDraftInput {
  contactName: string;
  contactFirstName?: string;
  contactTitle?: string;
  companyName: string;
  /** Whether THIS supplier already sells on Amazon. False/null/undefined = not on Amazon. */
  supplierSellsOnAmazon?: boolean | null;
  productKeyword: string;          // "aluminum weld cleaner"
  productCategory?: string;
  recommendedPath?: string;        // partner | private_label | wholesale_resell
  legionScore?: number;
  /** CATEGORY-level metrics (NOT the supplier's). The category's top-10 are competitors, not this supplier. */
  categoryTop10AvgReviews?: number;
  categoryMonthlyVolume?: number;
  categoryEstimatedMonthlyUnits?: number;
}

export interface OutreachDraftOutput {
  subject: string;
  body: string;
}

const OUTREACH_SYSTEM_PROMPT = `You write short, plain, operator-to-operator outreach emails for Steve Rolle, founder of Rolle Management Group. Steve is the OPERATOR, not the manufacturer. The recipients make best-in-class products but are missing from Amazon (or losing share to resellers/competitors there). Steve runs the Amazon channel on their behalf and helps companies become category leaders for their products on Amazon.

Proof points (use ONE max per email, never recite all three):
- $60M+ lifetime Amazon sales operated across partner brands.
- Legion Chemicals: $0 → $1M+ ARR in 10 months.
- Hospitality consumables: $0 → ~$10M/yr.
- We specialize in industrial / niche categories most Amazon agencies ignore.

CRITICAL RULES — do not violate:
1. NEVER reference internal scoring or proprietary metrics. The recipient has no idea what "Legion Score", "Top-10 avg reviews", "monthly search volume", or any numeric category benchmark is. Do NOT mention any specific numbers about the category, search volume, or competitor reviews. Speak qualitatively: "there's real demand on Amazon for products like yours", "the category is being captured by lesser products", "customers are searching for this every day".
2. NEVER imply the recipient is already selling on Amazon unless supplier_sells_on_amazon is true. If false/unknown, the framing is: their best-in-class product isn't being seen on Amazon, and competitors with weaker products are filling the gap.
3. NEVER ask for a phone call, meeting, intro call, 15-min, demo, or any time on the calendar. The CTA is ALWAYS to visit the website. The website explains the partnership models; if they're interested, they reach out from there.
4. The CTA URL is the marketing site URL provided in the input as 'marketing_site_url'. Use that exact URL in the email, written as a plain link. Do NOT make up any other URL.
5. The website explains three ways we partner: (a) done-for-you operations under their brand, (b) wholesale or private-label, (c) authorized reseller. You may mention this lightly ("a few partnership models" or "three ways we partner") but do NOT enumerate or explain them in detail — that's what the website does.

Tone: an operator talking to a manufacturer. Direct. Short sentences. No buzzwords. No "hope this finds you well". No flattery. 90–140 words. Lowercase subject line. End with a soft CTA pointing to the website — e.g. "More on how we work and the partnership models we offer at [URL]. If any of it resonates, reply or reach out from the site and we'll go from there."

Return JSON with exact keys: subject, body. Use the first name if provided. Sign as:

Steve Rolle
Founder, Rolle Management Group
steve@rollemanagementgroup.com`;

export async function generateOutreachDraft(input: OutreachDraftInput): Promise<OutreachDraftOutput> {
  if (!process.env.OPENAI_API_KEY) return placeholderOutreach(input);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  // Build a clean, labeled payload. Internal scores/metrics are deliberately NOT included — the recipient has no idea what they mean.
  const onAmazon = input.supplierSellsOnAmazon === true;
  const marketingUrl =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ||
    "https://legion-opportunity-scanner.vercel.app";

  const userPayload = {
    recipient: {
      first_name: input.contactFirstName ?? input.contactName.split(" ")[0],
      title: input.contactTitle ?? null,
      company: input.companyName,
    },
    supplier_status: {
      sells_on_amazon: onAmazon,
    },
    opportunity: {
      // Just the qualitative product context. NO internal metrics.
      keyword: input.productKeyword,
      category: input.productCategory ?? null,
    },
    marketing_site_url: marketingUrl,
    instructions: onAmazon
      ? "Write the email assuming the recipient has some Amazon presence but is leaving meaningful upside on the table or losing brand control to resellers. Frame it qualitatively (no numbers). Reference ONE proof point. Drive them to the marketing_site_url to learn how we work and the partnership models we offer. Do NOT ask for a call. The CTA is to visit the site."
      : "Write the email assuming the recipient does NOT sell on Amazon. Open with the observation that their best-in-class product isn't being seen on Amazon, and that the category is being filled by lesser products / resellers. Name the missed opportunity qualitatively — NO numbers, NO benchmarks. Reference ONE proof point. Drive them to the marketing_site_url to learn how we help companies just like them become category leaders on Amazon. Do NOT ask for a call. The CTA is to visit the site.",
  };

  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: OUTREACH_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Write an outreach email for this scenario:\n\n${JSON.stringify(userPayload, null, 2)}`,
        },
      ],
    });
    const txt = resp.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(txt);
    return {
      subject: String(parsed.subject ?? `${input.productKeyword} on amazon — quick question`).slice(0, 200),
      body: String(parsed.body ?? placeholderOutreach(input).body),
    };
  } catch {
    return placeholderOutreach(input);
  }
}

function placeholderOutreach(input: OutreachDraftInput): OutreachDraftOutput {
  const first = input.contactFirstName ?? input.contactName.split(" ")[0] ?? "there";
  const onAmazon = input.supplierSellsOnAmazon === true;
  const url =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ||
    "https://legion-opportunity-scanner.vercel.app";
  const sig = `Steve Rolle\nFounder, Rolle Management Group\nsteve@rollemanagementgroup.com`;

  if (!onAmazon) {
    return {
      subject: `${input.productKeyword} on amazon — a thought for ${input.companyName.toLowerCase()}`,
      body: `Hi ${first},\n\nI run Rolle Management Group. We help established manufacturers become category leaders on Amazon for the products they already make best.\n\nI noticed ${input.companyName}'s ${input.productKeyword} isn't really being seen on Amazon. Meanwhile the category is being filled by lesser products and resellers — customers searching for it every day are landing on whoever bothers to show up.\n\nWe took Legion Chemicals from $0 to over $1M in ARR in 10 months doing exactly this in a similar niche. We have a few partnership models depending on how hands-on you want to be.\n\nMore on how we work, the case studies, and the partnership models at:\n${url}\n\nIf any of it resonates, reach out from the site and we'll take it from there.\n\n${sig}`,
    };
  }

  return {
    subject: `${input.companyName.toLowerCase()} on amazon — a thought`,
    body: `Hi ${first},\n\nI run Rolle Management Group. We operate Amazon for established manufacturers — $60M+ lifetime across partner brands.\n\nI took a look at ${input.companyName}'s presence on Amazon for ${input.productKeyword} and wanted to reach out. There's real room to grow the channel and clean up any reseller / brand-control issues along the way — the kind of work we specialize in for industrial and niche categories.\n\nMore on how we work, case studies, and the partnership models we offer at:\n${url}\n\nIf any of it resonates, reach out from the site and we'll take it from there.\n\n${sig}`,
  };
}

function placeholderMemo(input: MemoInput): MemoOutput {
  const { scores, metrics, seedKeyword } = input;
  return {
    summary: `${seedKeyword} scored ${scores.legion_score}/100. Monthly search volume ~${metrics.monthly_search_volume}, cluster ~${metrics.total_cluster_search_volume}. Top-10 avg ${metrics.top_10_avg_reviews} reviews at ${metrics.top_10_avg_rating} stars, avg price $${metrics.avg_price}. [Placeholder — configure OpenAI for full analyst memo.]`,
    why_excited: scores.competition_weakness_score >= 12
      ? `Page one looks beatable: top-10 avg review count (${metrics.top_10_avg_reviews}) is below typical winner thresholds and avg rating (${metrics.top_10_avg_rating}) suggests customer complaints. Demand score is ${scores.demand_score}/20.`
      : `Demand score is ${scores.demand_score}/20 and competition weakness is ${scores.competition_weakness_score}/20.`,
    why_skeptical: scores.competition_weakness_score < 10
      ? `Page one is already well-defended. Avg review count of ${metrics.top_10_avg_reviews} is a meaningful moat that will take real budget and time to breach.`
      : `Without product-efficacy data, product-advantage score (${scores.product_advantage_score}/20) is an assumption — validate with review mining before investing.`,
    product_advantage_hypothesis: `Hypothesis: a better-formulated, better-demonstrated, better-packaged ${seedKeyword} could win if current top-10 products have quality complaints. Manual review mining recommended.`,
    visual_demo_notes: scores.visual_demo_score >= 11
      ? `Strong before/after demo potential — customers see a problem solved in seconds. Ideal for short-form video, PDP carousel, and A+ content.`
      : `Visual demonstration is harder here — performance may be invisible or long-horizon. Content strategy will lean on trust signals rather than demos.`,
    economics_notes: `Avg price $${metrics.avg_price}. Economics score ${scores.economics_score}/15 assumes consumable/repeat potential and manageable shipping. Verify hazmat + carrier rules before launch.`,
    partner_notes: scores.partner_score >= 7
      ? `Category has traditional-distribution scent. Real manufacturers likely exist outside Amazon and underinvest in the channel. Good partner candidate.`
      : `Partner path is less obvious — either too commoditized or dominated by a few large brands. Launch or acquire more likely.`,
    recommended_path: (scores.recommended_path as any) ?? "launch",
  };
}
