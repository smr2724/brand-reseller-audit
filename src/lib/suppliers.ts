/**
 * Supplier Sourcing Engine
 * ------------------------------------------------------------------
 * Goal: For a given Amazon opportunity, discover the path-of-least-resistance
 * supplier — a manufacturer who already makes a high-quality version of the
 * product, sells B2B/wholesale, and is NOT competing on Amazon themselves.
 *
 * Strategy:
 *   1. Generate a small set of supplier-discovery search queries (manufacturer-
 *      seeking phrases + bulk/wholesale phrases + "made in USA" variants).
 *   2. Run Google SERP via DataForSEO; collect organic results across queries.
 *   3. Aggregate by domain. Filter out marketplaces, retailers, content sites,
 *      and Amazon itself (those aren't manufacturers).
 *   4. For each candidate domain, run a quick Amazon-presence cross-check
 *      (does the brand show up on Amazon SERP for the seed?).
 *   5. Use OpenAI to extract structured fields per candidate (HQ city/state,
 *      channel type, product lines, contact intent) from page metadata.
 *   6. Score on 5 factors:
 *        Not-on-Amazon (40), Turnkey/already-formulated (25),
 *        Geo proximity to Las Vegas (15), Quality signals (10), Reachability (10).
 *
 * Output: opportunity_suppliers rows ranked by supplier_score.
 */

import OpenAI from "openai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { googleSerpLive, amazonSerpLive } from "./dataforseo";

