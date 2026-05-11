/**
 * Phase 69 — Contact Strategy LLM step.
 *
 * Calls the LLM with the verbatim Phase 69 prompt to produce:
 *   - confirmed/refined company_size_tier
 *   - ideal contact profile (primary/secondary/avoid titles, seniorities, departments)
 *   - 2–5 specifically named candidates with rationale and personal_stake
 *   - outreach_order
 *   - verdict (ready | needs_human_review)
 *
 * Returns a structured `ContactStrategy`. The orchestrator owns Apollo
 * search + scoring + final persisted verdict (which may flip ready →
 * needs_human_review if Apollo/Hunter come back empty).
 *
 * Model: same gpt-4.1 main model used by qualification (Phase 56). The
 * spec budget is $0.40/brand.
 */
import OpenAI from "openai";
import type {
  CompanySizeTier,
  ContactStrategy,
  NamedCandidate,
  SizeSignals,
  StrategyVerdict,
  PersonalStake,
  ControllingEntityShape,
} from "./strategy-types";
import { applyTemplate } from "./strategy-templates";

const STRATEGY_MODEL = "gpt-4.1";
const STRATEGY_PRICE_PER_1K_IN = 0.005;  // gpt-4.1 input
const STRATEGY_PRICE_PER_1K_OUT = 0.015; // gpt-4.1 output

const ALLOWED_TIERS: ReadonlyArray<CompanySizeTier> = [
  "micro",
  "small",
  "mid",
  "enterprise",
];
const ALLOWED_STAKES: ReadonlyArray<PersonalStake> = [
  "equity_owner",
  "p_and_l_owner",
  "comp_tied_to_channel",
  "none",
];
const ALLOWED_SENIORITIES = new Set([
  "owner",
  "founder",
  "c_suite",
  "vp",
  "head",
  "director",
  "manager",
]);
const ALLOWED_DEPARTMENTS = new Set([
  "founder",
  "executive",
  "sales",
  "marketing",
  "operations",
  "finance",
  "engineering",
]);

export interface BrandForStrategy {
  id: string;
  name: string;
}

export interface RunStrategyInput {
  brand: BrandForStrategy;
  controllingEntity: ControllingEntityShape;
  tier: CompanySizeTier;
  sizeSignals: SizeSignals;
  recoverableRevenueUsd: number | null;
  gateCPersonName: string | null;
  gateCPersonTitle: string | null;
}

/**
 * Build the verbatim Phase 69 prompt. Keep this in sync with
 * `phase69_contact_strategy_spec.md` §"Contact Strategy LLM prompt".
 */
export function buildStrategyPrompt(input: RunStrategyInput): {
  system: string;
  user: string;
} {
  const employees = input.sizeSignals.employees ?? 0;
  const revenue = input.sizeSignals.revenue_usd ?? 0;
  const revenueShort = formatUsdShort(revenue);
  const recoverable = formatUsdShort(input.recoverableRevenueUsd ?? 0);

  const system = `You are helping select the right human at a company for an outbound consulting pitch. Return strict JSON only — no prose, no markdown fences.

JSON schema:
{
  "company_size_tier": "micro|small|mid|enterprise",
  "ideal_contact_profile": {
    "primary_titles": ["string", ...],          // 3-8
    "secondary_titles": ["string", ...],        // 2-5
    "titles_to_avoid": ["string", ...],
    "seniorities": ["owner"|"founder"|"c_suite"|"vp"|"head"|"director"|"manager", ...],
    "departments": ["founder"|"executive"|"sales"|"marketing"|"operations"|"finance"|"engineering", ...],
    "rationale": "string"
  },
  "named_candidates": [
    {
      "name": "First Last",
      "title": "string",
      "linkedin_url": "string | null",
      "reason": "string",
      "can_sign_50k": true | false,
      "personal_stake": "equity_owner|p_and_l_owner|comp_tied_to_channel|none"
    }
  ],                                            // 2-5
  "outreach_order": ["First Last", ...],
  "verdict": "ready" | "needs_human_review"
}

Rules:
- "ready" REQUIRES at least one named_candidate with can_sign_50k=true AND personal_stake != "none".
- If you cannot confidently identify a contact, return verdict "needs_human_review" with named_candidates possibly empty.`;

  const user = `The brand is "${input.brand.name}" controlled by "${input.controllingEntity.name ?? "unknown"}". The controlling entity has approximately ${employees} employees and $${revenueShort} annual revenue. The recoverable revenue we offer is $${recoverable}.

The brand passed hard qualification gates. The named decision-maker found at Gate C was "${input.gateCPersonName ?? "unknown"}" (${input.gateCPersonTitle ?? "unknown"}).

Step 1 — Confirm or refine the company size tier:
  one of [micro, small, mid, enterprise]

Step 2 — Produce the IDEAL CONTACT PROFILE for this specific company:
  - primary_titles: 3–8 titles
  - secondary_titles: 2–5 backup titles
  - titles_to_avoid: titles that are wrong (too senior, wrong function)
  - seniorities: Apollo seniority labels from [owner, founder, c_suite, vp, head, director, manager]
  - departments: Apollo departments from [founder, executive, sales, marketing, operations, finance, engineering]
  - rationale: 2–3 sentences explaining why these titles for THIS specific company structure

Step 3 — Name 2–5 SPECIFIC candidates from public information:
  For each, provide:
  - name (first + last)
  - title
  - linkedin_url if findable
  - reason: the specific signal (LinkedIn bio mention, conference talk, press release, etc.)
  - can_sign_50k: boolean (senior enough to sign $50K, not so senior they delegate)
  - personal_stake: one of [equity_owner, p_and_l_owner, comp_tied_to_channel, none]

Step 4 — Rank candidates in outreach_order (best first).

Step 5 — Final verdict:
  - "ready": at least one candidate with can_sign_50k=true and personal_stake≠"none"
  - "needs_human_review": cannot confidently identify a contact

Return strict JSON matching the provided schema.`;

  return { system, user };
}

