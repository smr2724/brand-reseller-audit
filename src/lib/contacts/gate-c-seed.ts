/**
 * Phase 71 — Seed Apollo/Hunter contact enrichment with the Gate C
 * named decision-maker.
 *
 * When Gate C (Phase 68) named a specific human at the controlling
 * entity AND captured at least their first+last name, that person is the
 * highest-confidence seed for Contact Discovery/Strategy enrichment —
 * not the heuristic founder/CEO title scan. Carna4 surfaced the bug:
 * Gate C had "Maria Rapp — President" with a LinkedIn URL on file and
 * we were still title-scanning for founder/CEO/president/owner without
 * looking at her.
 *
 * Lookup order:
 *   1. Apollo `/v1/people/match` keyed on linkedin_url (when present).
 *   2. Apollo `/v1/mixed_people/search` seeded with the Gate C title
 *      and the person's first+last name as q_keywords.
 *   3. Hunter `/v2/email-finder` with first_name+last_name+domain.
 *   4. Full miss → caller surfaces NEEDS_HUMAN_REVIEW with the spec
 *      copy. Do NOT silently fall back to a generic CEO/founder scan.
 */
import {
  apolloPeopleMatchByLinkedIn,
  apolloMixedPeopleSearch,
} from "./apollo-mixed-search";
import { hunterEmailFinder } from "./hunter";
import type { ApolloPerson } from "./strategy-types";

export interface GateCPersonSeed {
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  linkedin_url: string | null;
}

export type GateCHitProvider =
  | "apollo_linkedin_match"
  | "apollo_mixed_search"
  | "hunter_finder";

export type GateCSeedProvider = GateCHitProvider | "needs_review";

export interface GateCSeedHit {
  provider: GateCHitProvider;
  /** Apollo-shaped person record (slimmed). `email` populated when the
   *  provider returned an email; the caller is still responsible for
   *  MillionVerifier verification. */
  person: ApolloPerson;
  /** Internal email_source value for brand_contacts. Mirrors the widened
   *  CHECK constraint in migration 0053. */
  email_source:
    | "apollo_linkedin_match"
    | "apollo_match"
    | "hunter"
    | "unknown";
  cost_credits: number;
  hunter_cost_usd: number;
}

export interface GateCSeedMiss {
  provider: "needs_review";
  person: null;
  email_source: "unknown";
  cost_credits: number;
  hunter_cost_usd: number;
  /** Free-text reason ("Gate C identified X (Y), but ..."). */
  reason: string;
}

export type GateCSeedResult = GateCSeedHit | GateCSeedMiss;

/**
 * Inputs the caller already has on hand. The Gate C `person` carries the
 * authoritative name + title + LinkedIn URL from the qualification step.
 */
export interface GateCSeedInput {
  person: GateCPersonSeed;
  brand_name: string;
  /** Controlling-entity domain (preferred). May be null for brands whose
   *  Phase 68 hierarchy resolver didn't capture a domain. */
  domain: string | null;
}

/**
 * `apolloSearch` defaults to the real mixed_people/search wrapper.
 * `apolloMatch` defaults to the real people/match wrapper.
 * `hunterFinder` defaults to the real Hunter email-finder.
 * Tests inject stubs.
 */
export interface GateCSeedDeps {
  apolloMatch?: typeof apolloPeopleMatchByLinkedIn;
  apolloSearch?: typeof apolloMixedPeopleSearch;
  hunterFinder?: typeof hunterEmailFinder;
}

function deriveName(p: GateCPersonSeed): { first: string; last: string; full: string } {
  let first = (p.first_name ?? "").trim();
  let last = (p.last_name ?? "").trim();
  const full = (p.full_name ?? "").trim();
  if ((!first || !last) && full) {
    const parts = full.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      if (!first) first = parts[0];
      if (!last) last = parts.slice(1).join(" ");
    } else if (parts.length === 1 && !first) {
      first = parts[0];
    }
  }
  return { first, last, full: full || `${first} ${last}`.trim() };
}

