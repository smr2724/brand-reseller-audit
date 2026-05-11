/**
 * Phase 63 — Ranking helper for Apollo people-search results.
 *
 * Ranking rules (lower = more senior, top of list):
 *   Rank 1: founder / ceo / president / owner
 *   Rank 2: C-suite — cco / coo / cmo / cro / cso / cto / cfo / chief
 *   Rank 3: VP / Head of (e.g. VP Sales, Head of Sales)
 *   Rank 4: Director-level
 *   Rank 5: anyone else (including missing title)
 *
 * Ties are broken by Apollo's own ordering (stable sort on the input
 * array index) so the top result from Apollo wins when seniority is
 * identical. Returns at most the top 5 candidates after ranking.
 *
 * The orchestrator marks the #1-ranked person as the `primary` contact.
 */
import type { ApolloPersonSlim, ApolloSearchResult } from "./apollo";

export interface RankedCandidate {
  person: ApolloPersonSlim;
  rank: 1 | 2 | 3 | 4 | 5;
  apollo_order: number;
}

// Order matters: each candidate is scored against patterns in order;
// the first match wins. "Chief Executive Officer" must match rank-1
// "ceo" or "founder/president/owner" before rank-2's "\bchief\s+\w+\b"
// catches it, so rank-1 patterns appear first.
const RANK_PATTERNS: Array<{ rank: 1 | 2 | 3 | 4 | 5; matcher: RegExp }> = [
  { rank: 1, matcher: /\b(founder|co[- ]?founder|ceo|chief executive|president|owner)\b/i },
  { rank: 2, matcher: /\b(cco|coo|cmo|cro|cso|cto|cfo|chief\s+\w+)\b/i },
  {
    rank: 3,
    matcher:
      /\b(svp|evp|vp|vice\s+president|senior\s+vp|executive\s+vp|head\s+of)\b/i,
  },
  { rank: 4, matcher: /\bdirector\b/i },
];

function rankTitle(title: string | null | undefined): 1 | 2 | 3 | 4 | 5 {
  if (!title) return 5;
  for (const { rank, matcher } of RANK_PATTERNS) {
    if (matcher.test(title)) return rank;
  }
  return 5;
}

/**
 * Rank and take the top 5 candidates. Accepts the raw response from
 * `apolloSearchPeople`; if the response is not ok it returns an empty
 * list.
 */
export function rankCandidates(
  search: ApolloSearchResult | { people: ApolloPersonSlim[] },
): RankedCandidate[] {
  let people: ApolloPersonSlim[];
  if ("ok" in search) {
    if (!search.ok) return [];
    people = search.people;
  } else {
    people = search.people;
  }
  const ranked: RankedCandidate[] = people.map((person, apollo_order) => ({
    person,
    apollo_order,
    rank: rankTitle(person.title),
  }));
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.apollo_order - b.apollo_order;
  });
  return ranked.slice(0, 5);
}
