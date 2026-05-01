import OpenAI from "openai";

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
}

export interface NarrativeOutput {
  reseller_reality_md: string;
  opportunity_narrative_md: string;
  footprint_callouts_md: string[];
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

HARD RULES
- NEVER fabricate dollar outcomes for the prospect brand. Hedge every dollar with "illustrative", "typical", "estimated", or "in our experience".
- NEVER fabricate quotes or attribute statements to specific people.
- NEVER use the words "scrape" or "crawl".
- Only cite specific numbers that appear in the input data. If a field is null, do not invent it.
- Do not promise outcomes — describe a path.

OUTPUT
Return JSON with these exact keys:
- "reseller_reality_md": 250-400 words, plain markdown (paragraphs, no headings). The reseller reality for THIS brand, weaving in their actual SmartScout signals (dominant seller name, country, share %, sellers-per-listing, storefront status). If dominant_seller_country exists and is not "US", call it out plainly. If dominant_seller_sales_pct > 50, name that one seller is running this brand's Amazon channel. If avg_sellers > 5, mention the listing crowding. Tie it back to the Three Challenges.
- "opportunity_narrative_md": 150-250 words. The profit story. If current_profit / additional_profit / new_profit are present in the input, weave those numbers in (always hedged as "illustrative based on the model we've built for you" or similar). If they are NULL, lean on the canonical $44 → $80 / $11.48 → $24 example and CLEARLY label it as illustrative, then add one line that we'll customize the model to their unit economics during the engagement.
- "footprint_callouts_md": array of 3-5 short bullet strings (<= 18 words each) summarizing the most striking signal in the brand's footprint. Only cite numbers actually present in the input.`;

export async function generateNarrative(
  brand: BrandForReport,
  keepaSummary?: Record<string, unknown> | null
): Promise<NarrativeOutput> {
  const model = process.env.OPENAI_MODEL_REPORTS || "gpt-4o-mini";
  if (!process.env.OPENAI_API_KEY) {
    return placeholderNarrative(brand);
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
      keepa_summary: keepaSummary ?? null,
    },
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
            content: `Write the Reseller Reality, Opportunity, and Footprint Callouts for this brand. Input:\n\n${JSON.stringify(
              userPayload,
              null,
              2
            )}`,
          },
        ],
      });
      const txt = resp.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(txt);
      return {
        reseller_reality_md: String(parsed.reseller_reality_md ?? "").trim() || placeholderNarrative(brand).reseller_reality_md,
        opportunity_narrative_md: String(parsed.opportunity_narrative_md ?? "").trim() || placeholderNarrative(brand).opportunity_narrative_md,
        footprint_callouts_md: Array.isArray(parsed.footprint_callouts_md)
          ? parsed.footprint_callouts_md.map((s: unknown) => String(s)).slice(0, 5)
          : placeholderNarrative(brand).footprint_callouts_md,
      };
    } catch (e) {
      lastErr = e;
      // simple backoff
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }

  // Fall back rather than fail the whole report.
  console.warn("[report/narrative] OpenAI failed after retries, using placeholder:", lastErr);
  return placeholderNarrative(brand);
}

function placeholderNarrative(brand: BrandForReport): NarrativeOutput {
  const dom = brand.dominant_seller_name?.trim();
  const country = brand.dominant_seller_country?.trim();
  const pct = brand.dominant_seller_sales_pct;
  const avgSellers = brand.avg_sellers;

  const realityParts: string[] = [];
  realityParts.push(
    `Here's the picture on Amazon for ${brand.name} today. Your brand is being represented on the largest e-commerce platform in the world — but the people doing the representing aren't you.`
  );
  if (dom && pct != null && Number(pct) >= 50) {
    realityParts.push(
      `One seller, ${dom}${country ? ` (${country})` : ""}, controls roughly ${Math.round(Number(pct))}% of the sales on your listings. That isn't a marketplace; that's a single middleman running your channel.`
    );
  } else if (dom) {
    realityParts.push(
      `${dom}${country ? ` (${country})` : ""} is the dominant seller on your listings. They didn't build the brand. They're capturing the spread.`
    );
  }
  if (avgSellers != null && Number(avgSellers) >= 5) {
    realityParts.push(
      `Your listings average around ${Math.round(Number(avgSellers))} sellers each. Customers see a confused buy box — different prices, different fulfillment, different presentations of the same product.`
    );
  }
  realityParts.push(
    "That confusion shows up in the three places it always shows up: customer experience (inconsistent pricing and packaging), profit leakage (margin that should be yours sitting in someone else's account), and missed growth (nobody on the channel is investing in your brand)."
  );
  realityParts.push(
    "The good news: this is reversible. Resellers proved the demand. They tested the SKUs, the price points, the configurations. You don't need to grow new demand — you need to capture the demand that's already there. That's the opportunity, and that's what we do."
  );

  const oppParts: string[] = [];
  if (brand.current_profit != null && brand.additional_profit != null) {
    oppParts.push(
      `Based on the model we've built for ${brand.name}, your current per-unit profit through the wholesale-to-reseller path is roughly ${money(
        brand.current_profit
      )}. The illustrative direct-to-Amazon path adds approximately ${money(brand.additional_profit)} in additional profit per unit before our fee.`
    );
  } else {
    oppParts.push(
      "Illustrative example from the operators we work with: a product wholesaled at roughly $44/unit returns about $11.48 in net profit. The same unit sold directly on Amazon, fully loaded with FBA fees, returns around $24. The spread — roughly two-times the per-unit profit — is the reseller's margin sitting in someone else's account."
    );
    oppParts.push(
      "These numbers are illustrative. We will rebuild the model on your actual unit economics during the engagement before any decision is made."
    );
  }
  oppParts.push(
    "Our fee is 50% of the additional first-year profit. No upfront cost. If we don't generate additional profit, we don't get paid."
  );

  const callouts: string[] = [];
  if (brand.est_monthly_revenue != null) callouts.push(`Estimated monthly Amazon revenue: ${money(brand.est_monthly_revenue)}.`);
  if (brand.trailing_12_months != null) callouts.push(`Trailing 12-month Amazon revenue: ${money(brand.trailing_12_months)}.`);
  if (dom && pct != null) callouts.push(`Dominant seller ${dom} controls ~${Math.round(Number(pct))}% of listing sales.`);
  if (country && country !== "US") callouts.push(`Top seller is based in ${country}, not the US.`);
  if (brand.has_storefront === false) callouts.push("No brand storefront present on Amazon.");
  if (avgSellers != null) callouts.push(`Listings average ~${Math.round(Number(avgSellers))} sellers per ASIN.`);
  if (brand.total_products != null) callouts.push(`${brand.total_products} branded products visible on Amazon.`);

  return {
    reseller_reality_md: realityParts.join("\n\n"),
    opportunity_narrative_md: oppParts.join("\n\n"),
    footprint_callouts_md: callouts.slice(0, 5),
  };
}

function money(n: number | null | undefined): string {
  if (n == null || isNaN(Number(n))) return "—";
  return `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