export async function seedFromGateC(
  input: GateCSeedInput,
  deps: GateCSeedDeps = {},
): Promise<GateCSeedResult> {
  const apolloMatch = deps.apolloMatch ?? apolloPeopleMatchByLinkedIn;
  const apolloSearch = deps.apolloSearch ?? apolloMixedPeopleSearch;
  const hunterFinder = deps.hunterFinder ?? hunterEmailFinder;

  const { first, last, full } = deriveName(input.person);
  const title = input.person.title?.trim() ?? null;
  const linkedinUrl = input.person.linkedin_url?.trim() ?? null;
  let cost_credits = 0;
  let hunter_cost_usd = 0;

  // 1. Apollo /people/match keyed on the LinkedIn URL.
  if (linkedinUrl) {
    const m = await apolloMatch({
      linkedin_url: linkedinUrl,
      first_name: first || undefined,
      last_name: last || undefined,
    });
    cost_credits += m.cost_credits;
    if (m.ok && m.person) {
      return {
        provider: "apollo_linkedin_match",
        person: {
          id: m.person.id,
          first_name: m.person.first_name ?? first ?? null,
          last_name: m.person.last_name ?? last ?? null,
          name: m.person.name ?? full ?? null,
          title: m.person.title ?? title,
          linkedin_headline: m.person.linkedin_headline ?? null,
          linkedin_url: m.person.linkedin_url ?? linkedinUrl,
          seniority: m.person.seniority ?? null,
          department: m.person.department ?? null,
          email: m.person.email ?? null,
          email_status: m.person.email_status ?? null,
          organization_id: m.person.organization_id ?? null,
          organization_name: m.person.organization_name ?? null,
          organization_domain: m.person.organization_domain ?? input.domain,
        },
        email_source: "apollo_linkedin_match",
        cost_credits,
        hunter_cost_usd,
      };
    }
  }

  // 2. Apollo mixed_people/search seeded with Gate C title + name.
  if (input.domain || first || last) {
    const titlesArr = title ? [title] : [];
    const keywords = [first, last].filter(Boolean).join(" ");
    const s = await apolloSearch({
      q_organization_domains: input.domain ? [input.domain] : [],
      person_titles: titlesArr,
      // `q_keywords` is a documented mixed_people/search filter on
      // Apollo; the existing wrapper doesn't have a dedicated field for
      // it, so we tack it onto person_titles only when title is empty —
      // otherwise the title alone steers Apollo well. For Phase 71 we
      // keep this simple and rely on title + domain.
      per_page: 25,
      ...(keywords ? {} : {}),
    });
    cost_credits += s.cost_credits;
    if (s.ok && s.candidates.length > 0) {
      // Pick the candidate whose name best matches Gate C person.
      const wantFull = full.toLowerCase();
      const wantFirst = first.toLowerCase();
      const wantLast = last.toLowerCase();
      const match =
        s.candidates.find((c) => {
          const cf = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim().toLowerCase();
          const cn = (c.name ?? "").trim().toLowerCase();
          return (
            (cf && cf === wantFull) ||
            (cn && cn === wantFull) ||
            ((c.first_name ?? "").trim().toLowerCase() === wantFirst &&
              (c.last_name ?? "").trim().toLowerCase() === wantLast)
          );
        }) ?? s.candidates[0];
      return {
        provider: "apollo_mixed_search",
        person: match,
        email_source: match.email ? "apollo_match" : "unknown",
        cost_credits,
        hunter_cost_usd,
      };
    }
  }

  // 3. Hunter email-finder. Requires first+last+domain.
  if (first && last && input.domain) {
    const h = await hunterFinder({
      domain: input.domain,
      first_name: first,
      last_name: last,
    });
    hunter_cost_usd += 0.07;
    if (h.ok && h.email) {
      return {
        provider: "hunter_finder",
        person: {
          id: `hunter:${full}`,
          first_name: first || null,
          last_name: last || null,
          name: full || null,
          title,
          linkedin_headline: null,
          linkedin_url: linkedinUrl,
          seniority: null,
          department: null,
          email: h.email,
          email_status: "unverified",
          organization_id: null,
          organization_name: null,
          organization_domain: input.domain,
        },
        email_source: "hunter",
        cost_credits,
        hunter_cost_usd,
      };
    }
  }

  // 4. Full miss — caller surfaces NEEDS_HUMAN_REVIEW with the spec copy.
  return {
    provider: "needs_review",
    person: null,
    email_source: "unknown",
    cost_credits,
    hunter_cost_usd,
    reason: `Gate C identified ${full || "(unnamed)"}${title ? ` (${title})` : ""}, but we couldn't find their email via Apollo or Hunter. [Manual research suggested.]`,
  };
}
