/**
 * Phase 33 — Web-search adapter.
 *
 * Harvests candidate owner companies + domains from web searches against
 * a brand name. Uses Perplexity Search API if `PERPLEXITY_API_KEY` is set,
 * else Brave Search API if `BRAVE_SEARCH_API_KEY` is set. If neither is
 * available, returns an empty result with a clear `error` value so the
 * orchestrator can fall back to a USPTO-only run.
 *
 * All non-business sites (marketplaces, social, encyclopedias) are denied
 * via a static deny-list. Candidates are de-duplicated by registrable
 * domain and capped at 30 per run.
 */
import type { RawOwnerCandidate } from "./types";

export interface WebSearchOptions {
  fetchImpl?: typeof fetch;
  perplexityApiKey?: string | null;
  braveApiKey?: string | null;
  /** Override the per-query candidate cap (default 15). */
  maxPerQuery?: number;
  /** Override the total candidate cap (default 30). */
  maxTotal?: number;
}

export interface WebSearchResultItem {
  title: string | null;
  url: string;
  snippet: string | null;
  query: string;
}

export interface WebSearchAdapterResult {
  queries: string[];
  candidates: RawOwnerCandidate[];
  raw: unknown;
  error: string | null;
  results_count: number;
}

const DEFAULT_MAX_PER_QUERY = 15;
const DEFAULT_MAX_TOTAL = 30;

/** Static deny-list — no candidate may have a registrable domain in this set
 * or matching one of the suffix patterns. */
export const DOMAIN_DENY_LIST: ReadonlyArray<string> = [
  "amazon.com",
  "amazon.co.uk",
  "amazon.ca",
  "amazon.de",
  "amazon.fr",
  "amazon.it",
  "amazon.es",
  "amazon.co.jp",
  "amazon.in",
  "amazon.com.mx",
  "amazon.com.br",
  "ebay.com",
  "walmart.com",
  "target.com",
  "costco.com",
  "samsclub.com",
  "alibaba.com",
  "aliexpress.com",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "youtube.com",
  "pinterest.com",
  "reddit.com",
  "wikipedia.org",
  "wikidata.org",
  "quora.com",
  "yelp.com",
  "bbb.org",
  "trustpilot.com",
];

const DENY_TLD_PREFIXES: ReadonlyArray<string> = [
  "amazon.", // any amazon.<tld>
];

/** Strip `www.`, `m.`, `mobile.`, `shop.` from the host and return just the
 * registrable host (best-effort — uses last 2 labels for plain TLDs and
 * last 3 for known 2-part TLDs like `.co.uk`). */
export function registrableDomain(input: string): string | null {
  if (!input) return null;
  let host = input.trim().toLowerCase();
  try {
    if (/^https?:\/\//.test(host)) {
      host = new URL(host).hostname;
    }
  } catch {
    // Not a URL — treat input as already a host.
  }
  host = host.replace(/^www\./, "").replace(/^m\./, "").replace(/^mobile\./, "");
  if (!host || host.includes(" ")) return null;
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const TWO_PART_TLDS = new Set([
    "co.uk",
    "com.au",
    "com.br",
    "com.mx",
    "co.jp",
    "co.nz",
    "co.in",
    "com.cn",
  ]);
  const last2 = parts.slice(-2).join(".");
  const last3 = parts.slice(-3).join(".");
  if (parts.length >= 3 && TWO_PART_TLDS.has(last2)) {
    return last3;
  }
  return last2;
}

