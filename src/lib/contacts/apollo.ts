/**
 * Phase 47 — Hardened Apollo wrappers used by the new contact-discovery
 * orchestrator. These are deliberately scoped to the two operations the
 * orchestrator needs (search by domain, match by name+domain) and use
 * the Phase 34.2 form-encoding contract — `application/x-www-form-urlencoded`
 * with array fields as repeated `key[]=value` (NOT JSON).
 *
 * Existing legacy Apollo callers in `src/lib/apollo.ts` and
 * `src/lib/owner-resolver/apollo-client.ts` are unchanged — they have
 * their own retry/auth shape. New code should prefer this wrapper.
 *
 * Retry/backoff/api_logs pattern matches the email-verify wrapper.
 */
import { encodeApolloFormBody } from "./apollo-encoding";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

const APOLLO_BASE = "https://api.apollo.io/api/v1";

export interface ApolloPersonSlim {
  id: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  title?: string;
  seniority?: string;
  linkedin_url?: string;
  email?: string;
  email_status?: string;
  organization_id?: string;
  organization_name?: string;
  organization_domain?: string;
}

export type ApolloMatchResult =
  | { ok: true; person: ApolloPersonSlim | null; raw: unknown }
  | { ok: false; error: string; status?: number };

export type ApolloSearchResult =
  | { ok: true; people: ApolloPersonSlim[]; total: number; raw: unknown }
  | { ok: false; error: string; status?: number };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logApi(
  endpoint: string,
  status: number | string,
  costEstimate: number | null,
  summary: string,
): Promise<void> {
  try {
    const admin = createSupabaseAdminClient();
    if (!admin) return;
    await admin.from("api_logs").insert({
      provider: "apollo",
      endpoint,
      request_summary: summary.slice(0, 500),
      response_status: String(status),
      cost_estimate: costEstimate,
    });
  } catch {
    /* never block on log */
  }
}

async function postForm(
  path: string,
  body: Record<string, unknown>,
  apiKey: string,
): Promise<Response> {
  const delays = [250, 1000, 4000];
  let last: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const r = await fetch(`${APOLLO_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache",
        "X-Api-Key": apiKey,
      },
      body: encodeApolloFormBody(body),
    });
    if (r.status === 401 || r.status === 403) {
      throw Object.assign(new Error(`apollo_auth_${r.status}`), {
        status: r.status,
      });
    }
    if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
      last = r;
      await sleep(delays[attempt] ?? 4000);
      continue;
    }
    return r;
  }
  if (last) return last;
  throw new Error("apollo_retry_exhausted");
}

function slimPerson(p: any): ApolloPersonSlim {
  return {
    id: String(p?.id ?? ""),
    first_name: p?.first_name ?? undefined,
    last_name: p?.last_name ?? undefined,
    name: p?.name ?? undefined,
    title: p?.title ?? undefined,
    seniority: p?.seniority ?? undefined,
    linkedin_url: p?.linkedin_url ?? undefined,
    email: p?.email ?? undefined,
    email_status: p?.email_status ?? undefined,
    organization_id: p?.organization?.id ?? p?.organization_id ?? undefined,
    organization_name:
      p?.organization?.name ?? p?.organization_name ?? undefined,
    organization_domain:
      p?.organization?.primary_domain ??
      p?.organization?.website_url ??
      p?.organization_domain ??
      undefined,
  };
}

/**
 * Match a single person at a domain. Apollo charges credits per match;
 * use only for the candidates we keep.
 */
export async function apolloMatchPerson(input: {
  domain: string;
  first_name?: string;
  last_name?: string;
}): Promise<ApolloMatchResult> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return { ok: false, error: "APOLLO_API_KEY missing" };
  if (!input.domain) return { ok: false, error: "domain required" };
  const body: Record<string, unknown> = {
    reveal_personal_emails: true,
    domain: input.domain,
  };
  if (input.first_name) body.first_name = input.first_name;
  if (input.last_name) body.last_name = input.last_name;
  let resp: Response;
  try {
    resp = await postForm("/people/match", body, key);
  } catch (e) {
    const status = (e as { status?: number })?.status;
    const msg = e instanceof Error ? e.message : String(e);
    await logApi("/people/match", status ?? "error", 0.02, msg);
    return { ok: false, error: msg, status };
  }
  if (!resp.ok) {
    await logApi(
      "/people/match",
      resp.status,
      0,
      `domain=${input.domain} non-ok`,
    );
    return { ok: false, error: `apollo_${resp.status}`, status: resp.status };
  }
  const data = await resp.json().catch(() => ({}));
  await logApi(
    "/people/match",
    resp.status,
    0.02,
    `domain=${input.domain} first=${input.first_name ?? ""} last=${input.last_name ?? ""}`,
  );
  const raw = (data as any)?.person ?? (data as any)?.matches?.[0] ?? null;
  return { ok: true, person: raw ? slimPerson(raw) : null, raw: data };
}

/**
 * Search people at an org by domain, filtered by titles. Free of enrich
 * credits.
 */
export async function apolloSearchPeople(input: {
  organization_domain: string;
  titles?: string[];
  page?: number;
}): Promise<ApolloSearchResult> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return { ok: false, error: "APOLLO_API_KEY missing" };
  if (!input.organization_domain)
    return { ok: false, error: "organization_domain required" };
  const body: Record<string, unknown> = {
    page: input.page ?? 1,
    per_page: 10,
    q_organization_domains_list: [input.organization_domain],
  };
  if (input.titles && input.titles.length > 0) {
    body.person_titles = input.titles;
  }
  let resp: Response;
  try {
    resp = await postForm("/mixed_people/api_search", body, key);
  } catch (e) {
    const status = (e as { status?: number })?.status;
    const msg = e instanceof Error ? e.message : String(e);
    await logApi("/mixed_people/api_search", status ?? "error", 0, msg);
    return { ok: false, error: msg, status };
  }
  if (!resp.ok) {
    await logApi(
      "/mixed_people/api_search",
      resp.status,
      0,
      `domain=${input.organization_domain} non-ok`,
    );
    return { ok: false, error: `apollo_${resp.status}`, status: resp.status };
  }
  const data = (await resp.json().catch(() => ({}))) as {
    people?: any[];
    pagination?: { total_entries?: number };
    total_entries?: number;
  };
  await logApi(
    "/mixed_people/api_search",
    resp.status,
    0,
    `domain=${input.organization_domain} titles=${(input.titles ?? []).join(",")}`,
  );
  const people = (data?.people ?? []).map(slimPerson);
  const total =
    data?.pagination?.total_entries ??
    data?.total_entries ??
    people.length;
  return { ok: true, people, total, raw: data };
}
