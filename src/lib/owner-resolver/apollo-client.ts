/**
 * Phase 34 / 34.1 / 34.2 — Apollo client for organization search + contact
 * counting.
 *
 * Used by the owner resolver to attach Apollo organization metadata to
 * extracted owner candidates. Two endpoints:
 *
 *   POST https://api.apollo.io/v1/mixed_companies/search
 *     (form-encoded body)  q_organization_name, q_organization_domains[]?, page, per_page
 *   POST https://api.apollo.io/v1/mixed_people/search
 *     (form-encoded body)  organization_ids[], page, per_page
 *
 * Phase 34.2 ROOT CAUSE FIX — `mixed_companies/search` was being called with
 * a JSON body and `Content-Type: application/json`. Apollo's documented
 * contract for this endpoint is form-encoded POST: when sent JSON, Apollo's
 * gateway returns 200 OK with an empty `organizations: []` array (it
 * silently ignores unrecognized parameters), which manifested as
 * `apollo_no_match` for companies that very much exist in the user's
 * account (e.g. "Diversified Hospitality Solutions, Ltd.").
 *
 * The fix: send the body as `application/x-www-form-urlencoded`, with
 * array fields encoded as repeated `q_organization_domains[]=...`. Same
 * for `mixed_people/search` (organization_ids[]=...). API key still goes
 * in the `X-Api-Key` header (Apollo accepts either header or `api_key`
 * body field; header keeps it out of access logs).
 *
 * Phase 34.1 — `searchOrganizationsTiered` walks a 3-tier fallback so we
 * stop bailing out on `apollo_no_match` whenever the first query returned
 * zero. Tiers:
 *   1. name + domain  (current behavior, exact-pair lookup)
 *   2. domain only    (catches name spelling drift)
 *   3. cleaned name   (drops parentheticals, ", LLC", trademark
 *                      punctuation, etc.)
 *
 * Stops at the first tier that returns ≥ 1 hit. Caller passes a budget
 * counter so the orchestrator can cap total Apollo calls per resolver run.
 *
 * Per-run cache keyed by `name|domain` so re-runs and dedup don't re-charge
 * against rate quota. Modest concurrency (2) and small backoff on
 * 429 / 5xx.
 *
 * Phase 34.2 also exposes `rawAuditEntries()` so the orchestrator can
 * persist the full request/response trail to
 * `owner_resolution_runs.raw_apollo_payload` for ongoing observability.
 */
import { rateLimit } from "./rate-limit";

const APOLLO_BASE = "https://api.apollo.io";
const ORG_SEARCH_PATH = "/v1/mixed_companies/search";
const PEOPLE_SEARCH_PATH = "/v1/mixed_people/search";
const RETRY_DELAYS_MS = [500, 1500];
const RETRY_STATUSES = new Set<number>([429, 500, 502, 503, 504]);
const DEFAULT_TIER_BUDGET = 12;

export type ApolloSearchTier = "name_and_domain" | "domain_only" | "cleaned_name";

export interface ApolloOrganization {
  id: string;
  name: string;
  primary_domain: string | null;
  estimated_num_employees: number | null;
  organization_city: string | null;
  organization_country: string | null;
  industry: string | null;
}

export interface ApolloTieredSearchResult {
  orgs: ApolloOrganization[];
  tier_used: ApolloSearchTier | null;
  calls_made: number;
  per_tier: Array<{ tier: ApolloSearchTier; query: Record<string, unknown>; hit_count: number }>;
}

export interface ApolloClientOptions {
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  /**
   * Phase 34.1 — Soft cap on Apollo org-search calls per client instance
   * across all `searchOrganizationsTiered` invocations. Default 12 (≈ 4
   * candidates × 3 tiers). countContacts calls do NOT count against this
   * budget. Once exhausted, additional calls short-circuit to empty.
   */
  searchBudget?: number;
}

export interface ApolloAuditEntry {
  tier: ApolloSearchTier | "people_count";
  candidate_name: string | null;
  request: { url: string; body: Record<string, unknown> };
  response:
    | { status: number; body: unknown }
    | { status: null; error: string };
  hit_count: number | null;
  attempted_at: string;
}