function formatUsdShort(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}

interface CallOpenAIDeps {
  callJson?: (args: {
    model: string;
    system: string;
    user: string;
  }) => Promise<{ parsed: unknown; tokens_in: number; tokens_out: number }>;
}

async function defaultCallJson(args: {
  model: string;
  system: string;
  user: string;
}): Promise<{ parsed: unknown; tokens_in: number; tokens_out: number }> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const resp = await client.chat.completions.create({
    model: args.model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: args.system },
      { role: "user", content: args.user },
    ],
  });
  const text = resp.choices?.[0]?.message?.content ?? "{}";
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  const usage = resp.usage as
    | { prompt_tokens?: number; completion_tokens?: number }
    | undefined;
  return {
    parsed,
    tokens_in: usage?.prompt_tokens ?? 0,
    tokens_out: usage?.completion_tokens ?? 0,
  };
}

export async function runContactStrategyLLM(
  input: RunStrategyInput,
  deps?: CallOpenAIDeps,
): Promise<ContactStrategy> {
  const { system, user } = buildStrategyPrompt(input);
  const callJson = deps?.callJson ?? defaultCallJson;
  const llm = await callJson({ model: STRATEGY_MODEL, system, user });
  const parsed = parseStrategyJson(llm.parsed, input);

  const cost =
    (llm.tokens_in / 1000) * STRATEGY_PRICE_PER_1K_IN +
    (llm.tokens_out / 1000) * STRATEGY_PRICE_PER_1K_OUT;

  return {
    ...parsed,
    llm_model: STRATEGY_MODEL,
    tokens_in: llm.tokens_in,
    tokens_out: llm.tokens_out,
    cost_usd: Number.isFinite(cost) ? cost : 0,
  };
}

/**
 * Strict-ish JSON validation. We never throw — instead we fall back to
 * the tier template and mark verdict 'needs_human_review' so the
 * downstream UI can surface the issue.
 */
