/**
 * Phase 69 — Hunter fallback for the contact strategy step.
 *
 * Triggered only when Apollo mixed_people/search returned zero
 * candidates OR the top Apollo candidate scored below the 30-point
 * confidence floor. Reuses Phase 47's `hunterDomainPattern` (free-tier
 * friendly) for org context plus `hunterEmailFinder` to resolve emails
 * for any LLM-named candidate Apollo missed.
 *
 * Phase 63 flow preserved: Apollo first, Hunter only as fallback.
 */
import { hunterDomainPattern, hunterEmailFinder } from "./hunter";
import type {
  ApolloPerson,
  ContactStrategy,
  NamedCandidate,
} from "./strategy-types";

const HUNTER_BASE = "https://api.hunter.io/v2";

export interface HunterFallbackResult {
  candidates: ApolloPerson[];
  cost_usd: number;
  used: boolean;
}

function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function candidateFromNamed(
  named: NamedCandidate,
  email: string | null,
  domain: string,
): ApolloPerson {
  const { first, last } = splitName(named.name);
  return {
    id: `hunter:${named.name}`,
    first_name: first || null,
    last_name: last || null,
    name: named.name,
    title: named.title ?? null,
    linkedin_headline: null,
    linkedin_url: named.linkedin_url ?? null,
    seniority: null,
    department: null,
    email,
    email_status: email ? "unverified" : null,
    organization_id: null,
    organization_name: null,
    organization_domain: domain,
  };
}

/**
 * Run Hunter fallback. Looks up each LLM-named candidate via the
 * email-finder. Always cheap: at most 5 candidates × ~$0.04 per lookup.
 *
 * @param domain controlling-entity domain
 * @param strategy contact strategy (named candidates drive the fan-out)
 */
export async function runHunterFallback(
  domain: string | null,
  strategy: ContactStrategy,
): Promise<HunterFallbackResult> {
  const empty: HunterFallbackResult = { candidates: [], cost_usd: 0, used: false };
  if (!domain) return empty;

  let cost = 0;
  const out: ApolloPerson[] = [];

  // domain-search establishes pattern + organization confirmation. We
  // do not iterate the returned email list (Hunter's full list is too
  // noisy for our scoring); we use it only to confirm MX/pattern.
  try {
    await hunterDomainPattern(domain);
    cost += 0.04;
  } catch {
    /* ignore */
  }

  for (const named of strategy.named_candidates.slice(0, 5)) {
    const { first, last } = splitName(named.name);
    if (!first || !last) {
      out.push(candidateFromNamed(named, null, domain));
      continue;
    }
    try {
      const r = await hunterEmailFinder({
        domain,
        first_name: first,
        last_name: last,
      });
      cost += 0.07;
      out.push(candidateFromNamed(named, r.email ?? null, domain));
    } catch {
      out.push(candidateFromNamed(named, null, domain));
    }
  }

  return { candidates: out, cost_usd: cost, used: out.length > 0 };
}

/**
 * Phase 69 follow-up — Hunter domain-search merge path.
 *
 * When the LLM did not name any candidates AND Apollo returned an empty
 * list, we still have one cheap shot: pull Hunter's `/domain-search`
 * people list, filter by primary_titles (substring match), and merge
 * them into the ranking pool. This unblocks the "zero LLM names + zero
 * Apollo hits" tail without burning per-name email-finder credits.
 */
export interface DomainSearchPerson {
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  email: string | null;
  linkedin: string | null;
}

export async function hunterDomainSearchPeople(
  domain: string,
  fetchImpl?: typeof fetch,
): Promise<DomainSearchPerson[]> {
  if (!domain) return [];
  const key = process.env.HUNTER_API_KEY;
  if (!key) return [];
  const url = `${HUNTER_BASE}/domain-search?domain=${encodeURIComponent(
    domain,
  )}&limit=25&api_key=${encodeURIComponent(key)}`;
  const doFetch = fetchImpl ?? fetch;
  try {
    const resp = await doFetch(url, { method: "GET" });
    if (!resp.ok) return [];
    const json = (await resp.json().catch(() => ({}))) as {
      data?: {
        emails?: Array<{
          value?: string;
          first_name?: string;
          last_name?: string;
          position?: string;
          linkedin?: string;
        }>;
      };
    };
    const emails = Array.isArray(json?.data?.emails) ? json!.data!.emails! : [];
    return emails.map((e) => ({
      first_name: e.first_name ?? null,
      last_name: e.last_name ?? null,
      position: e.position ?? null,
      email: e.value ?? null,
      linkedin: e.linkedin ?? null,
    }));
  } catch {
    return [];
  }
}

function matchesPrimaryTitles(position: string | null, primary: string[]): boolean {
  if (!position) return false;
  const p = position.toLowerCase();
  for (const t of primary) {
    if (!t) continue;
    const needle = t.toLowerCase().trim();
    if (needle && p.includes(needle)) return true;
  }
  return false;
}

function personToCandidate(
  person: DomainSearchPerson,
  domain: string,
  index: number,
): ApolloPerson {
  const name =
    `${person.first_name ?? ""} ${person.last_name ?? ""}`.trim() || null;
  return {
    id: `hunter-domain:${domain}:${index}`,
    first_name: person.first_name,
    last_name: person.last_name,
    name,
    title: person.position,
    linkedin_headline: null,
    linkedin_url: person.linkedin,
    seniority: null,
    department: null,
    email: person.email,
    email_status: person.email ? "unverified" : null,
    organization_id: null,
    organization_name: null,
    organization_domain: domain,
  };
}

export interface DomainSearchMergeResult {
  candidates: ApolloPerson[];
  cost_usd: number;
}

/**
 * Run Hunter `/domain-search` and filter results down to people whose
 * `position` contains any primary title. Returns mapped `ApolloPerson`s
 * so they slot directly into the ranking pool.
 */
export async function runHunterDomainSearchMerge(
  domain: string | null,
  strategy: ContactStrategy,
  fetchImpl?: typeof fetch,
): Promise<DomainSearchMergeResult> {
  if (!domain) return { candidates: [], cost_usd: 0 };
  const people = await hunterDomainSearchPeople(domain, fetchImpl);
  const cost = 0.04; // domain-search same flat estimate
  const filtered = people.filter((p) =>
    matchesPrimaryTitles(p.position, strategy.primary_titles),
  );
  return {
    candidates: filtered.map((p, i) => personToCandidate(p, domain, i)),
    cost_usd: filtered.length > 0 ? cost : 0,
  };
}
