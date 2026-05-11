/**
 * Phase 69 — candidate ranking tests.
 *
 * Run directly:
 *   npx tsx src/lib/contacts/__tests__/ranking.test.ts
 *
 * Covers the spec scoring rules:
 *   - mid-tier CEO scored low
 *   - Director of Amazon scored high
 *   - "amazon" in headline boost
 *   - titles_to_avoid penalty
 *   - LLM-named candidate bonus
 */
import { scoreCandidate, rankCandidates } from "../ranking";
import type { ApolloPerson, ContactStrategy } from "../strategy-types";

let failures = 0;
let passes = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passes += 1;
  } else {
    failures += 1;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function person(over: Partial<ApolloPerson>): ApolloPerson {
  return {
    id: over.id ?? "p",
    first_name: null,
    last_name: null,
    name: null,
    title: null,
    linkedin_headline: null,
    linkedin_url: null,
    seniority: null,
    department: null,
    email: null,
    email_status: null,
    organization_id: null,
    organization_name: null,
    organization_domain: null,
    ...over,
  };
}

const midStrategy: ContactStrategy = {
  company_size_tier: "mid",
  primary_titles: ["Director of Amazon", "VP E-commerce", "Head of Marketplace"],
  secondary_titles: ["Senior Manager Amazon"],
  titles_to_avoid: ["CEO", "CMO", "CFO"],
  seniorities: ["director", "vp", "head"],
  departments: ["sales", "marketing"],
  profile_rationale: "test",
  named_candidates: [
    {
      name: "Sarah Chen",
      title: "Director of Amazon",
      linkedin_url: null,
      reason: "press",
      can_sign_50k: true,
      personal_stake: "comp_tied_to_channel",
    },
  ],
  outreach_order: ["Sarah Chen"],
  llm_verdict: "ready",
  llm_model: "test",
  tokens_in: 0,
  tokens_out: 0,
  cost_usd: 0,
};

// mid-tier CEO penalty
const ceo = person({
  id: "ceo",
  first_name: "Jane",
  last_name: "Doe",
  title: "CEO",
  seniority: "c_suite",
});
const ceoScore = scoreCandidate(ceo, midStrategy, { name: "Acme" });
check("mid-tier CEO scored low", ceoScore < 0, `ceoScore=${ceoScore}`);
// expected: -25 (titles_to_avoid) -20 (mid CEO penalty) = -45

// Director of Amazon scored high
const directorAmazon = person({
  id: "dir",
  first_name: "Sarah",
  last_name: "Chen",
  title: "Director of Amazon",
  seniority: "director",
  department: "sales",
});
const dirScore = scoreCandidate(directorAmazon, midStrategy, { name: "Acme" });
// expected: +30 primary +20 hot +15 seniority +10 dept +10 named = 85
check("Director of Amazon scored high", dirScore >= 70, `dirScore=${dirScore}`);

// "amazon" in headline boost
const headlineBoost = person({
  id: "hb",
  first_name: "Alex",
  last_name: "Smith",
  title: "Senior Manager",
  linkedin_headline: "Senior Manager driving Amazon growth",
});
const headlineScore = scoreCandidate(headlineBoost, midStrategy, { name: "Acme" });
check(
  "amazon-in-headline gets +10",
  headlineScore >= 10 && headlineScore < 30,
  `headlineScore=${headlineScore}`,
);

// titles_to_avoid penalty
const cfo = person({ id: "cfo", title: "CFO" });
const cfoScore = scoreCandidate(cfo, midStrategy, { name: "Acme" });
check("titles_to_avoid → -25", cfoScore === -25, `cfoScore=${cfoScore}`);

// rank order
const ranked = rankCandidates(
  [ceo, headlineBoost, directorAmazon, cfo],
  midStrategy,
  { name: "Acme" },
);
check("ranking puts Director first", ranked[0].candidate.id === "dir");
check("ranking puts CEO at the bottom", ranked[ranked.length - 1].candidate.id === "ceo");
check("rankCandidates returns up to 5", ranked.length <= 5);

console.log(`\nranking.test.ts: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
