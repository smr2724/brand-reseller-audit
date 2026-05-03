import OpenAI from "openai";
import type {
  BrandEnrichmentBundle,
  KeepaSnapshot,
  DataForSeoSnapshotRow,
} from "@/lib/enrichment";

export interface BrandForReport {
  id: string;
  name: string;
  category: string | null;
  brand_score: number | null;
  est_monthly_revenue: number | null;
  trailing_12_months: number | null;
  avg_sellers: number | null;
  avg_fba_sellers: number | null;
  dominant_seller_sales_pct: number | null;
  dominant_seller_country: string | null;
  dominant_seller_name: string | null;
  has_storefront: boolean | null;
  total_products: number | null;
  monthly_growth_pct: number | null;
  trailing_12_growth_pct: number | null;
  current_profit: number | null;
  resellers_margin: number | null;
  recouped_shipping: number | null;
  labor_cost: number | null;
  additional_profit: number | null;
  rcg_fees: number | null;
  new_profit: number | null;
  seven_x_multiple_value: number | null;
  /** Phase 28 — user-confirmed TTM revenue overrides the estimator. */
  confirmed_ttm_revenue_dollars?: number | null;
  confirmed_ttm_source?: string | null;
  confirmed_ttm_set_at?: string | null;
}

export interface NarrativeOutput {
  reseller_reality_md: string;
  opportunity_narrative_md: string;
  footprint_callouts_md: string[];
  market_demand_md: string;
  the_gap_md: string;
  value_add_md: string;
}

const SYSTEM_PROMPT = `You are writing a Channel Ownership Audit for Steve Rolle of Rolle Consulting Group (RCG). Steve is an operator who has walked the path himself — he ran his own brand on Amazon, doubled its enterprise value by reclaiming the channel from resellers, and now does the same for other manufacturers.

VOICE
- Operator-to-operator. Second-person ("you", "your brand"). Direct. Short sentences.
- First-person plural for RCG ("we help", "our process").
- No buzzwords, no flattery, no "hope this finds you well", no exclamation points.
- Match the cadence of Steve's webinar: plain-spoken, confident, occasionally a sharp aside.

CANONICAL FRAMEWORKS — use the language verbatim or near-verbatim:
- Three Challenges: (1) Customer Experience (inconsistent pricing, packaging, service), (2) Profit Leakage (resellers pocket margin that should be yours), (3) Missed Growth (resellers don't invest in your brand).
- Five Steps: (1) Audit, (2) Set Up, (3) Protect (Brand Registry, monitoring, enforcement), (4) Transition / Remove Resellers, (5) Build Team.

DATA SOURCES — every claim must be tied to one:
- Keepa (channel control): seller count, buy-box wins, brand-controlled pct, top seller, price erosion.
- DataForSEO (market demand): branded search volume, trend, top keywords, competitor SERP share.
- SmartScout (footprint): brand_score, est_monthly_revenue, dominant seller, storefront.
Tie every claim to a specific Keepa or DataForSEO metric. When asserting RCG can add value, justify with one Keepa signal AND one DataForSEO signal where possible.

HARD RULES
- NEVER fabricate dollar outcomes for the prospect brand. Hedge every dollar with "illustrative", "typical", "estimated", or "in our experience".
- NEVER fabricate quotes or attribute statements to specific people.
- NEVER use the words "scrape" or "crawl".
- Only cite specific numbers that appear in the input data. If a field is null, do not invent it. Say "we did not capture this signal" rather than guess.
- Do not promise outcomes — describe a path.

OUTPUT
Return JSON with these exact keys:
- "reseller_reality_md": 250-400 words, plain markdown (paragraphs, no headings). The reseller reality for THIS brand, weaving in Keepa signals (top seller name + share, unique seller count, brand-controlled pct, avg offers) and SmartScout signals (dominant seller country, storefront). If country is non-US, call it out plainly. If keepa.top_seller_share_pct > 0.5, name that one seller is running this brand's Amazon channel. Tie back to the Three Challenges.
- "opportunity_narrative_md": 150-250 words. The profit story. If current_profit / additional_profit / new_profit are present in the input, weave them in (always hedged as "illustrative based on the model we've built for you"). If null, lean on the canonical $44 → $80 / $11.48 → $24 example, label it illustrative, and note we'll customize the model on their unit economics.
- "footprint_callouts_md": array of 3-5 short bullet strings (<= 18 words each). Mix Keepa, DataForSEO, and SmartScout signals. Only cite numbers actually present.
- "market_demand_md": 100-180 words. Plain markdown. The DataForSEO picture: branded search volume, trend, top keywords, competitor SERP footprint. If branded_search_volume is present, state it. If competitor_brands has entries, name the leading non-brand competitor and its SERP share. If the dataset is empty, say so plainly and note the audit is currently channel-only.
- "the_gap_md": 100-180 words. The mismatch between demand (DataForSEO) and channel control (Keepa). Side-by-side: "people are searching for X / but the brand wins fewer than Y% of its own buy boxes." This section is REQUIRED. If either side is empty, write a one-paragraph degraded state and explain what we'd capture in the engagement.
- "value_add_md": 80-150 words. How RCG specifically adds value for THIS brand based on the combined signals. Each value-add claim should reference one Keepa metric AND one DataForSEO metric where possible. Numeric assumptions must be labeled "Assumption:".`;