export interface ApolloClient {
  searchOrganizations(name: string, domain?: string | null): Promise<ApolloOrganization[]>;
  /**
   * Phase 34.1 — 3-tier fallback. Stops at the first tier that returns
   * ≥ 1 hit. Returns the orgs + which tier produced them + how many calls
   * we burned (for telemetry).
   */
  searchOrganizationsTiered(
    name: string,
    domain: string | null,
  ): Promise<ApolloTieredSearchResult>;
  countContacts(organizationId: string): Promise<number | null>;
  /** For diagnostics — last raw payload per cache key. */
  rawSearches(): Record<string, unknown>;
  /**
   * Phase 34.2 — Full request/response audit trail for every Apollo call
   * this client made (org search + people count). Persisted to
   * `owner_resolution_runs.raw_apollo_payload`.
   */
  rawAuditEntries(): ApolloAuditEntry[];
  /** Phase 34.1 — How many search-budget calls remain. */
  searchBudgetRemaining(): number;
}

interface CachedSearch {
  result: ApolloOrganization[];
  raw: unknown;
  status: number | null;
  error?: string;
}

interface CachedCount {
  count: number | null;
}

/**
 * Phase 34.2 — Encode a body of mixed scalar / array values as
 * application/x-www-form-urlencoded. Apollo expects array params as
 * repeated `key[]=value` pairs (PHP-style brackets). This is the form
 * Apollo's PHP/Rails gateway parses correctly; sending a JSON body to
 * `mixed_companies/search` returns a generic empty result instead of
 * the matching organizations.
 */
export function encodeApolloFormBody(body: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v === null || v === undefined) continue;
        parts.push(
          `${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(v))}`,
        );
      }
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

/**
 * Phase 34.1 — Strip common legal-suffix and parenthetical noise from a
 * company name so a cleaned-name Apollo query has a chance of matching
 * "Diversified Hospitality Solutions, Ltd." to the org indexed as
 * "Diversified Hospitality Solutions". Idempotent.
 */
export function cleanCompanyName(input: string): string {
  if (!input) return "";
  let s = input.trim();
  // Strip parentheticals — "Acme (USA)" → "Acme".
  s = s.replace(/\s*\([^)]*\)/g, " ");
  // Strip trademark punctuation.
  s = s.replace(/[®™©]/g, "");
  // Strip trailing legal suffixes (comma-separated form).
  const SUFFIX_RE =
    /,?\s*(?:Ltd\.?|Limited|LLC\.?|L\.L\.C\.?|Inc\.?|Incorporated|Corp\.?|Corporation|Co\.?|Company|GmbH|AG|S\.?A\.?|S\.?A\.?S\.?|S\.?L\.?|B\.?V\.?|Pty\.?\s*Ltd\.?|Pte\.?\s*Ltd\.?|N\.?V\.?|PLC|LP|LLP)\.?$/gi;
  for (let i = 0; i < 3; i += 1) {
    const next = s.replace(SUFFIX_RE, "").trim();
    if (next === s) break;
    s = next;
  }
  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();
  // Remove a trailing comma left over after suffix stripping.
  s = s.replace(/[,;]+$/, "").trim();
  return s;
}

