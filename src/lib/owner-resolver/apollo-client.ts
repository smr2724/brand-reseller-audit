/**
 * Phase 34 / 34.1 / 34.2 / 34.3 — Apollo client for organization search +
 * contact counting.
 *
 * Used by the owner resolver to attach Apollo organization metadata to
 * extracted owner candidates. Endpoints:
 *
 *   POST https://api.apollo.io/v1/mixed_companies/search   (form-encoded)
 *     Apollo's PUBLIC organizations directory.
 *   POST https://api.apollo.io/v1/accounts/search          (form-encoded)
 *     The user's CRM Accounts (only set if they've saved orgs in Apollo).
 *   POST https://api.apollo.io/v1/organizations/enrich     (form-encoded)
 *     Single-org enrich-by-domain endpoint. Different code path than
 *     `mixed_companies/search` and often hits when search misses.
 *   POST https://api.apollo.io/v1/mixed_people/search      (form-encoded)
 *     Used to count contacts per organization_id.
 *
 * Phase 34.3 — Two big additions:
 *   1. `accounts/search` runs in PARALLEL with `mixed_companies/search`
 *      for every tier. The user's CRM accounts (e.g. "Diversified
 *      Hospitality Solutions") are NOT in Apollo's public
 *      `mixed_companies/search` index, so we need both endpoints to
 *      surface them. Results are merged but each org carries an
 *      `apollo_source` discriminator so the UI can tag them with a
 *      "Your Apollo CRM" vs "Apollo Public" badge.
 *   2. A new tier 4 — `organizations/enrich?domain=...` — fires when
 *      tiers 1-3 return zero. This is a different mechanism than search
 *      and Apollo often returns hits via enrich that search missed.
 *   3. The cleaned-name function now drops trailing generic-suffix words
 *      (`Solutions`, `Group`, `Holdings`, `Brands`, ...) when the cleaned
 *      base is still ≥ 2 words. So
 *      "Diversified Hospitality Solutions" → "Diversified Hospitality"
 *      but "Acme Corp" → "Acme Corp" (drop would leave only one word).
 *
 * Phase 34.2 — `mixed_companies/search` was being called with a JSON
 * body. Apollo's documented contract for these endpoints is form-encoded
 * POST: when sent JSON, Apollo's gateway returns 200 OK with empty
 * arrays. The fix in 34.2 was to send `application/x-www-form-urlencoded`
 * with array fields encoded as repeated `key[]=value` pairs.
 *
 * Phase 34.1 — `searchOrganizationsTiered` walks a tier ladder so we
 * stop bailing out on `apollo_no_match` whenever the first query returned
 * zero. Caller passes a budget counter so the orchestrator can cap total
 * Apollo calls per resolver run.
 *
 * Per-run cache keyed by `endpoint|name|domain` so re-runs and dedup
 * don't re-charge against rate quota. Modest concurrency (2) and small
 * backoff on 429 / 5xx.
 */
import { rateLimit } from "./rate-limit";

const APOLLO_BASE = "https://api.apollo.io";
const ORG_SEARCH_PATH = "/v1/mixed_companies/search";
const ACCOUNTS_SEARCH_PATH = "/v1/accounts/search";
const ORG_ENRICH_PATH = "/v1/organizations/enrich";
const PEOPLE_SEARCH_PATH = "/v1/mixed_people/search";
const RETRY_DELAYS_MS = [500, 1500];
const RETRY_STATUSES = new Set<number>([429, 500, 502, 503, 504]);
const DEFAULT_TIER_BUDGET = 12;

export type ApolloSearchTier =
  | "name_and_domain"
  | "domain_only"
  | "cleaned_name"
  | "domain_enrich";

export type ApolloSource = "public" | "crm";

export interface ApolloOrganization {
  id: string;
  name: string;
  primary_domain: string | null;
  estimated_num_employees: number | null;
  organization_city: string | null;
  organization_country: string | null;
  industry: string | null;
  /**
   * Phase 34.3 — Where this hit came from. `crm` means it surfaced from
   * the user's `accounts/search` (saved Apollo CRM account); `public`
   * means it came from `mixed_companies/search` or
   * `organizations/enrich`. The UI uses this to render a
   * "Your Apollo CRM" vs "Apollo Public" badge.
   */
  apollo_source: ApolloSource;
}

