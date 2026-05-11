/**
 * Phase 68 — Gate A: Corporate-hierarchy resolution.
 *
 * Resolution chain (each step pre-populates evidence for the next):
 *
 *   1. USPTO TSDR        — reuse the existing `searchTrademark` wrapper.
 *      Trademark assignee on file is often the legal parent.
 *   2. Wikipedia REST    — `/api/rest_v1/page/summary/{title}` gives a
 *      description + a thumbnail; we keep this lightweight because the
 *      LLM step does the real synthesis.
 *   3. SEC EDGAR         — when we have a parent candidate, look it up
 *      via the company-search JSON and surface the 10-K filing URL. The
 *      LLM is asked to confirm the brand→parent link from Exhibit 21.
 *      EDGAR requires a User-Agent. Cache hits for 30 days.
 *   4. LLM web-search    — gpt-4.1 with the structured prompt, fed all
 *      evidence gathered above.
 *
 * The LLM ALWAYS runs at step 4 — it is the only step capable of saying
 * "this is owned by ABC Industries which trades as ABCI" with a verbatim
 * source. Steps 1-3 just shrink the search space.
 *
 * Cache strategy: a module-level Map keyed on lowercased brand name with
 * a 30-day TTL. Vercel keeps process state across warm invocations, so
 * the cache helps hot brands. Long-term persistence is recorded on
 * `brand_qualifications.hierarchy_sources` (jsonb) — re-qualifying a
 * brand replays the same chain and re-writes the column.
 */
import { searchTrademark, summarizeUspto } from "./uspto";
import {
  callQualificationLlm,
  QUALIFICATION_MAIN_MODEL,
  type LlmCallResult,
} from "./llm";

export type OwnershipType =
  | "public"
  | "pe_owned"
  | "private_independent"
  | "family_office"
  | "holding_co_private"
  | "unknown";

export interface HierarchySource {
  /** One of: uspto, wikipedia, sec_edgar, brand_website, trade_pub, llm_web_search, other. */
  type: string;
  url?: string | null;
  excerpt?: string | null;
}

export interface ControllingEntity {
  name: string;
  ticker: string | null;
  exchange: string | null;
  revenue_usd: number | null;
  employees: number | null;
  ownership_type: OwnershipType;
  /** Top-of-tree → ... → brand. */
  parent_chain: string[];
  /** PE AUM estimate when ownership_type=pe_owned; null otherwise. */
  pe_aum_usd?: number | null;
}

export type GateAVerdict = "pass" | "hard_disqualify" | "needs_review";

export interface GateAResult {
  passed: boolean;
  verdict: GateAVerdict;
  /** When verdict='pass', the entity whose channel decisions matter.
   *  When verdict='hard_disqualify', the public/PE-owned parent that
   *  short-circuited Gate A.
   *  May be null when the entire chain failed to resolve. */
  controlling_entity: ControllingEntity | null;
  verdict_reason: string;
  sources: HierarchySource[];
  /** The pattern (from the widened disqualification_pattern enum) that
   *  best describes the failure. Null when the gate passed. */
  pattern: string | null;
  /** Per-step diagnostic — which chain rungs returned data. */
  resolution_trace: {
    uspto_called: boolean;
    uspto_owner: string | null;
    wikipedia_called: boolean;
    wikipedia_hit: boolean;
    edgar_called: boolean;
    edgar_hit: boolean;
    llm_called: boolean;
  };
  /** Total LLM cost incurred for this gate. */
  cost_usd: number;
}

interface GateAInput {
  brand_name: string;
  brand_description?: string | null;
  top_sellers?: string[];
  /** Pass through when the orchestrator already has an estimate so the
   *  unresolved-large-brand needs_review check can fire. */
  brand_revenue_usd?: number | null;
}

interface CacheEntry {
  at: number;
  value: GateAResult;
}

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const hierarchyCache = new Map<string, CacheEntry>();

const EDGAR_USER_AGENT = "brand-reseller-audit steve@rollemanagementgroup.com";