export function createApolloClient(opts: ApolloClientOptions = {}): ApolloClient | null {
  const apiKeyRaw = opts.apiKey ?? process.env.APOLLO_API_KEY ?? null;
  if (!apiKeyRaw) return null;
  const apiKey: string = apiKeyRaw;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let searchBudget = Math.max(0, opts.searchBudget ?? DEFAULT_TIER_BUDGET);

  const orgCache = new Map<string, CachedSearch>();
  const countCache = new Map<string, CachedCount>();
  const auditEntries: ApolloAuditEntry[] = [];

  const orgKey = (
    tier: string,
    name: string,
    domain: string | null,
  ): string => `${tier}|${name.trim().toLowerCase()}|${(domain ?? "").trim().toLowerCase()}`;

  async function rawSearch(
    tier: ApolloSearchTier,
    body: Record<string, unknown>,
    cacheKey: string,
  ): Promise<CachedSearch> {
    const cached = orgCache.get(cacheKey);
    if (cached) return cached;
    if (searchBudget <= 0) {
      const stub: CachedSearch = {
        result: [],
        raw: { error: "apollo search budget exhausted", tier },
        status: null,
        error: "apollo search budget exhausted",
      };
      orgCache.set(cacheKey, stub);
      auditEntries.push({
        tier,
        candidate_name:
          typeof body.q_organization_name === "string"
            ? body.q_organization_name
            : null,
        request: { url: `${APOLLO_BASE}${ORG_SEARCH_PATH}`, body },
        response: { status: null, error: "apollo search budget exhausted" },
        hit_count: 0,
        attempted_at: new Date().toISOString(),
      });
      return stub;
    }
    searchBudget -= 1;
    const result = await rateLimit(
      {
        key: "apollo",
        maxConcurrent: 2,
        minIntervalMs: 250,
        maxWaitMs: 60_000,
      },
      () => searchOrganizationsImpl(body, apiKey, fetchImpl),
    );
    orgCache.set(cacheKey, result);
    auditEntries.push({
      tier,
      candidate_name:
        typeof body.q_organization_name === "string"
          ? body.q_organization_name
          : null,
      request: { url: `${APOLLO_BASE}${ORG_SEARCH_PATH}`, body },
      response:
        result.status != null
          ? { status: result.status, body: result.raw }
          : { status: null, error: result.error ?? "fetch failed" },
      hit_count: result.result.length,
      attempted_at: new Date().toISOString(),
    });
    return result;
  }

  async function searchOrganizations(
    name: string,
    domain?: string | null,
  ): Promise<ApolloOrganization[]> {
    const trimmed = name.trim();
    if (!trimmed) return [];
    const body: Record<string, unknown> = {
      q_organization_name: trimmed,
      page: 1,
      per_page: 3,
    };
    if (domain) body.q_organization_domains = [domain];
    const cacheKey = orgKey("legacy", trimmed, domain ?? null);
    const result = await rawSearch("name_and_domain", body, cacheKey);
    return result.result;
  }

  async function searchOrganizationsTiered(
    name: string,
    domain: string | null,
  ): Promise<ApolloTieredSearchResult> {
    const trimmed = name.trim();
    const cleaned = cleanCompanyName(trimmed);
    const tiers: Array<{ tier: ApolloSearchTier; body: Record<string, unknown> | null }> = [];

    if (trimmed && domain) {
      tiers.push({
        tier: "name_and_domain",
        body: {
          q_organization_name: trimmed,
          q_organization_domains: [domain],
          page: 1,
          per_page: 3,
        },
      });
    }
    if (domain) {
      tiers.push({
        tier: "domain_only",
        body: {
          q_organization_domains: [domain],
          page: 1,
          per_page: 3,
        },
      });
    }
    if (cleaned && cleaned.toLowerCase() !== trimmed.toLowerCase()) {
      tiers.push({
        tier: "cleaned_name",
        body: {
          q_organization_name: cleaned,
          page: 1,
          per_page: 3,
        },
      });
    } else if (trimmed && tiers.length === 0) {
      // No domain, no cleaning yielded a different string — still try the
      // original name as the only tier.
      tiers.push({
        tier: "cleaned_name",
        body: {
          q_organization_name: trimmed,
          page: 1,
          per_page: 3,
        },
      });
    }

    const perTier: ApolloTieredSearchResult["per_tier"] = [];
    let callsMade = 0;
    for (const t of tiers) {
      if (!t.body) continue;
      const body = t.body;
      const cacheKey = orgKey(
        t.tier,
        (body.q_organization_name as string | undefined) ?? "",
        Array.isArray(body.q_organization_domains)
          ? ((body.q_organization_domains as string[])[0] ?? null)
          : null,
      );
      const cached = orgCache.get(cacheKey);
      const before = searchBudget;
      const result = await rawSearch(t.tier, body, cacheKey);
      const fresh = !cached;
      if (fresh && before > searchBudget) callsMade += 1;
      perTier.push({
        tier: t.tier,
        query: body,
        hit_count: result.result.length,
      });
      if (result.result.length > 0) {
        return {
          orgs: result.result,
          tier_used: t.tier,
          calls_made: callsMade,
          per_tier: perTier,
        };
      }
    }
    return { orgs: [], tier_used: null, calls_made: callsMade, per_tier: perTier };
  }

  async function countContacts(organizationId: string): Promise<number | null> {
    const cleanId = (organizationId ?? "").trim();
    if (!cleanId) return null;
    const cached = countCache.get(cleanId);
    if (cached) return cached.count;
    const result = await rateLimit(
      {
        key: "apollo",
        maxConcurrent: 2,
        minIntervalMs: 250,
        maxWaitMs: 60_000,
      },
      () => countContactsImpl(cleanId, apiKey, fetchImpl),
    );
    countCache.set(cleanId, { count: result.count });
    auditEntries.push({
      tier: "people_count",
      candidate_name: null,
      request: {
        url: `${APOLLO_BASE}${PEOPLE_SEARCH_PATH}`,
        body: { organization_ids: [cleanId], page: 1, per_page: 1 },
      },
      response:
        result.status != null
          ? { status: result.status, body: result.raw }
          : { status: null, error: result.error ?? "fetch failed" },
      hit_count: result.count ?? 0,
      attempted_at: new Date().toISOString(),
    });
    return result.count;
  }

  function rawSearches(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Array.from(orgCache.entries())) {
      out[k] = v.raw;
    }
    return out;
  }

  function rawAuditEntries(): ApolloAuditEntry[] {
    return auditEntries.slice();
  }

  function searchBudgetRemaining(): number {
    return searchBudget;
  }

  return {
    searchOrganizations,
    searchOrganizationsTiered,
    countContacts,
    rawSearches,
    rawAuditEntries,
    searchBudgetRemaining,
  };
}