export function isDeniedDomain(domain: string | null): boolean {
  if (!domain) return false;
  const lower = domain.toLowerCase();
  if (DOMAIN_DENY_LIST.includes(lower)) return true;
  for (const prefix of DENY_TLD_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

/** Best-effort company name from a result title. Trims marketing
 * boilerplate after common separators (` - `, ` | `, `: `) and strips a
 * trailing TLD-style site name. Falls back to the capitalized domain. */
export function inferCompanyName(
  title: string | null,
  domain: string | null,
): string | null {
  if (title) {
    const trimmed = title
      .split(/\s+[-|–—]\s+/)[0]!
      .split(/\s+:\s+/)[0]!
      .trim();
    if (trimmed.length > 0 && trimmed.length < 120) return trimmed;
  }
  if (domain) {
    const stem = domain.split(".")[0] ?? domain;
    return stem
      .split(/[-_]/)
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(" ");
  }
  return null;
}

export function buildQueries(brandName: string): string[] {
  const trimmed = brandName.trim();
  return [
    `"${trimmed}" manufacturer site`,
    `"${trimmed}" official website`,
    `"${trimmed}" company who makes`,
  ];
}

interface ProviderResult {
  items: WebSearchResultItem[];
  raw: unknown;
  error: string | null;
}

async function searchPerplexity(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<ProviderResult> {
  try {
    const res = await fetchImpl("https://api.perplexity.ai/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query }),
      cache: "no-store",
    } as RequestInit);
    if (!res.ok) {
      return { items: [], raw: null, error: `perplexity ${res.status}` };
    }
    const json = (await res.json()) as unknown;
    const items: WebSearchResultItem[] = [];
    const arr =
      (json && typeof json === "object" && Array.isArray((json as any).results)
        ? ((json as any).results as unknown[])
        : []);
    for (const r of arr) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const url = typeof o.url === "string" ? o.url : null;
      if (!url) continue;
      items.push({
        url,
        title: typeof o.title === "string" ? o.title : null,
        snippet:
          typeof o.snippet === "string"
            ? o.snippet
            : typeof o.description === "string"
              ? (o.description as string)
              : null,
        query,
      });
    }
    return { items, raw: json, error: null };
  } catch (e) {
    return {
      items: [],
      raw: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function searchBrave(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<ProviderResult> {
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        "X-Subscription-Token": apiKey,
        Accept: "application/json",
      },
      cache: "no-store",
    } as RequestInit);
    if (!res.ok) {
      return { items: [], raw: null, error: `brave ${res.status}` };
    }
    const json = (await res.json()) as unknown;
    const items: WebSearchResultItem[] = [];
    const arr =
      json &&
      typeof json === "object" &&
      (json as any).web &&
      Array.isArray((json as any).web.results)
        ? ((json as any).web.results as unknown[])
        : [];
    for (const r of arr) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const u = typeof o.url === "string" ? o.url : null;
      if (!u) continue;
      items.push({
        url: u,
        title: typeof o.title === "string" ? o.title : null,
        snippet:
          typeof o.description === "string"
            ? (o.description as string)
            : typeof o.snippet === "string"
              ? (o.snippet as string)
              : null,
        query,
      });
    }
    return { items, raw: json, error: null };
  } catch (e) {
    return {
      items: [],
      raw: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Run all queries for `brandName`, harvest candidates, dedupe by
 * registrable domain (case-insensitive), and return up to
 * `maxTotal` results.
 */
export async function searchWebForOwners(
  brandName: string,
  opts: WebSearchOptions = {},
): Promise<WebSearchAdapterResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const perplexityKey =
    opts.perplexityApiKey ?? process.env.PERPLEXITY_API_KEY ?? null;
  const braveKey = opts.braveApiKey ?? process.env.BRAVE_SEARCH_API_KEY ?? null;
  const maxPerQuery = opts.maxPerQuery ?? DEFAULT_MAX_PER_QUERY;
  const maxTotal = opts.maxTotal ?? DEFAULT_MAX_TOTAL;
  const queries = buildQueries(brandName);

  if (!perplexityKey && !braveKey) {
    return {
      queries,
      candidates: [],
      raw: null,
      error:
        "no web-search API key configured (PERPLEXITY_API_KEY or BRAVE_SEARCH_API_KEY)",
      results_count: 0,
    };
  }

  const rawByQuery: Record<string, unknown> = {};
  let allItems: WebSearchResultItem[] = [];
  for (const q of queries) {
    const provider = perplexityKey
      ? await searchPerplexity(q, perplexityKey, fetchImpl)
      : await searchBrave(q, braveKey as string, fetchImpl);
    rawByQuery[q] = provider.raw;
    if (provider.items.length > 0) {
      allItems = allItems.concat(provider.items.slice(0, maxPerQuery));
    }
  }

  // Track which queries surfaced each domain so the heuristic can reward
  // multi-query overlap as a signal.
  const domainQueryHits = new Map<string, Set<string>>();
  for (const it of allItems) {
    const dom = registrableDomain(it.url);
    if (!dom || isDeniedDomain(dom)) continue;
    const set = domainQueryHits.get(dom) ?? new Set<string>();
    set.add(it.query);
    domainQueryHits.set(dom, set);
  }

  const dedup = new Map<string, RawOwnerCandidate>();
  for (const it of allItems) {
    const domain = registrableDomain(it.url);
    if (!domain || isDeniedDomain(domain)) continue;
    const company = inferCompanyName(it.title, domain) ?? domain;
    const key = `${company.toLowerCase()} ${domain.toLowerCase()}`;
    if (dedup.has(key)) continue;
    const queriesForDomain = Array.from(
      domainQueryHits.get(domain) ?? new Set<string>(),
    );
    const candidate: RawOwnerCandidate = {
      candidate_company_name: company,
      candidate_domain: domain,
      candidate_source: "web_search",
      evidence_text: it.snippet,
      evidence_url: it.url,
      match_reason: `search result for ${it.query}`,
      trademark_serial_number: null,
      trademark_status: null,
      trademark_registration_date: null,
      trademark_owner_address: null,
      goods_services_text: null,
      raw_payload: { ...it, queries_for_domain: queriesForDomain },
    };
    dedup.set(key, candidate);
    if (dedup.size >= maxTotal) break;
  }

  return {
    queries,
    candidates: Array.from(dedup.values()),
    raw: rawByQuery,
    error: null,
    results_count: allItems.length,
  };
}

/** Exposed for the heuristic so it can count query overlap per domain. */
export function countDistinctQueriesForDomain(
  candidates: RawOwnerCandidate[],
  domain: string | null,
): number {
  if (!domain) return 0;
  const target = domain.toLowerCase();
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!c.candidate_domain) continue;
    if (c.candidate_domain.toLowerCase() !== target) continue;
    const payload = c.raw_payload;
    if (payload && typeof payload === "object" && Array.isArray((payload as any).queries_for_domain)) {
      for (const q of (payload as any).queries_for_domain as unknown[]) {
        if (typeof q === "string") seen.add(q);
      }
    }
  }
  return seen.size;
}