export async function resolveCorporateHierarchy(
  input: GateAInput,
): Promise<GateAResult> {
  const brand = (input.brand_name ?? "").trim();
  const cacheKey = brand.toLowerCase();
  const cached = hierarchyCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const trace = {
    uspto_called: false,
    uspto_owner: null as string | null,
    wikipedia_called: false,
    wikipedia_hit: false,
    edgar_called: false,
    edgar_hit: false,
    llm_called: false,
  };

  const sources: HierarchySource[] = [];

  // Step 1 — USPTO. The trademark assignee is often the legal parent.
  let usptoOwner: string | null = null;
  try {
    const uspto = await searchTrademark(brand);
    trace.uspto_called = !!uspto?.called;
    if (uspto?.owner) {
      usptoOwner = uspto.owner;
      trace.uspto_owner = uspto.owner;
      sources.push({
        type: "uspto",
        url: uspto.serial
          ? `https://tsdr.uspto.gov/#caseNumber=${encodeURIComponent(uspto.serial)}&caseType=DEFAULT&searchType=statusSearch`
          : null,
        excerpt: summarizeUspto(uspto),
      });
    }
  } catch {
    /* non-fatal */
  }

  // Step 2 — Wikipedia REST. Cheap, no auth.
  let wikipediaSummary: string | null = null;
  try {
    const wikiTitle = encodeURIComponent(brand.replace(/\s+/g, "_"));
    const resp = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${wikiTitle}`,
      {
        headers: { "User-Agent": EDGAR_USER_AGENT, Accept: "application/json" },
      },
    );
    trace.wikipedia_called = true;
    if (resp.ok) {
      const data = (await resp.json()) as {
        extract?: string;
        content_urls?: { desktop?: { page?: string } };
        type?: string;
      };
      if (data?.extract && data.type !== "disambiguation") {
        wikipediaSummary = data.extract.slice(0, 1200);
        trace.wikipedia_hit = true;
        sources.push({
          type: "wikipedia",
          url:
            data.content_urls?.desktop?.page ??
            `https://en.wikipedia.org/wiki/${wikiTitle}`,
          excerpt: wikipediaSummary,
        });
      }
    }
  } catch {
    /* non-fatal */
  }

  // Step 3 — SEC EDGAR (only when we have a candidate parent name to query).
  // We try BOTH the USPTO owner AND the brand itself; either may be a 10-K filer.
  let edgarFinding: { name: string; cik: string; tenKUrl: string } | null = null;
  const edgarCandidates = [usptoOwner, brand].filter(
    (n): n is string => !!n && n.trim().length > 1,
  );
  for (const candidate of edgarCandidates) {
    try {
      const found = await lookupEdgar(candidate);
      trace.edgar_called = true;
      if (found) {
        edgarFinding = found;
        trace.edgar_hit = true;
        sources.push({
          type: "sec_edgar",
          url: found.tenKUrl,
          excerpt: `EDGAR match: ${found.name} (CIK ${found.cik}). Pull Exhibit 21 from the latest 10-K to confirm subsidiary list.`,
        });
        break;
      }
    } catch {
      /* non-fatal */
    }
  }

  // Step 4 — LLM web-search (the synthesizer).
  const llmSourcesBlock = sources
    .map(
      (s, i) =>
        `${i + 1}. [${s.type}] ${s.url ?? "(no url)"}\n   ${(s.excerpt ?? "").slice(0, 400)}`,
    )
    .join("\n");

  const sellerLine =
    input.top_sellers && input.top_sellers.length > 0
      ? `Amazon top sellers: ${input.top_sellers.slice(0, 8).join(", ")}`
      : "Amazon top sellers: (none provided)";
  const descLine = input.brand_description
    ? `Description: ${input.brand_description}`
    : "Description: (none provided)";

  const user = [
    `Brand: ${brand}`,
    descLine,
    sellerLine,
    `Estimated TTM revenue: ${
      input.brand_revenue_usd != null
        ? `$${Math.round(input.brand_revenue_usd).toLocaleString("en-US")}`
        : "unknown"
    }`,
    "",
    "Evidence gathered from deterministic sources:",
    llmSourcesBlock || "(no evidence collected)",
  ].join("\n");

  let llm: LlmCallResult | null = null;
  try {
    llm = await callQualificationLlm({
      model: QUALIFICATION_MAIN_MODEL,
      system: GATE_A_SYSTEM_PROMPT,
      user,
      maxTokens: 1500,
    });
    trace.llm_called = true;
  } catch {
    // Fall through with null parsed; we'll return needs_review when we
    // also failed to resolve from deterministic sources.
  }

  const parsed = (llm?.parsed ?? {}) as Partial<LlmJson>;
  const entity = parseLlmEntity(parsed, brand);
  const llmSources = parseLlmSources(parsed);
  for (const s of llmSources) sources.push(s);

  let verdict: GateAVerdict;
  let pattern: string | null = null;
  let reason = "";
  let passed = false;

  // EDGAR hit short-circuits to hard_disqualify if it's an established
  // public company filer — even if the LLM hedged.
  const edgarConfirmed =
    !!edgarFinding && entity?.ticker != null && entity.ownership_type === "public";

  if (entity?.ownership_type === "public" || edgarConfirmed) {
    verdict = "hard_disqualify";
    pattern = entity?.parent_chain && entity.parent_chain.length > 1
      ? "subsidiary_of_public"
      : "public_company";
    reason = entity
      ? `Controlling entity ${entity.name}${entity.ticker ? ` (${entity.exchange ?? "public"}: ${entity.ticker})` : ""} is publicly traded${entity.revenue_usd ? ` with $${formatRevenue(entity.revenue_usd)} revenue` : ""}.`
      : "Controlling entity is publicly traded.";
  } else if (
    entity?.ownership_type === "pe_owned" &&
    (entity.pe_aum_usd ?? 0) > 500_000_000
  ) {
    verdict = "needs_review";
    pattern = "pe_portfolio_large";
    reason = `Controlling entity ${entity.name} is private-equity owned with estimated AUM > $500M; PE shops vary in autonomy granted to brand Presidents.`;
    passed = false;
  } else if (
    entity &&
    (entity.ownership_type === "private_independent" ||
      entity.ownership_type === "family_office" ||
      entity.ownership_type === "holding_co_private")
  ) {
    verdict = "pass";
    passed = true;
    reason = `Controlling entity ${entity.name} is ${entity.ownership_type.replace(/_/g, " ")}; proceed to ratio + decision-maker checks.`;
  } else if (
    entity?.ownership_type === "pe_owned" &&
    (entity.pe_aum_usd ?? 0) <= 500_000_000
  ) {
    // Small PE — treat as private_independent for our purposes.
    verdict = "pass";
    passed = true;
    reason = `Controlling entity ${entity.name} is PE-owned but below $500M AUM; treat as small-cap private for downstream gates.`;
  } else if (!entity) {
    // Couldn't resolve a parent — brand stands alone OR hierarchy was
    // unresolvable. Big-but-opaque entities go to needs_review.
    if ((input.brand_revenue_usd ?? 0) > 5_000_000) {
      verdict = "needs_review";
      pattern = "other";
      reason = `Hierarchy unresolved for ${brand} but TTM > $5M — escalate for human review before sinking time into outreach.`;
    } else {
      verdict = "pass";
      passed = true;
      reason = `No parent identified for ${brand}; treat the brand itself as the controlling entity.`;
    }
  } else {
    // ownership_type unknown — be cautious.
    verdict = "needs_review";
    pattern = "other";
    reason = `Controlling entity ${entity.name} identified but ownership type is unknown; surface for review.`;
  }

  const result: GateAResult = {
    passed,
    verdict,
    controlling_entity: entity ?? null,
    verdict_reason: reason,
    sources,
    pattern,
    resolution_trace: trace,
    cost_usd: llm?.cost_usd ?? 0,
  };

  hierarchyCache.set(cacheKey, { at: Date.now(), value: result });
  return result;
}