export interface ApolloTieredSearchResult {
  orgs: ApolloOrganization[];
  /**
   * Phase 34.3 — The first tier that produced any hits. Null when every
   * tier returned zero. We continue to compute a single per-candidate
   * tier label for the legacy "Apollo match (tier=...)" affordance.
   */
  tier_used: ApolloSearchTier | null;
  calls_made: number;
  per_tier: Array<{
    tier: ApolloSearchTier;
    endpoint: "mixed_companies" | "accounts" | "enrich";
    query: Record<string, unknown>;
    hit_count: number;
  }>;
}

export interface ApolloClientOptions {
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  /**
   * Phase 34.1 — Soft cap on Apollo org-search calls per client instance
   * across all `searchOrganizationsTiered` invocations. Default 12.
   * countContacts calls do NOT count against this budget. Once
   * exhausted, additional calls short-circuit to empty.
   */
  searchBudget?: number;
}

export interface ApolloAuditEntry {
  tier: ApolloSearchTier | "people_count";
  endpoint:
    | "mixed_companies"
    | "accounts"
    | "enrich"
    | "people";
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
   * Phase 34.3 — Walks the tier ladder, calling BOTH
   * `mixed_companies/search` and `accounts/search` at each tier. Returns
   * a deduplicated list of orgs (matched on id+source) annotated with
   * `apollo_source` so the caller can render the right badge. Stops at
   * the first tier that yields ≥ 1 hit across either endpoint, except
   * tier 4 (domain enrich) only fires if tiers 1-3 all returned zero.
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
 * repeated `key[]=value` pairs (PHP-style brackets). Sending a JSON body
 * to `mixed_companies/search` returns a generic empty result instead of
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
 * Phase 34.1 / 34.3 — Strip common legal-suffix and parenthetical noise
 * from a company name so a cleaned-name Apollo query has a chance of
 * matching "Diversified Hospitality Solutions, Ltd." to the org indexed
 * as "Diversified Hospitality". Idempotent.
 *
 * 34.3 additions:
 *  - Drop a final word in {Solutions, Group, Holdings, Brands, Co,
 *    Company, Corp, Corporation, Limited, Ltd} when the cleaned base is
 *    still ≥ 2 words. This lets us match the actual indexed root name.
 *    "Acme Corp" stays "Acme Corp" because dropping "Corp" leaves a
 *    single word.
 */
const TRAILING_GENERIC_TOKENS = new Set([
  "solutions",
  "group",
  "holdings",
  "brands",
  "co",
  "company",
  "corp",
  "corporation",
  "limited",
  "ltd",
  "incorporated",
  "inc",
  "llc",
  "industries",
  "international",
  "global",
  "enterprises",
]);

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