// Lightweight homepage fetch to glean HQ + contact details when SERP didn't give them
async function fetchHomepageSnippet(domain: string): Promise<string> {
  const urls = [`https://${domain}`, `https://${domain}/contact`, `https://${domain}/about`];
  for (const u of urls) {
    try {
      const res = await fetch(u, {
        headers: { "User-Agent": "Mozilla/5.0 LegionScout/1.0" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      // Strip tags + scripts/styles, collapse whitespace
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      // Return first 3000 chars (enough for HQ/about info)
      return text.slice(0, 3000);
    } catch {
      continue;
    }
  }
  return "";
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SupplierCandidate {
  domain: string;
  website: string;
  company_name: string;
  description?: string;
  serp_titles: string[];
  serp_snippets: string[];
  hit_queries: string[];
}

export interface EnrichedSupplier extends SupplierCandidate {
  hq_city?: string;
  hq_state?: string;
  hq_country?: string;
  is_manufacturer: boolean;
  channel_type: "manufacturer_b2b" | "manufacturer_dtc" | "distributor" | "retailer" | "marketplace" | "content_site" | "unknown";
  sells_on_amazon: boolean;
  amazon_evidence?: string;
  product_lines: string[];
  industries: string[];
  contact_email?: string;
  contact_phone?: string;
  contact_form_url?: string;
  founded_year?: number;
  employee_estimate?: string;
}

export interface ScoredSupplier extends EnrichedSupplier {
  geo_tier: string;
  geo_score: number;            // 0-100
  not_on_amazon_score: number;  // 0-100
  turnkey_score: number;        // 0-100
  quality_score: number;        // 0-100
  reachability_score: number;   // 0-100
  supplier_score: number;       // 0-100 weighted composite
  fit_summary: string;
  why_excited: string;
  why_skeptical: string;
  outreach_angle: string;
  recommended_path: "partner" | "private_label" | "wholesale_resell" | "skip";
}

// -----------------------------------------------------------------------------
// Domains to exclude up front — they'll never be the actual manufacturer
// -----------------------------------------------------------------------------

const EXCLUDE_DOMAINS = new Set([
  "amazon.com", "amazon.ca", "amazon.co.uk", "ebay.com", "walmart.com",
  "homedepot.com", "lowes.com", "target.com", "wayfair.com", "costco.com",
  "samsclub.com", "menards.com", "ace-hardware.com", "acehardware.com",
  "harborfreight.com", "northerntool.com", "grainger.com", "uline.com",
  "alibaba.com", "aliexpress.com", "made-in-china.com", "globalsources.com",
  "thomasnet.com", // directory not a manufacturer (we'll mine separately if needed)
  "indiamart.com", "tradeindia.com", "dhgate.com", "tradekey.com",
  "wikipedia.org", "wikimedia.org", "youtube.com", "facebook.com",
  "instagram.com", "linkedin.com", "tiktok.com", "twitter.com", "x.com",
  "reddit.com", "quora.com", "pinterest.com", "yelp.com", "tripadvisor.com",
  "bbb.org", "yellowpages.com", "manta.com", "bizjournals.com",
  "forbes.com", "bloomberg.com", "businessinsider.com", "nytimes.com",
  "wsj.com", "techcrunch.com", "medium.com", "substack.com",
  "etsy.com", "chewy.com", "petco.com", "petsmart.com",
  "chemicalindustry.com", "chemistryworld.com",
  "google.com", "bing.com", "duckduckgo.com",
  "consumerreports.org", "thespruce.com", "thespruceeats.com",
  "wirecutter.com", "buzzfeed.com",
  "buyamericanmade.com", "americanmadematters.com",
]);

const RETAIL_HINTS = ["shop", "store", "buy", "deals", "marketplace", "review"];

// -----------------------------------------------------------------------------
// Geographic scoring (Las Vegas, NV-centric)
// -----------------------------------------------------------------------------

const TIER_BY_STATE: Record<string, { tier: string; score: number }> = {};
// Tier 1: Nevada + adjacent (UT, AZ, CA, ID, OR)
for (const s of ["NV", "UT", "AZ", "CA", "ID", "OR"]) TIER_BY_STATE[s] = { tier: "T1_NV_adjacent", score: 100 };
// Tier 2: Western US (broader)
for (const s of ["WA", "MT", "WY", "CO", "NM", "TX"]) TIER_BY_STATE[s] = { tier: "T2_west_us", score: 80 };
// Tier 3: Rest of US
for (const s of ["MN", "IA", "MO", "AR", "LA", "MS", "AL", "GA", "FL", "SC", "NC", "TN", "KY", "IN", "IL", "WI", "MI", "OH", "PA", "NY", "NJ", "CT", "MA", "VT", "NH", "ME", "RI", "DE", "MD", "VA", "WV", "DC", "OK", "KS", "NE", "SD", "ND", "AK", "HI"])
  TIER_BY_STATE[s] = { tier: "T3_rest_us", score: 60 };

function scoreGeo(country?: string, state?: string): { tier: string; score: number } {
  const c = (country ?? "").toUpperCase();
  const s = (state ?? "").toUpperCase();
  if (c === "MX") return { tier: "T4_mexico", score: 40 };
  if (c && c !== "US" && c !== "USA" && c !== "UNITED STATES") return { tier: "T5_intl", score: 20 };
  if (s && TIER_BY_STATE[s]) return TIER_BY_STATE[s];
  if (c === "US" || c === "USA" || c === "UNITED STATES") return { tier: "T3_rest_us", score: 60 };
  return { tier: "unknown", score: 30 };
}

// -----------------------------------------------------------------------------
// Discovery — generate query list per opportunity
// -----------------------------------------------------------------------------

export function buildSupplierQueries(seed: string): string[] {
  return [
    `${seed} manufacturer`,
    `${seed} manufacturers usa`,
    `${seed} bulk wholesale supplier`,
    `${seed} private label manufacturer`,
    `${seed} contract manufacturer`,
    `${seed} formulator chemical`,
    `${seed} commercial industrial supplier`,
    `${seed} drum 55 gallon bulk`,
  ];
}

// -----------------------------------------------------------------------------
// Discovery — run SERPs and aggregate by domain
// -----------------------------------------------------------------------------

export async function discoverCandidates(seed: string, opts: { perQuery?: number } = {}): Promise<SupplierCandidate[]> {
  const queries = buildSupplierQueries(seed);
  const perQuery = opts.perQuery ?? 30;

  const byDomain: Map<string, SupplierCandidate> = new Map();

  for (const q of queries) {
    try {
      const items = await googleSerpLive(q, { depth: perQuery });
      for (const it of items) {
        if (!it.domain || !it.url) continue;
        const dom = it.domain.replace(/^www\./, "").toLowerCase();
        if (EXCLUDE_DOMAINS.has(dom)) continue;
        // Skip subpaths of marketplaces (covered above) and obvious blog domains
        if (RETAIL_HINTS.some(h => dom.includes(h))) {
          // not a hard skip — could be e.g. "shopnewchem.com" — let LLM decide
        }
        let entry = byDomain.get(dom);
        if (!entry) {
          entry = {
            domain: dom,
            website: `https://${dom}`,
            company_name: domainToCompanyGuess(dom),
            description: it.description,
            serp_titles: [],
            serp_snippets: [],
            hit_queries: [],
          };
          byDomain.set(dom, entry);
        }
        if (it.title) entry.serp_titles.push(it.title);
        if (it.description) entry.serp_snippets.push(it.description);
        entry.hit_queries.push(q);
      }
    } catch (e: any) {
      console.error(`[discoverCandidates] query "${q}" failed: ${e?.message ?? e}`);
    }
  }

  // Rank by # of distinct queries the domain appeared in (signals manufacturer-ness)
  const list = Array.from(byDomain.values())
    .map(c => ({ ...c, _hits: new Set(c.hit_queries).size }))
    .sort((a, b) => b._hits - a._hits);

  // Take top 12 raw candidates per opportunity (we'll narrow further after enrichment)
  return list.slice(0, 12).map(({ _hits, ...rest }) => rest);
}

function domainToCompanyGuess(domain: string): string {
  const root = domain.replace(/\.(com|net|org|co|io|us|biz|info)$/i, "");
  return root
    .split(/[-.]/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// -----------------------------------------------------------------------------
// Amazon-presence cross-check
// -----------------------------------------------------------------------------

const AMAZON_BRAND_CACHE: Map<string, Set<string>> = new Map();

export async function getAmazonBrandsForSeed(seed: string): Promise<Set<string>> {
  const cached = AMAZON_BRAND_CACHE.get(seed);
  if (cached) return cached;
  try {
    const products = await amazonSerpLive(seed, { depth: 40 });
    const brands = new Set<string>();
    for (const p of products) {
      if (p.brand) brands.add(String(p.brand).toLowerCase().trim());
      if (p.title) {
        // Crude: also extract first word of title as a fallback brand candidate
        const first = String(p.title).split(/\s+/)[0]?.toLowerCase().trim();
        if (first && first.length > 2) brands.add(first);
      }
    }
    AMAZON_BRAND_CACHE.set(seed, brands);
    return brands;
  } catch {
    const empty = new Set<string>();
    AMAZON_BRAND_CACHE.set(seed, empty);
    return empty;
  }
}

function checkAmazonPresence(candidate: SupplierCandidate, amazonBrands: Set<string>): { sells: boolean; evidence: string } {
  const guess = candidate.company_name.toLowerCase();
  const root = candidate.domain.split(".")[0].toLowerCase();
  for (const brand of Array.from(amazonBrands)) {
    if (!brand) continue;
    if (brand === guess || brand === root || guess.includes(brand) || brand.includes(root)) {
      return { sells: true, evidence: `Amazon brand "${brand}" matches ${candidate.domain}` };
    }
  }
  return { sells: false, evidence: "No Amazon-SERP brand match" };
}

// -----------------------------------------------------------------------------
// LLM enrichment — extract structured fields from SERP titles/snippets
// -----------------------------------------------------------------------------

const ENRICH_PROMPT = `You are an industrial sourcing analyst. Given SERP data about a website, classify it as a potential B2B chemical/industrial product supplier.

Return STRICT JSON with these keys (no extra keys):
{
  "company_name": string (cleaned company name),
  "is_manufacturer": boolean (true if they actually make/formulate/blend products; false if reseller/distributor/retailer/blog),
  "channel_type": one of ["manufacturer_b2b","manufacturer_dtc","distributor","retailer","marketplace","content_site","unknown"],
  "hq_city": string or null,
  "hq_state": string or null (US 2-letter abbreviation if US, else null),
  "hq_country": string or null (ISO-2 if known: US, MX, CA, etc.),
  "product_lines": array of short product line names (max 5),
  "industries": array of short industry names (max 4),
  "founded_year": integer or null,
  "employee_estimate": one of ["<10","10-50","50-200","200-1000","1000+"] or null,
  "contact_email": string or null,
  "contact_phone": string or null,
  "description": short 1-sentence summary
}

Rules:
- If domain looks like a marketplace, retailer chain, or news/blog/content site, set is_manufacturer=false and channel_type accordingly.
- "manufacturer_b2b" = makes products, primarily sells B2B/wholesale (we want these).
- "manufacturer_dtc" = makes products but primarily sells direct to consumer (less ideal — likely already on Amazon).
- "distributor" = resells other brands' products.
- Prefer null over guessing addresses or contacts not visible in input.
- Only US 2-letter state abbreviations.`;

export async function enrichCandidates(candidates: SupplierCandidate[]): Promise<EnrichedSupplier[]> {
  if (!process.env.OPENAI_API_KEY) {
    return candidates.map(c => ({ ...c, is_manufacturer: true, channel_type: "unknown" as const, sells_on_amazon: false, product_lines: [], industries: [] }));
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const out: EnrichedSupplier[] = [];

  for (const c of candidates) {
    // Pull a small homepage snippet to enrich geo/contact info
    const homepage = await fetchHomepageSnippet(c.domain);
    const input = {
      domain: c.domain,
      candidate_company_name: c.company_name,
      serp_titles: c.serp_titles.slice(0, 6),
      serp_snippets: c.serp_snippets.slice(0, 6),
      queries_matched: Array.from(new Set(c.hit_queries)),
      homepage_text: homepage,
    };
    try {
      const resp = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: ENRICH_PROMPT },
          { role: "user", content: JSON.stringify(input, null, 2) },
        ],
      });
      const parsed = JSON.parse(resp.choices?.[0]?.message?.content ?? "{}");
      out.push({
        ...c,
        company_name: parsed.company_name || c.company_name,
        is_manufacturer: !!parsed.is_manufacturer,
        channel_type: parsed.channel_type || "unknown",
        hq_city: parsed.hq_city || undefined,
        hq_state: parsed.hq_state || undefined,
        hq_country: parsed.hq_country || undefined,
        product_lines: Array.isArray(parsed.product_lines) ? parsed.product_lines.slice(0, 5) : [],
        industries: Array.isArray(parsed.industries) ? parsed.industries.slice(0, 4) : [],
        founded_year: typeof parsed.founded_year === "number" ? parsed.founded_year : undefined,
        employee_estimate: parsed.employee_estimate || undefined,
        contact_email: parsed.contact_email || undefined,
        contact_phone: parsed.contact_phone || undefined,
        description: parsed.description || c.description,
        sells_on_amazon: false, // filled in later
      });
    } catch (e) {
      out.push({ ...c, is_manufacturer: true, channel_type: "unknown", sells_on_amazon: false, product_lines: [], industries: [] });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Scoring
// -----------------------------------------------------------------------------

const WEIGHTS = {
  not_on_amazon: 0.40,
  turnkey:       0.25,
  geo:           0.15,
  quality:       0.10,
  reachability:  0.10,
};

export function scoreSupplier(s: EnrichedSupplier): ScoredSupplier {
  // Not-on-Amazon: 100 if not selling, 0 if selling
  const notOnAmazon = s.sells_on_amazon ? 0 : 100;

  // Turnkey: how ready they are to ship a finished, branded product to us
  let turnkey = 50;
  if (s.is_manufacturer) turnkey += 25;
  if (s.channel_type === "manufacturer_b2b") turnkey += 25;
  if (s.channel_type === "manufacturer_dtc") turnkey += 10;
  if (s.channel_type === "distributor") turnkey -= 25;
  if (s.channel_type === "retailer" || s.channel_type === "marketplace" || s.channel_type === "content_site") turnkey = 0;
  if ((s.product_lines?.length ?? 0) > 0) turnkey += 5;
  turnkey = Math.max(0, Math.min(100, turnkey));

  // Geo
  const { tier, score: geoScore } = scoreGeo(s.hq_country, s.hq_state);

  // Quality signals — based on visible details
  let quality = 40;
  if ((s.product_lines?.length ?? 0) >= 2) quality += 15;
  if ((s.industries?.length ?? 0) >= 2) quality += 10;
  if (s.founded_year && s.founded_year <= new Date().getFullYear() - 10) quality += 15;
  if (s.employee_estimate && ["50-200", "200-1000", "1000+"].includes(s.employee_estimate)) quality += 20;
  quality = Math.min(100, quality);

  // Reachability — how easily we can pitch them
  let reachability = 30;
  if (s.contact_email) reachability += 35;
  if (s.contact_phone) reachability += 25;
  if (s.contact_form_url) reachability += 10;
  // Even without listed contact info, a real domain is reachable via the website
  if (s.website) reachability += 20;
  reachability = Math.min(100, reachability);

  // Composite
  const composite = Math.round(
    notOnAmazon * WEIGHTS.not_on_amazon +
    turnkey * WEIGHTS.turnkey +
    geoScore * WEIGHTS.geo +
    quality * WEIGHTS.quality +
    reachability * WEIGHTS.reachability
  );

  // Recommended path
  let recommended_path: ScoredSupplier["recommended_path"] = "partner";
  if (s.sells_on_amazon) recommended_path = "skip";
  else if (s.channel_type === "manufacturer_b2b" && composite >= 70) recommended_path = "partner";
  else if (s.is_manufacturer && composite >= 50) recommended_path = "private_label";
  else if (s.channel_type === "distributor") recommended_path = "wholesale_resell";
  else if (composite < 40) recommended_path = "skip";

  return {
    ...s,
    geo_tier: tier,
    geo_score: geoScore,
    not_on_amazon_score: notOnAmazon,
    turnkey_score: turnkey,
    quality_score: quality,
    reachability_score: reachability,
    supplier_score: composite,
    fit_summary: "",
    why_excited: "",
    why_skeptical: "",
    outreach_angle: "",
    recommended_path,
  };
}

// -----------------------------------------------------------------------------
// LLM fit memo per (opportunity, supplier) pair
// -----------------------------------------------------------------------------

const FIT_PROMPT = `You are advising Steve Rolle on whether a discovered supplier is a good path-of-least-resistance partner for a specific Amazon opportunity. Steve is in Las Vegas, NV. He prefers the "partnership" play (run their e-commerce for equity in a new LLC) over private-label, and avoids pure resale.

Return STRICT JSON with keys:
{
  "fit_summary": "2-3 sentences. Why this supplier is or isn't a fit for this product.",
  "why_excited": "2-3 sentences. The specific reason this is the path of least resistance.",
  "why_skeptical": "2-3 sentences. The honest risk or trap.",
  "outreach_angle": "1-2 sentences. The exact pitch Steve should open with.",
  "recommended_path": one of ["partner","private_label","wholesale_resell","skip"]
}

Be operator-honest. If they sell on Amazon already, recommend "skip". If they look like a content site or retailer, recommend "skip".`;

export async function generateFitMemo(opp: { name: string; main_keyword: string }, s: ScoredSupplier): Promise<Partial<ScoredSupplier>> {
  if (!process.env.OPENAI_API_KEY) return {};
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const input = {
    opportunity: { name: opp.name, seed_keyword: opp.main_keyword },
    supplier: {
      company_name: s.company_name,
      domain: s.domain,
      hq_city: s.hq_city,
      hq_state: s.hq_state,
      hq_country: s.hq_country,
      channel_type: s.channel_type,
      is_manufacturer: s.is_manufacturer,
      sells_on_amazon: s.sells_on_amazon,
      amazon_evidence: s.amazon_evidence,
      product_lines: s.product_lines,
      industries: s.industries,
      founded_year: s.founded_year,
      employee_estimate: s.employee_estimate,
      scores: {
        supplier_score: s.supplier_score,
        not_on_amazon: s.not_on_amazon_score,
        turnkey: s.turnkey_score,
        geo: s.geo_score,
        quality: s.quality_score,
        reachability: s.reachability_score,
      },
    },
  };
  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: FIT_PROMPT },
        { role: "user", content: JSON.stringify(input, null, 2) },
      ],
    });
    const parsed = JSON.parse(resp.choices?.[0]?.message?.content ?? "{}");
    const path = ["partner", "private_label", "wholesale_resell", "skip"].includes(parsed.recommended_path)
      ? parsed.recommended_path
      : s.recommended_path;
    return {
      fit_summary: parsed.fit_summary ?? "",
      why_excited: parsed.why_excited ?? "",
      why_skeptical: parsed.why_skeptical ?? "",
      outreach_angle: parsed.outreach_angle ?? "",
      recommended_path: path,
    };
  } catch {
    return {};
  }
}

// -----------------------------------------------------------------------------
// Top-level pipeline
// -----------------------------------------------------------------------------

export interface RunSupplierScanArgs {
  scanId: string;
  userId: string;
  opportunityId: string;
  seedKeyword: string;
  opportunityName: string;
  supabase: SupabaseClient;
  topN?: number;
}

export async function runSupplierScan(args: RunSupplierScanArgs) {
  const { scanId, userId, opportunityId, seedKeyword, opportunityName, supabase, topN = 8 } = args;

  // 1. Discover via Google SERP
  const candidates = await discoverCandidates(seedKeyword);

  // 2. Cross-check against Amazon brand list for this seed
  const amazonBrands = await getAmazonBrandsForSeed(seedKeyword);

  // 3. Enrich with OpenAI
  const enriched = await enrichCandidates(candidates);

  // 4. Apply Amazon-presence flag
  for (const e of enriched) {
    const presence = checkAmazonPresence(e, amazonBrands);
    e.sells_on_amazon = presence.sells;
    e.amazon_evidence = presence.evidence;
  }

  // 5. Drop obvious non-suppliers (content sites, retailers)
  const usable = enriched.filter(e => !["retailer", "marketplace", "content_site"].includes(e.channel_type));

  // 6. Score
  const scored = usable.map(scoreSupplier);

  // 7. Generate per-pair fit memos for top N
  scored.sort((a, b) => b.supplier_score - a.supplier_score);
  const top = scored.slice(0, topN);
  for (const s of top) {
    const memo = await generateFitMemo({ name: opportunityName, main_keyword: seedKeyword }, s);
    Object.assign(s, memo);
  }

  // 8. Persist suppliers (upsert by user+domain) and opportunity_suppliers
  const supplierIdByDomain: Record<string, string> = {};

  for (const s of top) {
    const supplierRow: any = {
      user_id: userId,
      company_name: s.company_name,
      website: s.website,
      domain: s.domain,
      hq_city: s.hq_city ?? null,
      hq_state: s.hq_state ?? null,
      hq_country: s.hq_country ?? null,
      geo_tier: s.geo_tier,
      geo_score: s.geo_score,
      sells_on_amazon: s.sells_on_amazon,
      amazon_evidence: s.amazon_evidence ?? null,
      not_on_amazon_score: s.not_on_amazon_score,
      is_manufacturer: s.is_manufacturer,
      channel_type: s.channel_type,
      turnkey_score: s.turnkey_score,
      quality_score: s.quality_score,
      reachability_score: s.reachability_score,
      contact_email: s.contact_email ?? null,
      contact_phone: s.contact_phone ?? null,
      contact_form_url: s.contact_form_url ?? null,
      product_lines: s.product_lines,
      industries: s.industries,
      description: s.description ?? null,
      founded_year: s.founded_year ?? null,
      employee_estimate: s.employee_estimate ?? null,
      evidence: { serp_titles: s.serp_titles.slice(0, 6), serp_snippets: s.serp_snippets.slice(0, 6) },
      updated_at: new Date().toISOString(),
    };

    const { data: existing } = await supabase
      .from("suppliers")
      .select("id")
      .eq("user_id", userId)
      .eq("domain", s.domain)
      .maybeSingle();

    let supplierId: string;
    if (existing?.id) {
      await supabase.from("suppliers").update(supplierRow).eq("id", existing.id);
      supplierId = existing.id;
    } else {
      const { data: ins } = await supabase.from("suppliers").insert(supplierRow).select("id").single();
      supplierId = ins!.id;
    }
    supplierIdByDomain[s.domain] = supplierId;
  }

  // Upsert pair rows
  for (let i = 0; i < top.length; i++) {
    const s = top[i];
    const supplierId = supplierIdByDomain[s.domain];
    const pair: any = {
      user_id: userId,
      opportunity_id: opportunityId,
      supplier_id: supplierId,
      supplier_score: s.supplier_score,
      recommended_path: s.recommended_path,
      fit_summary: s.fit_summary,
      why_excited: s.why_excited,
      why_skeptical: s.why_skeptical,
      outreach_angle: s.outreach_angle,
      ranked_position: i + 1,
    };
    const { data: exP } = await supabase
      .from("opportunity_suppliers")
      .select("id")
      .eq("opportunity_id", opportunityId)
      .eq("supplier_id", supplierId)
      .maybeSingle();
    if (exP?.id) {
      await supabase.from("opportunity_suppliers").update(pair).eq("id", exP.id);
    } else {
      await supabase.from("opportunity_suppliers").insert(pair);
    }
  }

  // 8b. Auto-archive logic for suppliers from this scan
  // Keep ONLY the #1 supplier active for this opportunity. Archive the rest —
  // UNLESS a non-#1 supplier is also the top-1 for some OTHER active opportunity
  // (we don't want to clobber a supplier that's a winner elsewhere).
  const touchedSupplierIds = Object.values(supplierIdByDomain);
  const topSupplierId = top.length > 0 ? supplierIdByDomain[top[0].domain] : null;

  if (touchedSupplierIds.length > 0) {
    // Restore the #1 (in case it was previously archived)
    if (topSupplierId) {
      await supabase
        .from("suppliers")
        .update({ archived_at: null })
        .eq("id", topSupplierId)
        .eq("user_id", userId);
    }

    // Find suppliers that are top-1 for any OTHER active opportunity — these are protected
    const { data: protectedRows } = await supabase
      .from("opportunity_suppliers")
      .select("supplier_id, supplier_score, ranked_position, opportunity_id, opportunities!inner(archived_at)")
      .in("supplier_id", touchedSupplierIds)
      .neq("opportunity_id", opportunityId)
      .is("opportunities.archived_at", null);

    // Group by opportunity to find each opp's #1
    const byOpp: Record<string, { supplier_id: string; score: number; rank: number }[]> = {};
    for (const r of (protectedRows ?? []) as any[]) {
      (byOpp[r.opportunity_id] ??= []).push({
        supplier_id: r.supplier_id,
        score: r.supplier_score ?? 0,
        rank: r.ranked_position ?? 999,
      });
    }
    const protectedIds = new Set<string>();
    for (const oppId of Object.keys(byOpp)) {
      const sorted = byOpp[oppId].slice().sort(
        (a, b) => b.score - a.score || a.rank - b.rank
      );
      if (sorted[0]) protectedIds.add(sorted[0].supplier_id);
    }

    // Archive suppliers from this scan that aren't #1 here and aren't protected elsewhere
    const toArchive = touchedSupplierIds.filter(
      sid => sid !== topSupplierId && !protectedIds.has(sid)
    );
    if (toArchive.length > 0) {
      await supabase
        .from("suppliers")
        .update({ archived_at: new Date().toISOString() })
        .in("id", toArchive)
        .eq("user_id", userId);
    }
  }

  // 9. Update scan
  await supabase.from("supplier_scans").update({
    status: "complete",
    completed_at: new Date().toISOString(),
    candidates_found: candidates.length,
    candidates_qualified: top.length,
  }).eq("id", scanId);

  return { candidates: candidates.length, qualified: top.length, top };
}