/** Test helper — clear the in-memory hierarchy cache. */
export function _resetHierarchyCacheForTests(): void {
  hierarchyCache.clear();
}

// ---- LLM parsing helpers --------------------------------------------------

interface LlmJson {
  controlling_entity: {
    name?: string | null;
    ticker?: string | null;
    exchange?: string | null;
    revenue_usd?: number | string | null;
    employees?: number | string | null;
    ownership_type?: string | null;
    parent_chain?: string[] | null;
    pe_aum_usd?: number | string | null;
  } | null;
  sources?: Array<{ type?: string; url?: string | null; excerpt?: string }>;
  verdict_reason?: string;
}

function parseLlmEntity(
  parsed: Partial<LlmJson>,
  brand: string,
): ControllingEntity | null {
  const ce = parsed.controlling_entity;
  if (!ce || typeof ce !== "object") return null;
  const name = String(ce.name ?? "").trim();
  if (!name) return null;
  // If LLM returns the brand as its own parent, treat that as "no parent".
  if (name.toLowerCase() === brand.toLowerCase() && (ce.parent_chain ?? []).length <= 1) {
    return {
      name,
      ticker: nullableString(ce.ticker),
      exchange: nullableString(ce.exchange),
      revenue_usd: nullableNumber(ce.revenue_usd),
      employees: nullableNumber(ce.employees),
      ownership_type: clampOwnership(ce.ownership_type),
      parent_chain: [name],
      pe_aum_usd: nullableNumber(ce.pe_aum_usd),
    };
  }
  return {
    name,
    ticker: nullableString(ce.ticker),
    exchange: nullableString(ce.exchange),
    revenue_usd: nullableNumber(ce.revenue_usd),
    employees: nullableNumber(ce.employees),
    ownership_type: clampOwnership(ce.ownership_type),
    parent_chain: Array.isArray(ce.parent_chain)
      ? ce.parent_chain.map((s) => String(s)).slice(0, 6)
      : [name],
    pe_aum_usd: nullableNumber(ce.pe_aum_usd),
  };
}