  // Phase 34.3 — Drop a trailing generic suffix word ("Solutions",
  // "Group", "Holdings", "Brands", ...) when the cleaned base would
  // still be ≥ 2 words. This is the rule that turns "Diversified
  // Hospitality Solutions" into "Diversified Hospitality" but leaves
  // "Acme Corp" alone.
  for (let i = 0; i < 2; i += 1) {
    const tokens = s.split(/\s+/).filter(Boolean);
    if (tokens.length < 3) break;
    const lastToken = tokens[tokens.length - 1];
    if (!lastToken) break;
    const lastNorm = lastToken.replace(/[.,;:]+$/, "").toLowerCase();
    if (!TRAILING_GENERIC_TOKENS.has(lastNorm)) break;
    tokens.pop();
    s = tokens.join(" ");
  }
  return s.replace(/[,;]+$/, "").trim();
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
    endpoint: string,
    tier: string,
    name: string,
    domain: string | null,
  ): string =>
    `${endpoint}|${tier}|${name.trim().toLowerCase()}|${(domain ?? "").trim().toLowerCase()}`;

  async function rawSearch(
    tier: ApolloSearchTier,
    endpoint: "mixed_companies" | "accounts" | "enrich",
    body: Record<string, unknown>,
    cacheKey: string,
  ): Promise<CachedSearch> {
    const cached = orgCache.get(cacheKey);
    if (cached) return cached;
    if (searchBudget <= 0) {
      const stub: CachedSearch = {
        result: [],
        raw: { error: "apollo search budget exhausted", tier, endpoint },
        status: null,
        error: "apollo search budget exhausted",
      };
      orgCache.set(cacheKey, stub);
      auditEntries.push({
        tier,
        endpoint,
        candidate_name:
          typeof body.q_organization_name === "string"
            ? body.q_organization_name
            : typeof body.domain === "string"
              ? body.domain
              : null,
        request: { url: `${APOLLO_BASE}${endpointPath(endpoint)}`, body },
        response: { status: null, error: "apollo search budget exhausted" },
        hit_count: 0,
        attempted_at: new Date().toISOString(),
      });
      return stub;
    }
    searchBudget -= 1;
    const path = endpointPath(endpoint);
    const result = await rateLimit(
      {
        key: "apollo",
        maxConcurrent: 2,
        minIntervalMs: 250,
        maxWaitMs: 60_000,
      },
      () => searchOrganizationsImpl(path, endpoint, body, apiKey, fetchImpl),
    );
    orgCache.set(cacheKey, result);
    auditEntries.push({
      tier,
      endpoint,
      candidate_name:
        typeof body.q_organization_name === "string"
          ? body.q_organization_name
          : typeof body.domain === "string"
            ? body.domain
            : null,
      request: { url: `${APOLLO_BASE}${path}`, body },
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
    const cacheKey = orgKey("mixed_companies", "legacy", trimmed, domain ?? null);
    const result = await rawSearch("name_and_domain", "mixed_companies", body, cacheKey);
    return result.result;
  }

  // Phase 34.3 — Run a single tier against BOTH `mixed_companies/search`
  // and `accounts/search`. Returns the merged hits for that tier.
  async function runTierBothEndpoints(
    tier: ApolloSearchTier,
    name: string | null,
    domain: string | null,
  ): Promise<{
    orgs: ApolloOrganization[];
    perTier: ApolloTieredSearchResult["per_tier"];
    callsMade: number;
  }> {
    const perTier: ApolloTieredSearchResult["per_tier"] = [];
    const orgs: ApolloOrganization[] = [];
    let callsMade = 0;
    const seenKey = new Set<string>(); // dedupe across the two endpoints by id+source

    for (const endpoint of ["mixed_companies", "accounts"] as const) {
      const body: Record<string, unknown> = { page: 1, per_page: 5 };
      if (name) body.q_organization_name = name;
      if (domain) body.q_organization_domains = [domain];
      // Skip degenerate queries (no name AND no domain).
      if (!name && !domain) continue;
      const cacheKey = orgKey(endpoint, tier, name ?? "", domain ?? null);
      const cached = orgCache.get(cacheKey);
      const before = searchBudget;
      const result = await rawSearch(tier, endpoint, body, cacheKey);
      const fresh = !cached;
      if (fresh && before > searchBudget) callsMade += 1;
      perTier.push({
        tier,
        endpoint,
        query: body,
        hit_count: result.result.length,
      });
      for (const o of result.result) {
        const k = `${o.id}|${o.apollo_source}`;
        if (seenKey.has(k)) continue;
        seenKey.add(k);
        orgs.push(o);
      }
    }
    return { orgs, perTier, callsMade };
  }

  async function searchOrganizationsTiered(
    name: string,
    domain: string | null,
  ): Promise<ApolloTieredSearchResult> {
    const trimmed = name.trim();
    const cleaned = cleanCompanyName(trimmed);

    const tiers: Array<{
      tier: ApolloSearchTier;
      name: string | null;
      domain: string | null;
    }> = [];

    if (trimmed && domain) {
      tiers.push({ tier: "name_and_domain", name: trimmed, domain });
    }
    if (domain) {
      tiers.push({ tier: "domain_only", name: null, domain });
    }
    if (cleaned && cleaned.toLowerCase() !== trimmed.toLowerCase()) {
      tiers.push({ tier: "cleaned_name", name: cleaned, domain: null });
    } else if (trimmed && tiers.length === 0) {
      // No domain, cleaning was a no-op — try the original name as the
      // only tier so we still emit a query.
      tiers.push({ tier: "cleaned_name", name: trimmed, domain: null });
    }

    const perTier: ApolloTieredSearchResult["per_tier"] = [];
    let callsMade = 0;
    let firstTierHit: ApolloSearchTier | null = null;
    const allOrgs: ApolloOrganization[] = [];
    const dedupe = new Set<string>();

    for (const t of tiers) {
      const r = await runTierBothEndpoints(t.tier, t.name, t.domain);
      perTier.push(...r.perTier);
      callsMade += r.callsMade;
      if (r.orgs.length > 0) {
        if (!firstTierHit) firstTierHit = t.tier;
        for (const o of r.orgs) {
          const k = `${o.id}|${o.apollo_source}`;
          if (dedupe.has(k)) continue;
          dedupe.add(k);
          allOrgs.push(o);
        }
        // Stop at the first tier that yields hits across either endpoint.
        return {
          orgs: allOrgs,
          tier_used: firstTierHit,
          calls_made: callsMade,
          per_tier: perTier,
        };
      }
    }

    // Phase 34.3 — Tier 4: organizations/enrich by domain. Only fires
    // when tiers 1-3 all came back empty AND we have a domain to work
    // with.
    if (domain) {
      const enrichBody: Record<string, unknown> = { domain };
      const enrichKey = orgKey("enrich", "domain_enrich", "", domain);
      const cached = orgCache.get(enrichKey);
      const before = searchBudget;
      const enrichResult = await rawSearch(
        "domain_enrich",
        "enrich",
        enrichBody,
        enrichKey,
      );
      const fresh = !cached;
      if (fresh && before > searchBudget) callsMade += 1;
      perTier.push({
        tier: "domain_enrich",
        endpoint: "enrich",
        query: enrichBody,
        hit_count: enrichResult.result.length,
      });
      if (enrichResult.result.length > 0) {
        for (const o of enrichResult.result) {
          const k = `${o.id}|${o.apollo_source}`;
          if (dedupe.has(k)) continue;
          dedupe.add(k);
          allOrgs.push(o);
        }
        return {
          orgs: allOrgs,
          tier_used: "domain_enrich",
          calls_made: callsMade,
          per_tier: perTier,
        };
      }
    }

    return {
      orgs: [],
      tier_used: null,
      calls_made: callsMade,
      per_tier: perTier,
    };
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
      endpoint: "people",
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

function endpointPath(endpoint: "mixed_companies" | "accounts" | "enrich"): string {
  switch (endpoint) {
    case "mixed_companies":
      return ORG_SEARCH_PATH;
    case "accounts":
      return ACCOUNTS_SEARCH_PATH;
    case "enrich":
      return ORG_ENRICH_PATH;
  }
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
          // Phase 34.2 — Apollo's `mixed_companies/search`,
          // `accounts/search`, `organizations/enrich`, and
          // `mixed_people/search` all expect form-encoded bodies.
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "Cache-Control": "no-cache",
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
  path: string,
  endpoint: "mixed_companies" | "accounts" | "enrich",
  body: Record<string, unknown>,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<CachedSearch> {
  const res = await fetchWithRetry(
    `${APOLLO_BASE}${path}`,
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
  const orgs = parseOrganizationsForEndpoint(json, endpoint);
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
    console.log(
      JSON.stringify({
        scope: "apollo.countContacts",
        organization_id: organizationId,
        status: null,
        error: "fetch failed",
      }),
    );
    return { count: null, raw: null, status: null, error: "fetch failed" };
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
    console.log(
      JSON.stringify({
        scope: "apollo.countContacts",
        organization_id: organizationId,
        status: res.status,
        error: `apollo ${res.status}`,
        body: errBody,
      }),
    );
    return {
      count: null,
      raw: { error: `apollo ${res.status}`, body: errBody },
      status: res.status,
      error: `apollo ${res.status}`,
    };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    console.log(
      JSON.stringify({
        scope: "apollo.countContacts",
        organization_id: organizationId,
        status: res.status,
        error: "invalid JSON",
      }),
    );
    return {
      count: null,
      raw: { error: "invalid JSON" },
      status: res.status,
      error: "invalid JSON",
    };
  }
  const parsed = parseTotalEntries(json);
  if (parsed == null) {
    // Successful 2xx but Apollo did not return a parseable
    // pagination.total_entries. We split this into two sub-cases:
    //  (a) `people` is a present array — even an empty one — and a
    //      `pagination` block exists. Apollo returned a real,
    //      structured-empty result; report it as 0 contacts.
    //  (b) Neither `people` nor `pagination` are present. The response
    //      shape doesn't look like the documented contract — likely a
    //      plan-permission soft-fail or a gateway response. Return null
    //      so the caller can fall back to the org-side
    //      `estimated_num_employees` proxy (Phase 38).
    const root =
      json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    const peopleArr = Array.isArray(root.people) ? root.people : null;
    const hasPagination = root.pagination != null;
    const looksStructured = peopleArr != null && hasPagination;
    console.log(
      JSON.stringify({
        scope: "apollo.countContacts",
        organization_id: organizationId,
        status: res.status,
        warning: "missing total_entries",
        looks_structured: looksStructured,
        has_pagination: hasPagination,
        pagination_keys:
          root.pagination && typeof root.pagination === "object"
            ? Object.keys(root.pagination as Record<string, unknown>)
            : null,
        people_length: peopleArr ? peopleArr.length : null,
        top_level_keys: Object.keys(root),
      }),
    );
    return {
      count: looksStructured ? peopleArr!.length : null,
      raw: json,
      status: res.status,
    };
  }
  return {
    count: parsed,
    raw: json,
    status: res.status,
  };
}

/**
 * Phase 34.3 — Endpoint-aware parser. Each endpoint returns a slightly
 * different shape:
 *   - `mixed_companies/search` → { organizations: [...] }
 *   - `accounts/search`        → { accounts: [...] }
 *   - `organizations/enrich`   → { organization: {...} }  (single)
 *
 * We tag every parsed org with its `apollo_source` (`crm` for accounts,
 * `public` for the rest) so the UI can render the right badge.
 */
export function parseOrganizationsForEndpoint(
  json: unknown,
  endpoint: "mixed_companies" | "accounts" | "enrich",
): ApolloOrganization[] {
  if (!json || typeof json !== "object") return [];
  const root = json as Record<string, unknown>;
  const candidates: unknown[] = [];

  if (endpoint === "enrich") {
    // organizations/enrich returns a single `organization` object.
    const org = root.organization;
    if (org && typeof org === "object") candidates.push(org);
  } else if (endpoint === "accounts") {
    const v = root.accounts;
    if (Array.isArray(v)) candidates.push(...v);
  } else {
    // mixed_companies/search — be defensive: read `organizations` first
    // and `accounts` as a fallback (legacy).
    const orgs = root.organizations;
    if (Array.isArray(orgs)) candidates.push(...orgs);
    if (candidates.length === 0) {
      const acc = root.accounts;
      if (Array.isArray(acc)) candidates.push(...acc);
    }
  }

  const apolloSource: ApolloSource = endpoint === "accounts" ? "crm" : "public";
  const out: ApolloOrganization[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = pickString(o, "id", "organization_id", "account_id");
    const name = pickString(o, "name", "organization_name", "account_name");
    if (!id || !name) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      primary_domain: pickString(
        o,
        "primary_domain",
        "domain",
        "website_url",
      ),
      estimated_num_employees: pickInt(
        o,
        "estimated_num_employees",
        "num_employees",
      ),
      organization_city: pickString(o, "organization_city", "city"),
      organization_country: pickString(o, "organization_country", "country"),
      industry: pickString(o, "industry"),
      apollo_source: apolloSource,
    });
    if (out.length >= 5) break;
  }
  return out;
}

/** Backwards-compatible default — used by anything still reading the
 * legacy `parseOrganizations` export. Treats input as a `mixed_companies`
 * payload. */
export function parseOrganizations(json: unknown): ApolloOrganization[] {
  return parseOrganizationsForEndpoint(json, "mixed_companies");
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
