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
import { trackCost } from "@/lib/cost/track";

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

// Phase 62 — slim payload MUST surface `first_name`, `last_name`, AND
// `name`. Hunter email-finder needs first+last to run; the orchestrator
// uses `name` as a fallback when Apollo only returns the combined form.
// Dropping any of these three regresses Bug B from the Shearwater audit
// (full_name="Jason" with no last name). Covered by apollo.test.ts.
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
 * Phase 63 — Apollo /people/match with explicit "unlock" semantics.
 *
 * This is the credit-burning variant. Apollo only reveals
 * `person.email` + `person.email_status` + `person.last_name` on paid
 * plans when `reveal_personal_emails=true` is passed and the account
 * has email credits remaining. Each successful reveal burns ONE Apollo
 * email credit.
 *
 * We deliberately set `reveal_phone_number=false` so we don't
 * accidentally burn phone credits — this product never needs phones.
 *
 * Returns the same shape as `apolloMatchPerson` plus an
 * `email_status_raw` field so the orchestrator can map Apollo's status
 * vocabulary ("verified", "extrapolated", null) to our internal
 * vocabulary ("found", "guessed", "not_found").
 */
export interface ApolloUnlockInput {
  domain: string;
  first_name?: string;
  last_name?: string;
  organization_name?: string;
  id?: string;
}

export type ApolloUnlockResult =
  | {
      ok: true;
      person:
        | (ApolloPersonSlim & {
            email_status_raw: string | null;
          })
        | null;
      raw: unknown;
    }
  | { ok: false; error: string; status?: number };

export async function apolloUnlockPerson(
  input: ApolloUnlockInput,
): Promise<ApolloUnlockResult> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return { ok: false, error: "APOLLO_API_KEY missing" };
  if (!input.domain) return { ok: false, error: "domain required" };
  const body: Record<string, unknown> = {
    reveal_personal_emails: true,
    reveal_phone_number: false,
    domain: input.domain,
  };
  if (input.first_name) body.first_name = input.first_name;
  if (input.last_name) body.last_name = input.last_name;
  if (input.organization_name) body.organization_name = input.organization_name;
  if (input.id) body.id = input.id;
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
      `unlock domain=${input.domain} non-ok`,
    );
    return { ok: false, error: `apollo_${resp.status}`, status: resp.status };
  }
  const data = await resp.json().catch(() => ({}));
  await logApi(
    "/people/match",
    resp.status,
    0.04,
    `unlock domain=${input.domain} first=${input.first_name ?? ""} last=${input.last_name ?? ""}`,
  );
  const raw = (data as { person?: unknown; matches?: unknown[] })?.person ??
    (data as { matches?: unknown[] })?.matches?.[0] ??
    null;
  // Phase 81 — log Apollo people-match cost. Apollo only burns the credit
  // when an email reveal succeeds; we approximate by checking for an
  // email field on the returned person.
  const revealedEmail =
    !!(raw as { email?: string } | null)?.email && String((raw as { email?: string }).email).trim().length > 0;
  await trackCost({
    provider: "apollo",
    operation: "apollo_people_match",
    units: revealedEmail ? 1 : 0,
  });
  if (!raw) {
    return { ok: true, person: null, raw: data };
  }
  const slim = slimPerson(raw);
  const emailStatusRaw =
    (raw as { email_status?: unknown })?.email_status != null
      ? String((raw as { email_status?: unknown }).email_status)
      : null;
  return {
    ok: true,
    person: { ...slim, email_status_raw: emailStatusRaw },
    raw: data,
  };
}

/**
 * Map Apollo's email_status vocabulary to our internal email_status:
 *   "verified"    → "found"
 *   "extrapolated"→ "guessed"
 *   null/empty    → "not_found"
 * Anything else falls back to "not_found".
 */
export function mapApolloEmailStatus(
  raw: string | null | undefined,
): "found" | "guessed" | "not_found" {
  if (!raw) return "not_found";
  const v = raw.trim().toLowerCase();
  if (v === "verified") return "found";
  if (v === "extrapolated") return "guessed";
  return "not_found";
}

/**
 * Search people at an org by domain, filtered by titles. Free of enrich
 * credits.
 *
 * Phase 83 — `costOperation` distinguishes the two cascade callers in
 * `api_costs`:
 *   • "apollo_people_match_org" — first attempt, strict decision-maker
 *     title list (founder/ceo/president/owner).
 *   • "apollo_people_match_domain" — fallback attempt with broader
 *     decision-maker titles. Same endpoint, same form encoding, just a
 *     different op label so the bug-triage trail in api_costs shows
 *     which path produced the hit.
 * Legacy callers that don't pass an override keep the historical
 * "apollo_org_search" label so the cost rollup stays stable.
 */
export async function apolloSearchPeople(input: {
  organization_domain: string;
  titles?: string[];
  page?: number;
  costOperation?: string;
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
  // Phase 81/83 — log 0-cost Apollo search for auditability. The
  // operation label distinguishes the two cascade steps.
  await trackCost({
    provider: "apollo",
    operation: input.costOperation ?? "apollo_org_search",
    units: 0,
  });
  const people = (data?.people ?? []).map(slimPerson);
  const total =
    data?.pagination?.total_entries ??
    data?.total_entries ??
    people.length;
  return { ok: true, people, total, raw: data };
}