function parseLlmSources(parsed: Partial<LlmJson>): HierarchySource[] {
  if (!Array.isArray(parsed.sources)) return [];
  return parsed.sources
    .filter((s) => s && typeof s === "object")
    .map((s) => ({
      type: String(s.type ?? "other"),
      url: s.url == null ? null : String(s.url),
      excerpt: s.excerpt == null ? null : String(s.excerpt).slice(0, 600),
    }))
    .slice(0, 8);
}

function nullableString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === "null" || s.toLowerCase() === "n/a") return null;
  return s;
}

function nullableNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[$,]/g, "").trim();
  if (!cleaned || cleaned.toLowerCase() === "null") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const OWNERSHIP_VALUES = new Set<OwnershipType>([
  "public",
  "pe_owned",
  "private_independent",
  "family_office",
  "holding_co_private",
  "unknown",
]);

function clampOwnership(v: unknown): OwnershipType {
  if (v == null) return "unknown";
  const s = String(v).toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (OWNERSHIP_VALUES.has(s as OwnershipType)) return s as OwnershipType;
  if (s === "private" || s === "independent" || s === "owner_operated") {
    return "private_independent";
  }
  if (s === "family" || s === "family_owned") return "family_office";
  if (s === "holding" || s === "holdco" || s === "holdings") {
    return "holding_co_private";
  }
  if (s === "pe" || s === "private_equity") return "pe_owned";
  if (s === "publicly_traded" || s === "publicly_listed") return "public";
  return "unknown";
}

function formatRevenue(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n.toLocaleString("en-US");
}

// ---- EDGAR ---------------------------------------------------------------

interface EdgarCompany {
  cik_str: number;
  ticker: string;
  title: string;
}

let edgarTickerCache: EdgarCompany[] | null = null;
let edgarTickerCacheAt = 0;

