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
