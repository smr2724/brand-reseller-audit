/**
 * Phase 34 — Apollo client for organization search + contact counting.
 *
 * Used by the owner resolver to attach Apollo organization metadata to
 * extracted owner candidates. Two endpoints:
 *
 *   POST https://api.apollo.io/v1/mixed_companies/search
 *     { q_organization_name, q_organization_domains?, page, per_page }
 *   POST https://api.apollo.io/v1/mixed_people/search
 *     { organization_ids: [id], page, per_page }
 *
 * Per-run cache keyed by `name|domain` so re-runs and dedup work don't
 * re-charge against rate quota. Modest concurrency (2) and small backoff
 * on 429 / 5xx.
 */
import { rateLimit } from "./rate-limit";

const APOLLO_BASE = "https://api.apollo.io";
const ORG_SEARCH_PATH = "/v1/mixed_companies/search";
const PEOPLE_SEARCH_PATH = "/v1/mixed_people/search";
const RETRY_DELAYS_MS = [500, 1500];
const RETRY_STATUSES = new Set<number>([429, 500, 502, 503, 504]);

export interface ApolloOrganization {
  id: string;
  name: string;
  primary_domain: string | null;
  estimated_num_employees: number | null;
  organization_city: string | null;
  organization_country: string | null;
  industry: string | null;
}

export interface ApolloClientOptions {
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
}

export interface ApolloClient {
  searchOrganizations(name: string, domain?: string | null): Promise<ApolloOrganization[]>;
  countContacts(organizationId: string): Promise<number | null>;
  /** For diagnostics — last raw payload per cache key. */
  rawSearches(): Record<string, unknown>;
}

interface CachedSearch {
  result: ApolloOrganization[];
  raw: unknown;
}

interface CachedCount {
  count: number | null;
}

export function createApolloClient(opts: ApolloClientOptions = {}): ApolloClient | null {
  const apiKeyRaw = opts.apiKey ?? process.env.APOLLO_API_KEY ?? null;
  if (!apiKeyRaw) return null;
  const apiKey: string = apiKeyRaw;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const orgCache = new Map<string, CachedSearch>();
  const countCache = new Map<string, CachedCount>();

  const orgKey = (name: string, domain?: string | null) =>
    `${name.trim().toLowerCase()}|${(domain ?? "").trim().toLowerCase()}`;

  async function searchOrganizations(
    name: string,
    domain?: string | null,
  ): Promise<ApolloOrganization[]> {
    const trimmed = name.trim();
    if (!trimmed) return [];
    const cacheKey = orgKey(trimmed, domain);
    const cached = orgCache.get(cacheKey);
    if (cached) return cached.result;

    const result = await rateLimit(
      {
        key: "apollo",
        maxConcurrent: 2,
        minIntervalMs: 250,
        maxWaitMs: 60_000,
      },
      () => searchOrganizationsImpl(trimmed, domain ?? null, apiKey, fetchImpl),
    );
    orgCache.set(cacheKey, result);
    return result.result;
  }

  async function countContacts(organizationId: string): Promise<number | null> {
    const cleanId = (organizationId ?? "").trim();
    if (!cleanId) return null;
    const cached = countCache.get(cleanId);
    if (cached) return cached.count;
    const count = await rateLimit(
      {
        key: "apollo",
        maxConcurrent: 2,
        minIntervalMs: 250,
        maxWaitMs: 60_000,
      },
      () => countContactsImpl(cleanId, apiKey, fetchImpl),
    );
    countCache.set(cleanId, { count });
    return count;
  }

  function rawSearches(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Array.from(orgCache.entries())) {
      out[k] = v.raw;
    }
    return out;
  }

  return { searchOrganizations, countContacts, rawSearches };
}

async function fetchWithRetry(
  url: string,
  body: unknown,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<Response | null> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    let res: Response | null = null;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          // Apollo accepts api_key in body or X-Api-Key header.
          "X-Api-Key": apiKey,
        },
        body: JSON.stringify(body),
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
  name: string,
  domain: string | null,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<CachedSearch> {
  const body: Record<string, unknown> = {
    q_organization_name: name,
    page: 1,
    per_page: 3,
  };
  if (domain) {
    body.q_organization_domains = [domain];
  }
  const res = await fetchWithRetry(
    `${APOLLO_BASE}${ORG_SEARCH_PATH}`,
    body,
    apiKey,
    fetchImpl,
  );
  if (!res || !res.ok) {
    return { result: [], raw: { error: res ? `apollo ${res.status}` : "fetch failed" } };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    return { result: [], raw: { error: "invalid JSON" } };
  }
  const orgs = parseOrganizations(json);
  return { result: orgs, raw: json };
}

async function countContactsImpl(
  organizationId: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<number | null> {
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
  if (!res || !res.ok) return null;
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  return parseTotalEntries(json);
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
