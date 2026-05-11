/**
 * Phase 69 — Contact Strategy LLM step + verdict logic tests.
 *
 * Run directly:
 *   npx tsx src/lib/contacts/__tests__/strategy.test.ts
 *
 * Covers:
 *   - parseStrategyJson clamps bogus enums and falls back to the tier template
 *   - computeStrategyVerdict triggers on each NEEDS_HUMAN_REVIEW condition
 *     (0 candidates, all scores < 30, top stake='none', top can_sign_50k=false)
 *   - runContactStrategyLLM threads dependency-injected JSON correctly
 */
import {
  parseStrategyJson,
  computeStrategyVerdict,
  runContactStrategyLLM,
  type RunStrategyInput,
} from "../strategy";
import type { ContactStrategy, NamedCandidate } from "../strategy-types";

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

const baseInput: RunStrategyInput = {
  brand: { id: "b1", name: "Acme" },
  controllingEntity: { name: "Acme Holdings", domain: "acme.com" },
  tier: "mid",
  sizeSignals: {
    employees: 240,
    revenue_usd: 80_000_000,
    linkedin_count: 240,
    wikipedia_employees: null,
    apollo_employees: null,
    source: "linkedin",
  },
  recoverableRevenueUsd: 250_000,
  gateCPersonName: null,
  gateCPersonTitle: null,
};

// parse fallback
const fallback = parseStrategyJson(null, baseInput);
check(
  "null LLM output falls back to template + needs_human_review",
  fallback.llm_verdict === "needs_human_review" && fallback.primary_titles.length > 0,
);

const goodJson = {
  company_size_tier: "mid",
  ideal_contact_profile: {
    primary_titles: ["Director of Amazon"],
    secondary_titles: ["Senior Manager Amazon"],
    titles_to_avoid: ["CEO"],
    seniorities: ["director"],
    departments: ["sales"],
    rationale: "test",
  },
  named_candidates: [
    {
      name: "Sarah Chen",
      title: "Director of Amazon",
      reason: "press release",
      can_sign_50k: true,
      personal_stake: "comp_tied_to_channel",
    },
  ],
  outreach_order: ["Sarah Chen"],
  verdict: "ready",
};
const parsed = parseStrategyJson(goodJson, baseInput);
check("parsed company_size_tier", parsed.company_size_tier === "mid");
check("parsed verdict ready", parsed.llm_verdict === "ready");
check("parsed primary_titles", parsed.primary_titles[0] === "Director of Amazon");
check("parsed named_candidates", parsed.named_candidates.length === 1);

const bogusJson = {
  company_size_tier: "medium", // bogus
  ideal_contact_profile: {
    primary_titles: [],
    seniorities: ["unknown_seniority"],
    departments: ["unknown_dept"],
  },
  named_candidates: [],
  verdict: "maybe", // bogus
};
const bogusParsed = parseStrategyJson(bogusJson, baseInput);
check("bogus tier clamped to input.tier", bogusParsed.company_size_tier === "mid");
check("bogus verdict clamped to needs_human_review", bogusParsed.llm_verdict === "needs_human_review");
check(
  "empty primary_titles falls back to template",
  bogusParsed.primary_titles.length > 0,
);

// Verdict logic
const goodStrategy: ContactStrategy = {
  company_size_tier: "mid",
  primary_titles: ["Director of Amazon"],
  secondary_titles: [],
  titles_to_avoid: [],
  seniorities: ["director"],
  departments: ["sales"],
  profile_rationale: "",
  named_candidates: [
    {
      name: "Sarah Chen",
      title: "Director of Amazon",
      linkedin_url: null,
      reason: "",
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

const namedOk: NamedCandidate = goodStrategy.named_candidates[0];

// trigger: zero ranked → needs_human_review
const v1 = computeStrategyVerdict(goodStrategy, [], namedOk);
check("0 ranked → needs_human_review", v1.verdict === "needs_human_review");

// trigger: all scores < 30
const v2 = computeStrategyVerdict(goodStrategy, [25, 20], namedOk);
check("all scores < 30 → needs_human_review", v2.verdict === "needs_human_review");

// trigger: top stake none
const noStakeStrategy: ContactStrategy = {
  ...goodStrategy,
  named_candidates: [{ ...namedOk, personal_stake: "none" }],
};
const v3 = computeStrategyVerdict(noStakeStrategy, [80], {
  ...namedOk,
  personal_stake: "none",
});
check("top stake=none → needs_human_review", v3.verdict === "needs_human_review");

// trigger: top can_sign_50k=false
const v4 = computeStrategyVerdict(goodStrategy, [80], {
  ...namedOk,
  can_sign_50k: false,
});
check("top can_sign_50k=false → needs_human_review", v4.verdict === "needs_human_review");

// trigger: LLM named no one
const emptyNamed: ContactStrategy = { ...goodStrategy, named_candidates: [] };
const v5 = computeStrategyVerdict(emptyNamed, [80], null);
check("empty named_candidates → needs_human_review", v5.verdict === "needs_human_review");

// happy path
const v6 = computeStrategyVerdict(goodStrategy, [80], namedOk);
check("happy path → ready", v6.verdict === "ready");

// Run LLM step with injected stub
(async () => {
  const stub = async () => ({
    parsed: goodJson,
    tokens_in: 1000,
    tokens_out: 200,
  });
  const out = await runContactStrategyLLM(baseInput, { callJson: stub });
  check("runContactStrategyLLM threaded primary_titles", out.primary_titles[0] === "Director of Amazon");
  check("runContactStrategyLLM tracks tokens", out.tokens_in === 1000 && out.tokens_out === 200);
  check("runContactStrategyLLM tracks model", out.llm_model === "gpt-4.1");
  check("runContactStrategyLLM tracks cost", out.cost_usd > 0);
  console.log(`\nstrategy.test.ts: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
})().catch((e) => {
  console.error("test threw", e);
  process.exit(1);
});
