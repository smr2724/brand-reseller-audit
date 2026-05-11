/**
 * Phase 69 — Apollo `mixed_people/search` wrapper.
 *
 * Apollo expects `application/x-www-form-urlencoded` with array fields
 * as repeated `key[]=value` (PHP-style) — sending JSON returns a
 * degenerate empty result. Header order is fixed per the Phase 34.2
 * locked convention reused throughout the codebase.
 *
 * Retry: 3 attempts with exponential backoff 500ms → 1500ms → 4500ms.
 * 429 and 5xx are retryable; 401/403 fail closed immediately; other 4xx
 * are returned as-is (the caller decides whether to retry).
 */
import type {
  ApolloMixedSearchInput,
  ApolloMixedSearchResult,
  ApolloPerson,
} from "./strategy-types";

const APOLLO_URL = "https://api.apollo.io/api/v1/mixed_people/search";
const APOLLO_PEOPLE_MATCH_URL = "https://api.apollo.io/api/v1/people/match";
const RETRY_DELAYS_MS = [500, 1500, 4500] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildApolloMixedSearchBody(
  input: ApolloMixedSearchInput,
): URLSearchParams {
  const body = new URLSearchParams();
  if (input.page) body.set("page", String(input.page));
  if (input.per_page) body.set("per_page", String(input.per_page));
  for (const t of input.person_titles ?? []) body.append("person_titles[]", t);
  for (const s of input.person_seniorities ?? []) body.append("person_seniorities[]", s);
  for (const d of input.person_departments ?? []) body.append("person_departments[]", d);
  for (const o of input.organization_ids ?? []) body.append("organization_ids[]", o);
  for (const d of input.q_organization_domains ?? []) {
    body.append("q_organization_domains[]", d);
  }
  // Phase 71 — q_keywords (free-text) lets the Gate C fallback
  // disambiguate by name when the title-only search at a domain returns
  // multiple candidates. Apollo accepts this as a scalar form field, not
  // an array.
  if (input.q_keywords && input.q_keywords.trim().length > 0) {
    body.set("q_keywords", input.q_keywords.trim());
  }
  return body;
}

async function logApi(
  status: number | string,
  costEstimate: number | null,
  summary: string,
): Promise<void> {
  try {
    // Lazy-require so test runs that stub @/lib/supabase/server work and
    // so consumers without next/headers in scope aren't affected.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@/lib/supabase/server") as {
      createSupabaseAdminClient?: () => any;
    };
    const admin = mod.createSupabaseAdminClient?.();
    if (!admin) return;
    await admin.from("api_logs").insert({
      provider: "apollo",
      endpoint: "/mixed_people/search",
      request_summary: summary.slice(0, 500),
      response_status: String(status),
      cost_estimate: costEstimate,
    });
  } catch {
    /* never block on log */
  }
}

function slimPerson(raw: any): ApolloPerson {
  return {
    id: String(raw?.id ?? ""),
    first_name: raw?.first_name ?? null,
    last_name: raw?.last_name ?? null,
    name: raw?.name ?? null,
    title: raw?.title ?? null,
    linkedin_headline: raw?.headline ?? raw?.linkedin_headline ?? null,
    linkedin_url: raw?.linkedin_url ?? null,
    seniority: raw?.seniority ?? null,
    department: Array.isArray(raw?.departments) ? raw.departments[0] ?? null : raw?.department ?? null,
    email: raw?.email ?? null,
    email_status: raw?.email_status ?? null,
    organization_id: raw?.organization?.id ?? raw?.organization_id ?? null,
    organization_name: raw?.organization?.name ?? raw?.organization_name ?? null,
    organization_domain:
      raw?.organization?.primary_domain ??
      raw?.organization?.website_url ??
      raw?.organization_domain ??
      null,
  };
}

export function parseApolloMixedSearchResponse(json: any): ApolloMixedSearchResult {
  const peopleRaw: any[] = Array.isArray(json?.people)
    ? json.people
    : Array.isArray(json?.contacts)
      ? json.contacts
      : [];
  const candidates = peopleRaw.map(slimPerson);
  const pagination = {
    page: Number(json?.pagination?.page ?? 1),
    per_page: Number(json?.pagination?.per_page ?? candidates.length),
    total_pages: Number(json?.pagination?.total_pages ?? 1),
  };
  const total_entries = Number(json?.pagination?.total_entries ?? candidates.length);
  // Apollo doesn't always echo a credit cost; assume 1 credit / candidate
  // returned (worst-case) when the response omits the field.
  const cost_credits =
    typeof json?.cost_credits === "number"
      ? json.cost_credits
      : Math.max(1, candidates.length);
  return {
    ok: true,
    candidates,
    total_entries,
    pagination,
    cost_credits,
  };
}