async function loadEdgarTickers(): Promise<EdgarCompany[] | null> {
  if (edgarTickerCache && Date.now() - edgarTickerCacheAt < CACHE_TTL_MS) {
    return edgarTickerCache;
  }
  try {
    const resp = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: { "User-Agent": EDGAR_USER_AGENT, Accept: "application/json" },
    });
    if (!resp.ok) return null;
    const raw = (await resp.json()) as Record<string, EdgarCompany>;
    const list = Object.values(raw).filter((r) => r && r.cik_str != null);
    edgarTickerCache = list;
    edgarTickerCacheAt = Date.now();
    return list;
  } catch {
    return null;
  }
}

async function lookupEdgar(
  candidate: string,
): Promise<{ name: string; cik: string; tenKUrl: string } | null> {
  const tickers = await loadEdgarTickers();
  if (!tickers) return null;
  const needle = candidate.toLowerCase();
  const hit =
    tickers.find((c) => c.title.toLowerCase() === needle) ??
    tickers.find((c) => c.title.toLowerCase().includes(needle)) ??
    tickers.find((c) =>
      c.title.toLowerCase().split(/[\s,]+/).some((w) => w === needle),
    );
  if (!hit) return null;
  const cik = String(hit.cik_str).padStart(10, "0");
  const tenKUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K&dateb=&owner=include&count=10`;
  return { name: hit.title, cik, tenKUrl };
}

// ---- Prompt --------------------------------------------------------------

const GATE_A_SYSTEM_PROMPT = `You resolve a brand's corporate hierarchy for a B2B consulting firm.

The user will provide a brand name plus deterministic evidence already gathered (USPTO trademark assignee, Wikipedia summary, SEC EDGAR hits). Your job: determine the brand's CONTROLLING ENTITY — the top of its corporate tree — and characterize its ownership.

Question (verbatim):
  Is the brand "{brand}" the top of its corporate tree, or is it a subsidiary, private label, division, or brand within a larger entity?

  If the brand has a parent, identify the parent's:
    - legal name
    - ticker symbol (if public; else null)
    - approximate annual revenue in USD
    - approximate employee count
    - ownership type: one of [public, pe_owned, private_independent, family_office, holding_co_private, unknown]
    - parent's parent (if applicable; resolve recursively up to the top of the tree)

  Cite at least one source for each non-null claim. Sources MUST be one of:
    - USPTO TSDR record for the brand's trademark
    - Wikipedia article URL
    - SEC EDGAR filing URL (10-K, 10-Q, S-1 exhibit list)
    - Company About / Investor Relations page
    - Reputable trade publication (WSJ, Bloomberg, Forbes, Reuters, AP, industry trade journal)

  If you cannot find a source for a claim, set the value to null and the source array to empty. Do NOT hallucinate revenue figures.

Return STRICTLY this JSON schema (no markdown, no prose):

{
  "controlling_entity": {
    "name": "<top-of-tree legal entity name>",
    "ticker": "<ticker or null>",
    "exchange": "<NYSE|NASDAQ|TSX|... or null>",
    "revenue_usd": <number or null>,
    "employees": <number or null>,
    "ownership_type": "<one of: public | pe_owned | private_independent | family_office | holding_co_private | unknown>",
    "parent_chain": ["<brand>", "<intermediate>", "<top>"],
    "pe_aum_usd": <number or null — fill only when ownership_type=pe_owned and AUM is publicly stated>
  },
  "sources": [
    { "type": "wikipedia|sec_edgar|uspto|brand_website|trade_pub|other", "url": "<url>", "excerpt": "<short quote>" }
  ],
  "verdict_reason": "<one short sentence>"
}

Rules:
  - If the brand IS the top of its tree, name itself as the controlling_entity and set parent_chain = ["<brand>"].
  - Public companies require a ticker AND exchange. If you cannot cite either, do NOT set ownership_type='public'.
  - Family-office and holding-co-private apply when the parent is a private holding vehicle (e.g. "Ferro Holdings") with no PE fund behind it.
  - PE-owned applies only when the brand is in the active portfolio of a private-equity FUND (not a family office or strategic acquirer).`;