export function parseStrategyJson(
  raw: unknown,
  input: RunStrategyInput,
): Omit<ContactStrategy, "llm_model" | "tokens_in" | "tokens_out" | "cost_usd"> {
  const template = applyTemplate(input.tier, input.brand.name);
  const fallback: Omit<ContactStrategy, "llm_model" | "tokens_in" | "tokens_out" | "cost_usd"> = {
    company_size_tier: input.tier,
    primary_titles: template.primary_titles,
    secondary_titles: template.secondary_titles,
    titles_to_avoid: template.titles_to_avoid,
    seniorities: template.seniorities,
    departments: template.departments,
    profile_rationale: template.rationale_template,
    named_candidates: [],
    outreach_order: [],
    llm_verdict: "needs_human_review" as StrategyVerdict,
  };
  if (!raw || typeof raw !== "object") return fallback;
  const obj = raw as Record<string, unknown>;

  const tier = pickEnum(obj.company_size_tier, ALLOWED_TIERS, input.tier);

  const profile = (obj.ideal_contact_profile && typeof obj.ideal_contact_profile === "object"
    ? (obj.ideal_contact_profile as Record<string, unknown>)
    : {});
  const primary = stringArray(profile.primary_titles);
  const secondary = stringArray(profile.secondary_titles);
  const avoid = stringArray(profile.titles_to_avoid);
  const seniorities = stringArray(profile.seniorities).filter((s) => ALLOWED_SENIORITIES.has(s));
  const departments = stringArray(profile.departments).filter((d) => ALLOWED_DEPARTMENTS.has(d));
  const rationale = typeof profile.rationale === "string" ? profile.rationale : template.rationale_template;

  const named = parseNamedCandidates(obj.named_candidates);
  const outreach = stringArray(obj.outreach_order);

  const verdict: StrategyVerdict = obj.verdict === "ready" ? "ready" : "needs_human_review";

  // If LLM emits empty profile, fall back to template per spec.
  return {
    company_size_tier: tier,
    primary_titles: primary.length > 0 ? primary : template.primary_titles,
    secondary_titles: secondary.length > 0 ? secondary : template.secondary_titles,
    titles_to_avoid: avoid.length > 0 ? avoid : template.titles_to_avoid,
    seniorities: seniorities.length > 0 ? seniorities : template.seniorities,
    departments: departments.length > 0 ? departments : template.departments,
    profile_rationale: rationale,
    named_candidates: named,
    outreach_order: outreach,
    llm_verdict: verdict,
  };
}

function pickEnum<T extends string>(
  raw: unknown,
  allowed: ReadonlyArray<T>,
  fallback: T,
): T {
  if (typeof raw !== "string") return fallback;
  const v = raw.trim().toLowerCase() as T;
  return (allowed as ReadonlyArray<string>).includes(v) ? v : fallback;
}

function stringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0);
}

function parseNamedCandidates(raw: unknown): NamedCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: NamedCandidate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const name = typeof c.name === "string" ? c.name.trim() : "";
    if (!name) continue;
    out.push({
      name,
      title: typeof c.title === "string" ? c.title : null,
      linkedin_url: typeof c.linkedin_url === "string" ? c.linkedin_url : null,
      reason: typeof c.reason === "string" ? c.reason : "",
      can_sign_50k: c.can_sign_50k === true,
      personal_stake: pickEnum(c.personal_stake, ALLOWED_STAKES, "none"),
    });
  }
  return out;
}

/**
 * Compute the final orchestrator verdict per spec rules:
 *   needs_human_review when ANY:
 *     - LLM named_candidates empty
 *     - All Apollo scores < 30
 *     - Top candidate personal_stake='none' (LLM-named, if mapped)
 *     - Top candidate can_sign_50k=false
 *     - No candidates at all
 */
export function computeStrategyVerdict(
  strategy: ContactStrategy,
  rankedScores: number[],
  topNamedMatch: NamedCandidate | null,
): { verdict: StrategyVerdict; reason: string } {
  if (strategy.named_candidates.length === 0) {
    return {
      verdict: "needs_human_review",
      reason: "LLM step could not name any candidates from public signals.",
    };
  }
  if (rankedScores.length === 0) {
    return {
      verdict: "needs_human_review",
      reason: "Apollo/Hunter returned no candidates matching the strategy profile.",
    };
  }
  const topScore = rankedScores[0];
  if (topScore < 30) {
    return {
      verdict: "needs_human_review",
      reason: `Top candidate scored ${topScore} (below the 30-point confidence floor).`,
    };
  }
  if (topNamedMatch) {
    if (topNamedMatch.personal_stake === "none") {
      return {
        verdict: "needs_human_review",
        reason: "Top candidate has no personal stake (personal_stake='none').",
      };
    }
    if (!topNamedMatch.can_sign_50k) {
      return {
        verdict: "needs_human_review",
        reason: "Top candidate is not senior enough to sign $50K (can_sign_50k=false).",
      };
    }
  }
  return { verdict: "ready", reason: "Top candidate meets the readiness bar." };
}