export async function apolloMixedPeopleSearch(
  input: ApolloMixedSearchInput,
  deps?: {
    fetchImpl?: typeof fetch;
    apiKey?: string;
  },
): Promise<ApolloMixedSearchResult> {
  const apiKey = deps?.apiKey ?? process.env.APOLLO_API_KEY;
  const empty: ApolloMixedSearchResult = {
    ok: false,
    candidates: [],
    total_entries: 0,
    pagination: { page: 1, per_page: input.per_page ?? 25, total_pages: 0 },
    cost_credits: 0,
  };
  if (!apiKey) return { ...empty, error: "APOLLO_API_KEY missing" };

  const body = buildApolloMixedSearchBody({
    per_page: 25,
    ...input,
  });

  const doFetch = deps?.fetchImpl ?? fetch;

  let lastStatus: number | null = null;
  let lastText = "";

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    let resp: Response;
    try {
      resp = await doFetch(APOLLO_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Cache-Control": "no-cache",
          "X-Api-Key": apiKey,
        },
        body,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < RETRY_DELAYS_MS.length - 1) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      await logApi("network_error", 0.05, `network ${msg}`);
      return { ...empty, error: `apollo_network_${msg}` };
    }

    if (resp.status === 401 || resp.status === 403) {
      await logApi(resp.status, 0, `auth_${resp.status}`);
      return { ...empty, error: `apollo_auth_${resp.status}` };
    }
    if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
      lastStatus = resp.status;
      try {
        lastText = await resp.text();
      } catch {
        /* ignore */
      }
      if (attempt < RETRY_DELAYS_MS.length - 1) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      await logApi(resp.status, 0.05, `retry_exhausted ${lastText.slice(0, 80)}`);
      return { ...empty, error: `apollo_${resp.status}` };
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      await logApi(resp.status, 0.05, `fatal_${resp.status} ${txt.slice(0, 80)}`);
      return { ...empty, error: `apollo_${resp.status}` };
    }

    let json: any = {};
    try {
      json = await resp.json();
    } catch {
      json = {};
    }
    const parsed = parseApolloMixedSearchResponse(json);
    await logApi(
      resp.status,
      0.05,
      `titles=${(input.person_titles ?? []).slice(0, 3).join("|")} found=${parsed.candidates.length}`,
    );
    return parsed;
  }

  return {
    ...empty,
    error: `apollo_${lastStatus ?? "unknown"}`,
  };
}

/**
 * Phase 71 — Apollo `/v1/people/match` wrapper, keyed on the Gate C
 * decision-maker's LinkedIn URL.
 *
 * When Gate C named a real human AND captured their LinkedIn URL, that's
 * the highest-confidence seed we have for Apollo contact enrichment.
 * `/people/match` is the precision endpoint — Apollo resolves the
 * LinkedIn URL to a single person record and (on paid plans with
 * reveal_personal_emails=true) reveals their email.
 *
 * Same Apollo conventions as mixed_people/search:
 *   - `application/x-www-form-urlencoded` body
 *   - 3-attempt retry on 429 / 5xx with 500ms → 1500ms → 4500ms backoff
 *   - 401/403 fail closed immediately.
 *
 * Returns the slimmed `ApolloPerson` shape so the orchestrator can drop
 * the result straight into the ranking / brand_contacts pipeline.
 */
export interface ApolloPeopleMatchInput {
  /** Phase 72 — optional. When null/empty/omitted, the form body omits
   *  the `linkedin_url` key entirely (sending an empty string breaks
   *  Apollo's matching). The wrapper requires either a non-empty
   *  linkedin_url OR (first_name + last_name + organization_name). */
  linkedin_url?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  organization_name?: string | null;
}

export interface ApolloPeopleMatchResult {
  ok: boolean;
  person: (ApolloPerson & { email_status_raw: string | null }) | null;
  cost_credits: number;
  raw?: unknown;
  error?: string;
}

export function buildApolloPeopleMatchBody(
  input: ApolloPeopleMatchInput,
): URLSearchParams {
  const body = new URLSearchParams();
  // Phase 72 — omit `linkedin_url` from the form body when null/empty.
  // Sending `linkedin_url=` (empty string) breaks Apollo's matching;
  // when the LinkedIn URL is unverified or hallucinated, we fall back
  // to first_name + last_name + organization_name as the matching
  // triple, which Apollo accepts.
  if (input.linkedin_url && input.linkedin_url.trim().length > 0) {
    body.set("linkedin_url", input.linkedin_url.trim());
  }
  if (input.first_name) body.set("first_name", input.first_name);
  if (input.last_name) body.set("last_name", input.last_name);
  if (input.organization_name && input.organization_name.trim().length > 0) {
    body.set("organization_name", input.organization_name.trim());
  }
  // Phase 63 convention — explicit unlock semantics.
  body.set("reveal_personal_emails", "true");
  body.set("reveal_phone_number", "false");
  return body;
}

