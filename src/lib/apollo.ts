/**
 * Apollo.io integration.
 *
 * Two-step pattern that minimizes credit burn:
 *   1) `searchPeopleByCompany` — list candidates (no email reveal, no enrich credits)
 *   2) `enrichPerson` — only called for the 3 contacts we keep
 *
 * Apollo docs: https://apolloio.github.io/apollo-api-docs/
 */
const APOLLO_BASE = "https://api.apollo.io/api/v1";

export function isApolloConfigured() {
  return !!process.env.APOLLO_API_KEY;
}

export interface ApolloPerson {
  id: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  title?: string;
  seniority?: string;
  departments?: string[];
  linkedin_url?: string;
  city?: string;
  state?: string;
  country?: string;
  email?: string;
  email_status?: string;
  organization?: { id?: string; name?: string; website_url?: string; primary_domain?: string };
}

export interface SearchResult {
  ok: true;
  total: number;
  people: ApolloPerson[];
}

export interface SearchError {
  ok: false;
  error: string;
}

/**
 * Step 1 — search by organization name OR domain. Free of enrich credits.
 * We pull the first 25 people and the total count so the UI can tell Steve
 * how many candidates exist before he decides to enrich.
 */
export async function searchPeopleByCompany(opts: {
  companyName?: string;
  domain?: string;
  perPage?: number;
}): Promise<SearchResult | SearchError> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return { ok: false, error: "APOLLO_API_KEY missing" };

  const body: Record<string, unknown> = {
    page: 1,
    per_page: opts.perPage ?? 25,
    // Bias toward decision makers — these are Apollo's standard seniority buckets.
    person_seniorities: ["owner", "founder", "c_suite", "partner", "vp", "head", "director", "manager"],
  };

  if (opts.domain) {
    // New api_search endpoint expects an array (or newline-separated string).
    body.q_organization_domains_list = [opts.domain];
  } else if (opts.companyName) {
    body.q_organization_name = opts.companyName;
  } else {
    return { ok: false, error: "Need companyName or domain" };
  }

  try {
    // Apollo deprecated /mixed_people/search in 2025; the API-key replacement is /mixed_people/api_search.
    const r = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": key,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text();
      return { ok: false, error: `Apollo ${r.status}: ${text.slice(0, 200)}` };
    }
    const data = await r.json();
    const people: ApolloPerson[] = (data.people ?? []).map((p: any) => ({
      id: p.id,
      first_name: p.first_name,
      last_name: p.last_name,
      name: p.name,
      title: p.title,
      seniority: p.seniority,
      departments: p.departments,
      linkedin_url: p.linkedin_url,
      city: p.city,
      state: p.state,
      country: p.country,
      email: p.email,
      email_status: p.email_status,
      organization: p.organization
        ? {
            id: p.organization.id,
            name: p.organization.name,
            website_url: p.organization.website_url,
            primary_domain: p.organization.primary_domain,
          }
        : undefined,
    }));
    const total = data.pagination?.total_entries ?? data.total_entries ?? people.length;
    return { ok: true, total, people };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * Step 2 — enrich a single person to unlock email + verified phone.
 * Apollo charges credits per match; only call for the contacts we keep.
 */
export async function enrichPerson(opts: {
  apolloPersonId?: string;
  firstName?: string;
  lastName?: string;
  organizationName?: string;
  domain?: string;
  linkedinUrl?: string;
}): Promise<{ ok: true; person: ApolloPerson } | SearchError> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return { ok: false, error: "APOLLO_API_KEY missing" };

  // Apollo's match endpoint accepts several identifying fields; we pass everything we have.
  const body: Record<string, unknown> = {
    reveal_personal_emails: true,
  };
  if (opts.apolloPersonId) body.id = opts.apolloPersonId;
  if (opts.linkedinUrl) body.linkedin_url = opts.linkedinUrl;
  if (opts.firstName) body.first_name = opts.firstName;
  if (opts.lastName) body.last_name = opts.lastName;
  if (opts.organizationName) body.organization_name = opts.organizationName;
  if (opts.domain) body.domain = opts.domain;

  try {
    const r = await fetch(`${APOLLO_BASE}/people/match`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": key,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text();
      return { ok: false, error: `Apollo ${r.status}: ${text.slice(0, 200)}` };
    }
    const data = await r.json();
    const p = data.person ?? data.matches?.[0];
    if (!p) return { ok: false, error: "No match" };
    return {
      ok: true,
      person: {
        id: p.id,
        first_name: p.first_name,
        last_name: p.last_name,
        name: p.name,
        title: p.title,
        seniority: p.seniority,
        departments: p.departments,
        linkedin_url: p.linkedin_url,
        city: p.city,
        state: p.state,
        country: p.country,
        email: p.email,
        email_status: p.email_status,
        organization: p.organization
          ? {
              id: p.organization.id,
              name: p.organization.name,
              website_url: p.organization.website_url,
              primary_domain: p.organization.primary_domain,
            }
          : undefined,
      },
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function testApollo(): Promise<{ ok: boolean; error?: string; credits_used?: number }> {
  if (!process.env.APOLLO_API_KEY) return { ok: false, error: "APOLLO_API_KEY missing" };
  // Lightweight ping: search 1 person at a known domain.
  const r = await searchPeopleByCompany({ domain: "apollo.io", perPage: 1 });
  if (r.ok) return { ok: true };
  return { ok: false, error: r.error };
}
