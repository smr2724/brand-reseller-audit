/**
 * Phase 69 — Confidence-weighted candidate ranking.
 *
 * Score formula from spec:
 *   +30  title contains a primary title keyword
 *   +20  hot signal (amazon|e-commerce|marketplace|digital) in title
 *   +10  hot signal in linkedin_headline
 *   +15  seniority matches strategy
 *   +10  department matches strategy
 *   -25  title contains a titles_to_avoid term
 *   -20  founder/CEO when tier is 'mid' (too senior; delegates)
 *   +10  candidate name matches an LLM-named candidate
 *
 * Sort descending, return top 5.
 */
import type {
  ApolloPerson,
  ContactStrategy,
  ScoredCandidate,
  CompanySizeTier,
} from "./strategy-types";

interface BrandLite {
  name?: string | null;
}

const HOT_SIGNAL_RE = /\b(amazon|e[- ]?commerce|marketplace|digital)\b/i;
const MID_SENIOR_RE = /\b(founder|chief executive|^ceo$|^ceo[\s.,]|^president[\s.,]?$)\b/i;

function titleIncludes(title: string | null, needle: string): boolean {
  if (!title) return false;
  return title.toLowerCase().includes(needle.toLowerCase());
}

export function scoreCandidate(
  c: ApolloPerson,
  strategy: ContactStrategy,
  _brand: BrandLite,
): number {
  let score = 0;
  const title = c.title ?? "";
  const headline = c.linkedin_headline ?? "";

  // +30 if title contains any primary title keyword
  for (const t of strategy.primary_titles) {
    if (titleIncludes(title, t)) {
      score += 30;
      break;
    }
  }

  // +20 hot signal in title; +10 hot signal in headline
  if (HOT_SIGNAL_RE.test(title)) score += 20;
  if (HOT_SIGNAL_RE.test(headline)) score += 10;

  // +15 seniority match
  if (c.seniority && strategy.seniorities.includes(c.seniority)) score += 15;

  // +10 department match
  if (c.department && strategy.departments.includes(c.department)) score += 10;

  // -25 if in titles_to_avoid
  for (const t of strategy.titles_to_avoid) {
    if (titleIncludes(title, t)) {
      score -= 25;
      break;
    }
  }

  // -20 founder/CEO penalty at mid tier
  if (strategy.company_size_tier === ("mid" as CompanySizeTier) && MID_SENIOR_RE.test(title)) {
    score -= 20;
  }

  // +10 if LLM specifically named this person
  const fullName = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim().toLowerCase();
  const apolloName = (c.name ?? "").trim().toLowerCase();
  const named = strategy.named_candidates.some((n) => {
    const ln = n.name.trim().toLowerCase();
    return ln && (ln === fullName || ln === apolloName);
  });
  if (named) score += 10;

  return score;
}

export function rankCandidates(
  candidates: ApolloPerson[],
  strategy: ContactStrategy,
  brand: BrandLite,
  limit = 5,
): ScoredCandidate[] {
  const seen = new Set<string>();
  const scored: ScoredCandidate[] = [];
  for (const c of candidates) {
    const dedupKey = c.id || `${c.first_name ?? ""}|${c.last_name ?? ""}|${c.title ?? ""}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    scored.push({ candidate: c, score: scoreCandidate(c, strategy, brand) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