export async function generateNarrative(
  brand: BrandForReport,
  bundle?: BrandEnrichmentBundle | null,
): Promise<NarrativeOutput> {
  const model = process.env.OPENAI_MODEL_REPORTS || "gpt-4o-mini";
  if (!process.env.OPENAI_API_KEY) {
    return placeholderNarrative(brand, bundle ?? null);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const userPayload = {
    brand: {
      name: brand.name,
      category: brand.category,
      smartscout: {
        brand_score: brand.brand_score,
        est_monthly_revenue: brand.est_monthly_revenue,
        trailing_12_months: brand.trailing_12_months,
        avg_sellers: brand.avg_sellers,
        avg_fba_sellers: brand.avg_fba_sellers,
        dominant_seller_sales_pct: brand.dominant_seller_sales_pct,
        dominant_seller_country: brand.dominant_seller_country,
        dominant_seller_name: brand.dominant_seller_name,
        has_storefront: brand.has_storefront,
        total_products: brand.total_products,
        monthly_growth_pct: brand.monthly_growth_pct,
        trailing_12_growth_pct: brand.trailing_12_growth_pct,
      },
      financial_overlay: {
        current_profit: brand.current_profit,
        resellers_margin: brand.resellers_margin,
        additional_profit: brand.additional_profit,
        rcg_fees: brand.rcg_fees,
        new_profit: brand.new_profit,
        seven_x_multiple_value: brand.seven_x_multiple_value,
      },
    },
    keepa: bundle?.keepa
      ? {
          asin_count: bundle.keepa.asin_count,
          unique_seller_count: bundle.keepa.unique_seller_count,
          brand_controlled_pct: bundle.keepa.brand_controlled_pct,
          top_seller: bundle.keepa.top_seller,
          top_seller_share_pct: bundle.keepa.top_seller_share_pct,
          top_seller_country: bundle.keepa.top_seller_country,
          avg_offers: bundle.keepa.avg_offers,
          last_enriched_at: bundle.keepa.last_enriched_at,
          top_sellers: bundle.keepa.sellers.slice(0, 5).map((s) => ({
            name: s.seller_name,
            share_pct: s.share_pct,
            asins_won: s.asins_won,
          })),
        }
      : null,
    dataforseo: bundle?.dataforseo
      ? {
          branded_search_volume: bundle.dataforseo.branded_search_volume,
          branded_trend_pct: bundle.dataforseo.branded_trend_pct,
          top_keywords: bundle.dataforseo.top_keywords.slice(0, 8),
          competitor_brands: bundle.dataforseo.competitor_brands.slice(0, 6),
          organic_traffic_value: bundle.dataforseo.organic_traffic_value,
          captured_at: bundle.dataforseo.captured_at,
        }
      : null,
    valueAddSignals: bundle?.valueAddSignals ?? [],
    validationScore: bundle?.validationScore ?? null,
  };

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await client.chat.completions.create({
        model,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Write the Channel Ownership Audit narrative for this brand. Tie every claim to a specific Keepa or DataForSEO metric — when asserting RCG can add value, cite one of each where possible. Input:\n\n${JSON.stringify(
              userPayload,
              null,
              2,
            )}`,
          },
        ],
      });
      const txt = resp.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(txt);
      const fb = placeholderNarrative(brand, bundle ?? null);
      return {
        reseller_reality_md: nonEmpty(parsed.reseller_reality_md, fb.reseller_reality_md),
        opportunity_narrative_md: nonEmpty(parsed.opportunity_narrative_md, fb.opportunity_narrative_md),
        footprint_callouts_md: Array.isArray(parsed.footprint_callouts_md) && parsed.footprint_callouts_md.length
          ? parsed.footprint_callouts_md.map((s: unknown) => String(s)).slice(0, 5)
          : fb.footprint_callouts_md,
        market_demand_md: nonEmpty(parsed.market_demand_md, fb.market_demand_md),
        the_gap_md: nonEmpty(parsed.the_gap_md, fb.the_gap_md),
        value_add_md: nonEmpty(parsed.value_add_md, fb.value_add_md),
      };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }

  console.warn("[report/narrative] OpenAI failed after retries, using placeholder:", lastErr);
  return placeholderNarrative(brand, bundle ?? null);
}

function nonEmpty(v: unknown, fallback: string): string {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function placeholderNarrative(
  brand: BrandForReport,
  bundle: BrandEnrichmentBundle | null,
): NarrativeOutput {
  const dom = brand.dominant_seller_name?.trim();
  const country = brand.dominant_seller_country?.trim();
  const pct = brand.dominant_seller_sales_pct;
  const avgSellers = brand.avg_sellers;

  const keepa: KeepaSnapshot | null = bundle?.keepa ?? null;
  const dfs: DataForSeoSnapshotRow | null = bundle?.dataforseo ?? null;
  const topSeller = keepa?.top_seller ?? dom ?? null;
  const topShare = keepa?.top_seller_share_pct ?? (pct != null ? Number(pct) / 100 : null);
  const topCountry = keepa?.top_seller_country ?? country ?? null;
  const brandedVolume = dfs?.branded_search_volume ?? null;
  const trend = dfs?.branded_trend_pct ?? null;
  const competitor = dfs?.competitor_brands?.[0] ?? null;

  const realityParts: string[] = [];
  realityParts.push(
    `Here's the picture on Amazon for ${brand.name} today. Your brand is being represented on the largest e-commerce platform in the world — but the people doing the representing aren't you.`,
  );
  if (topSeller && topShare != null && topShare >= 0.5) {
    realityParts.push(
      `One seller, ${topSeller}${topCountry ? ` (${topCountry})` : ""}, controls roughly ${Math.round(topShare * 100)}% of buy-box wins on your listings (Keepa). That isn't a marketplace; that's a single middleman running your channel.`,
    );
  } else if (topSeller) {
    realityParts.push(
      `${topSeller}${topCountry ? ` (${topCountry})` : ""} is the dominant seller on your listings (Keepa). They didn't build the brand. They're capturing the spread.`,
    );
  }
  if ((keepa?.unique_seller_count ?? avgSellers ?? 0) >= 5) {
    const n = keepa?.unique_seller_count ?? Math.round(Number(avgSellers ?? 0));
    realityParts.push(
      `Your listings show around ${n} distinct sellers (Keepa). Customers see a confused buy box — different prices, different fulfillment, different presentations of the same product.`,
    );
  }
  realityParts.push(
    "That confusion shows up in the three places it always shows up: customer experience, profit leakage, and missed growth.",
  );
  realityParts.push(
    "The good news: this is reversible. Resellers proved the demand. They tested the SKUs, the price points, the configurations. You don't need to grow new demand — you need to capture the demand that's already there.",
  );

  const oppParts: string[] = [];
  if (brand.current_profit != null && brand.additional_profit != null) {
    oppParts.push(
      `Based on the model we've built for ${brand.name}, your current per-unit profit through the wholesale-to-reseller path is roughly ${money(
        brand.current_profit,
      )}. The illustrative direct-to-Amazon path adds approximately ${money(brand.additional_profit)} in additional profit per unit before our fee.`,
    );
  } else {
    oppParts.push(
      "Illustrative example from the operators we work with: a product wholesaled at roughly $44/unit returns about $11.48 in net profit. The same unit sold directly on Amazon, fully loaded with FBA fees, returns around $24. The spread — roughly two-times the per-unit profit — is the reseller's margin sitting in someone else's account.",
    );
    oppParts.push(
      "These numbers are illustrative. We will rebuild the model on your actual unit economics during the engagement before any decision is made.",
    );
  }
  oppParts.push("Our fee is 50% of the additional first-year profit. No upfront cost. If we don't generate additional profit, we don't get paid.");

  const callouts: string[] = [];
  if (brand.est_monthly_revenue != null) callouts.push(`Est monthly Amazon revenue: ${money(brand.est_monthly_revenue)} (SmartScout).`);
  if (keepa?.unique_seller_count != null) callouts.push(`${keepa.unique_seller_count} distinct sellers competing on listings (Keepa).`);
  if (topSeller && topShare != null) callouts.push(`Top seller ${topSeller} controls ~${Math.round(topShare * 100)}% of buy boxes (Keepa).`);
  if (brandedVolume != null) callouts.push(`Branded Amazon search volume ~${formatVolume(brandedVolume)}/mo (DataForSEO).`);
  if (competitor && competitor.share_of_serp != null) {
    callouts.push(`Top competitor ${competitor.brand} holds ~${Math.round(competitor.share_of_serp * 100)}% of branded SERP (DataForSEO).`);
  }
  if (topCountry && topCountry.toUpperCase() !== "US") callouts.push(`Dominant seller based outside the US (${topCountry}).`);

  // Market Demand paragraph
  let market_demand_md: string;
  if (brandedVolume != null && brandedVolume > 0) {
    const trendPart = trend != null ? ` Trend: ${trend > 0 ? "+" : ""}${trend.toFixed(1)}%.` : "";
    const compPart = competitor
      ? ` On branded SERPs, the leading non-brand competitor is ${competitor.brand} at ~${Math.round((competitor.share_of_serp ?? 0) * 100)}% share.`
      : "";
    const traffic = dfs?.organic_traffic_value
      ? ` Estimated branded organic traffic value: ${money(dfs.organic_traffic_value)}/mo (Assumption: 35% top-of-page CTR × $0.75 effective CPC).`
      : "";
    market_demand_md = `DataForSEO captures ~${formatVolume(brandedVolume)} branded Amazon searches per month for ${brand.name}.${trendPart}${compPart}${traffic} The demand is already there — the question is who is converting it.`;
  } else {
    market_demand_md = `We did not capture meaningful branded Amazon search volume for ${brand.name} in this snapshot. That's not a verdict — it can mean the brand has indexed under a category-led keyword set, or that the audit pulled before DataForSEO refresh. We will widen the keyword seed in the engagement.`;
  }

  // The Gap
  let the_gap_md: string;
  if (brandedVolume != null && brandedVolume > 0 && keepa?.brand_controlled_pct != null) {
    the_gap_md = `Customers are searching for ${brand.name} ~${formatVolume(brandedVolume)} times a month (DataForSEO), but the brand wins only ~${Math.round((keepa.brand_controlled_pct ?? 0) * 100)}% of its own buy boxes (Keepa). Every additional searcher today reaches a reseller. That's the gap — paid demand the brand created, captured by someone else's storefront.`;
  } else if (keepa?.brand_controlled_pct != null) {
    the_gap_md = `Channel control is the headline finding here: the brand wins only ~${Math.round((keepa.brand_controlled_pct ?? 0) * 100)}% of its own buy boxes (Keepa). Demand-side data is thin in this snapshot, so the gap shows up downstream of the click — but the channel-control hole is real on its own.`;
  } else {
    the_gap_md = `Both demand and channel-control snapshots are partial in this audit. We will refresh both in the engagement and rebuild the gap analysis on a complete dataset.`;
  }

  // Value add
  const valueLines: string[] = bundle?.valueAddSignals?.length
    ? bundle.valueAddSignals.slice(0, 5).map((s) => `- ${s}`)
    : [
        "- Reclaim the buy box on the catalog the brand already owns.",
        "- Convert observed branded demand into brand-controlled revenue rather than reseller margin.",
      ];
  const value_add_md = `Where RCG adds value for ${brand.name}, tied to the data we captured:\n\n${valueLines.join("\n")}\n\nAssumption: per-unit upside, listing recovery time, and resellers eligible for an orderly transition will be re-derived on your actual SKUs and unit economics during onboarding.`;

  return {
    reseller_reality_md: realityParts.join("\n\n"),
    opportunity_narrative_md: oppParts.join("\n\n"),
    footprint_callouts_md: callouts.slice(0, 5),
    market_demand_md,
    the_gap_md,
    value_add_md,
  };
}

function money(n: number | null | undefined): string {
  if (n == null || isNaN(Number(n))) return "—";
  return `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function formatVolume(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