export async function apolloPeopleMatchByLinkedIn(
  input: ApolloPeopleMatchInput,
  deps?: {
    fetchImpl?: typeof fetch;
    apiKey?: string;
  },
): Promise<ApolloPeopleMatchResult> {
  const apiKey = deps?.apiKey ?? process.env.APOLLO_API_KEY;
  if (!apiKey)
    return { ok: false, person: null, cost_credits: 0, error: "APOLLO_API_KEY missing" };
  // Phase 72 — accept either a non-empty linkedin_url OR
  // (first_name + last_name + organization_name) as the matching signals.
  // Reject calls with neither — Apollo would return no hit anyway and
  // we'd waste a credit.
  const hasLinkedin =
    typeof input.linkedin_url === "string" && input.linkedin_url.trim().length > 0;
  const hasNameTriple =
    !!input.first_name &&
    !!input.last_name &&
    typeof input.organization_name === "string" &&
    input.organization_name.trim().length > 0;
  if (!hasLinkedin && !hasNameTriple) {
    return {
      ok: false,
      person: null,
      cost_credits: 0,
      error: "insufficient_signals",
    };
  }

  const body = buildApolloPeopleMatchBody(input);
  const doFetch = deps?.fetchImpl ?? fetch;

  let lastStatus: number | null = null;
  let lastText = "";

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    let resp: Response;
    try {
      resp = await doFetch(APOLLO_PEOPLE_MATCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Cache-Control": "no-cache",
          "X-Api-Key": apiKey,
        },
        body,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < RETRY_DELAYS_MS.length - 1) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      await logPeopleMatchApi("network_error", 0.05, `network ${msg}`);
      return {
        ok: false,
        person: null,
        cost_credits: 0,
        error: `apollo_network_${msg}`,
      };
    }

    if (resp.status === 401 || resp.status === 403) {
      await logPeopleMatchApi(resp.status, 0, `auth_${resp.status}`);
      return {
        ok: false,
        person: null,
        cost_credits: 0,
        error: `apollo_auth_${resp.status}`,
      };
    }
    if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
      lastStatus = resp.status;
      try {
        lastText = await resp.text();
      } catch {
        /* ignore */
      }
      if (attempt < RETRY_DELAYS_MS.length - 1) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      await logPeopleMatchApi(
        resp.status,
        0.05,
        `retry_exhausted ${lastText.slice(0, 80)}`,
      );
      return {
        ok: false,
        person: null,
        cost_credits: 0,
        error: `apollo_${resp.status}`,
      };
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      await logPeopleMatchApi(
        resp.status,
        0.05,
        `fatal_${resp.status} ${txt.slice(0, 80)}`,
      );
      return {
        ok: false,
        person: null,
        cost_credits: 0,
        error: `apollo_${resp.status}`,
      };
    }

    const data: any = await resp.json().catch(() => ({}));
    const raw = data?.person ?? data?.matches?.[0] ?? null;
    const person = raw ? slimPerson(raw) : null;
    const email_status_raw =
      raw && raw.email_status != null ? String(raw.email_status) : null;
    const cost_credits =
      typeof data?.cost_credits === "number" ? data.cost_credits : person ? 1 : 0;
    await logPeopleMatchApi(
      resp.status,
      0.05,
      `linkedin=${(input.linkedin_url ?? "").slice(0, 80)} name=${input.first_name ?? ""}/${input.last_name ?? ""} org=${(input.organization_name ?? "").slice(0, 40)} hit=${person ? "1" : "0"}`,
    );
    return {
      ok: true,
      person: person ? { ...person, email_status_raw } : null,
      cost_credits,
      raw: data,
    };
  }

  return {
    ok: false,
    person: null,
    cost_credits: 0,
    error: `apollo_${lastStatus ?? "unknown"}`,
  };
}

async function logPeopleMatchApi(
  status: number | string,
  costEstimate: number | null,
  summary: string,
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@/lib/supabase/server") as {
      createSupabaseAdminClient?: () => any;
    };
    const admin = mod.createSupabaseAdminClient?.();
    if (!admin) return;
    await admin.from("api_logs").insert({
      provider: "apollo",
      endpoint: "/people/match",
      request_summary: summary.slice(0, 500),
      response_status: String(status),
      cost_estimate: costEstimate,
    });
  } catch {
    /* never block on log */
  }
}