async function fetchWithRetry(
  url: string,
  body: Record<string, unknown>,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<Response | null> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    let res: Response | null = null;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: {
          // Phase 34.2 — Apollo's `mixed_companies/search` and
          // `mixed_people/search` expect form-encoded bodies. Sending JSON
          // returned 200 with empty `organizations: []`.
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "Cache-Control": "no-cache",
          // Apollo accepts api_key in body or X-Api-Key header.
          "X-Api-Key": apiKey,
        },
        body: encodeApolloFormBody(body),
        cache: "no-store",
      } as RequestInit);
    } catch {
      res = null;
    }
    if (res && res.ok) return res;
    if (res && !RETRY_STATUSES.has(res.status)) return res;
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) {
      await new Promise((r) => setTimeout(r, delay));
    } else {
      return res;
    }
  }
  return null;
}

async function searchOrganizationsImpl(
  body: Record<string, unknown>,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<CachedSearch> {
  const res = await fetchWithRetry(
    `${APOLLO_BASE}${ORG_SEARCH_PATH}`,
    body,
    apiKey,
    fetchImpl,
  );
  if (!res) {
    return {
      result: [],
      raw: { error: "fetch failed" },
      status: null,
      error: "fetch failed",
    };
  }
  if (!res.ok) {
    let errBody: unknown = null;
    try {
      errBody = await res.json();
    } catch {
      try {
        errBody = await res.text();
      } catch {
        errBody = null;
      }
    }
    return {
      result: [],
      raw: { error: `apollo ${res.status}`, body: errBody },
      status: res.status,
      error: `apollo ${res.status}`,
    };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    return {
      result: [],
      raw: { error: "invalid JSON" },
      status: res.status,
      error: "invalid JSON",
    };
  }
  const orgs = parseOrganizations(json);
  return { result: orgs, raw: json, status: res.status };
}

interface CountImplResult {
  count: number | null;
  raw: unknown;
  status: number | null;
  error?: string;
}

async function countContactsImpl(
  organizationId: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<CountImplResult> {
  const body = {
    organization_ids: [organizationId],
    page: 1,
    per_page: 1,
  };
  const res = await fetchWithRetry(
    `${APOLLO_BASE}${PEOPLE_SEARCH_PATH}`,
    body,
    apiKey,
    fetchImpl,
  );
  if (!res) {
    return { count: null, raw: null, status: null, error: "fetch failed" };
  }
  if (!res.ok) {
    return {
      count: null,
      raw: { error: `apollo ${res.status}` },
      status: res.status,
      error: `apollo ${res.status}`,
    };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    return {
      count: null,
      raw: { error: "invalid JSON" },
      status: res.status,
      error: "invalid JSON",
    };
  }
  return {
    count: parseTotalEntries(json),
    raw: json,
    status: res.status,
  };
}

export function parseOrganizations(json: unknown): ApolloOrganization[] {
  if (!json || typeof json !== "object") return [];
  const root = json as Record<string, unknown>;
  // Apollo returns `organizations` for some queries and `accounts` for others;
  // mixed_companies/search returns `organizations`, but be defensive.
  const candidates: unknown[] = [];
  for (const key of ["organizations", "accounts"]) {
    const v = root[key];
    if (Array.isArray(v)) {
      candidates.push(...v);
    }
  }
  const out: ApolloOrganization[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = pickString(o, "id", "organization_id");
    const name = pickString(o, "name", "organization_name");
    if (!id || !name) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      primary_domain: pickString(o, "primary_domain", "website_url", "domain"),
      estimated_num_employees: pickInt(o, "estimated_num_employees", "num_employees"),
      organization_city: pickString(o, "organization_city", "city"),
      organization_country: pickString(o, "organization_country", "country"),
      industry: pickString(o, "industry"),
    });
    if (out.length >= 3) break;
  }
  return out;
}

export function parseTotalEntries(json: unknown): number | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const pag = root.pagination;
  if (pag && typeof pag === "object") {
    const total = (pag as Record<string, unknown>).total_entries;
    if (typeof total === "number" && Number.isFinite(total)) return total;
    if (typeof total === "string" && /^\d+$/.test(total)) return parseInt(total, 10);
  }
  const flat = root.total_entries;
  if (typeof flat === "number" && Number.isFinite(flat)) return flat;
  return null;
}

function pickString(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function pickInt(o: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  }
  return null;
}
