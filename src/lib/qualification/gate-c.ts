/**
 * Phase 68 — Gate C: named single decision-maker.
 *
 * One LLM call answering two questions:
 *   1. Name the specific human (first + last) at the controlling entity
 *      who would personally sign a $50K consulting engagement.
 *   2. Does that person personally feel the recoverable revenue impact
 *      through compensation, equity, exit value, or P&L responsibility?
 *
 * Verdict:
 *   - Named human + personal stake → pass.
 *   - Named human but no personal stake (salaried middle management) → fail.
 *   - No human nameable → fail.
 *
 * Both fail cases use pattern `no_named_decision_maker`. The widened
 * disqualification_pattern CHECK admits this value (migration 0050).
 */
import {
  callQualificationLlm,
  QUALIFICATION_MAIN_MODEL,
  type LlmCallResult,
} from "./llm";
import type { ControllingEntity } from "./hierarchy";

export type StakeType =
  | "personal_pl"
  | "personal_equity"
  | "exit_value"
  | "direct_compensation"
  | "no_stake"
  | "unknown";

export interface GateCPerson {
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  title: string | null;
  linkedin_url: string | null;
  evidence_sources: Array<{ type: string; url?: string | null; excerpt: string }>;
}

export interface GateCPersonalStake {
  stake_type: StakeType;
  rationale: string;
}

export interface GateCResult {
  passed: boolean;
  person: GateCPerson | null;
  personal_stake: GateCPersonalStake | null;
  /** Free-text trail of search paths tried (for the failure-mode UI). */
  search_trail: string[];
  pattern: string | null;
  reason: string;
  cost_usd: number;
}

export interface GateCInput {
  brand_name: string;
  controlling_entity: ControllingEntity;
  recoverable_revenue_usd: number;
}

export async function resolveNamedDecisionMaker(
  input: GateCInput,
): Promise<GateCResult> {
  const recoverable = Math.round(input.recoverable_revenue_usd);
  const recoverableLabel = `$${recoverable.toLocaleString("en-US")}`;

  const user = [
    `Brand: ${input.brand_name}`,
    `Controlling entity: ${input.controlling_entity.name}`,
    `Ownership type: ${input.controlling_entity.ownership_type}`,
    `Controlling entity revenue (USD): ${
      input.controlling_entity.revenue_usd != null
        ? `$${Math.round(input.controlling_entity.revenue_usd).toLocaleString("en-US")}`
        : "unknown"
    }`,
    `Recoverable revenue at stake: ${recoverableLabel}`,
    "",
    "QUESTION 1:",
    `  Name the specific person (first name + last name) at "${input.controlling_entity.name}" who would personally sign a $50,000 consulting engagement for the brand "${input.brand_name}".`,
    "  Cite at least one source: LinkedIn URL, company About/Team/Leadership page, press release, podcast/conference appearance, or trade publication.",
    "  If no specific person can be named from public information — meaning the answer would be a job title (e.g. 'Director of Private Label E-commerce') rather than a real human name — return null for the person and explain why no individual is identifiable.",
    "",
    "QUESTION 2:",
    `  If you named a person, would that specific person personally feel the recoverable revenue impact (${recoverableLabel}) through one of:`,
    "    - direct compensation (commission, bonus tied to channel P&L)",
    "    - personal equity / ownership stake",
    "    - business value at exit (if owner-operator preparing for sale)",
    "    - direct P&L responsibility where missed targets cost them their job",
    "  Explain your reasoning. If the recoverable amount is 'rounding error' relative to their personal financial picture, the gate fails.",
  ].join("\n");

  let llm: LlmCallResult;
  try {
    llm = await callQualificationLlm({
      model: QUALIFICATION_MAIN_MODEL,
      system: GATE_C_SYSTEM_PROMPT,
      user,
      maxTokens: 1200,
    });
  } catch (e) {
    return {
      passed: false,
      person: null,
      personal_stake: null,
      search_trail: [
        `LLM call failed: ${e instanceof Error ? e.message : String(e)}`,
      ],
      pattern: "no_named_decision_maker",
      reason: "Gate C LLM failed; surfaced as no-named-decision-maker for safety.",
      cost_usd: 0,
    };
  }

  const parsed = (llm.parsed ?? {}) as Partial<GateCJson>;
  const personRaw = parsed.person ?? null;
  const stakeRaw = parsed.personal_stake ?? null;
  const trail = Array.isArray(parsed.search_trail)
    ? parsed.search_trail.map((s) => String(s).slice(0, 300)).slice(0, 10)
    : [];

  const first = nonEmpty(personRaw?.first_name);
  const last = nonEmpty(personRaw?.last_name);
  const fullName =
    nonEmpty(personRaw?.full_name) ??
    (first && last ? `${first} ${last}` : first ?? last);

  const hasNamedHuman = !!(first && last) || !!fullName;
  const stakeType = clampStakeType(stakeRaw?.stake_type);
  const hasStake =
    stakeType === "personal_pl" ||
    stakeType === "personal_equity" ||
    stakeType === "exit_value" ||
    stakeType === "direct_compensation";

  const person: GateCPerson | null = hasNamedHuman
    ? {
        first_name: first,
        last_name: last,
        full_name: fullName ?? null,
        title: nonEmpty(personRaw?.title),
        linkedin_url: nonEmpty(personRaw?.linkedin_url),
        evidence_sources: Array.isArray(personRaw?.evidence_sources)
          ? personRaw!.evidence_sources!
              .filter((e) => e && typeof e === "object")
              .map((e) => ({
                type: String(e.type ?? "other"),
                url: e.url == null ? null : String(e.url),
                excerpt: String(e.excerpt ?? "").slice(0, 600),
              }))
              .slice(0, 5)
          : [],
      }
    : null;

  const personal_stake: GateCPersonalStake | null = stakeRaw
    ? {
        stake_type: stakeType,
        rationale: String(stakeRaw.rationale ?? "").slice(0, 800),
      }
    : null;

  const passed = hasNamedHuman && hasStake;
  const reason = !hasNamedHuman
    ? "No individual person identifiable — only job titles surfaced."
    : !hasStake
      ? `${fullName ?? "Named contact"} surfaced but no personal financial stake in recoverable revenue (salaried middle-management profile).`
      : `${fullName ?? "Named contact"} has clear ${stakeType.replace(/_/g, " ")} stake in the $${Math.round(input.recoverable_revenue_usd).toLocaleString("en-US")} recovery.`;

  return {
    passed,
    person,
    personal_stake,
    search_trail: trail,
    pattern: passed ? null : "no_named_decision_maker",
    reason,
    cost_usd: llm.cost_usd,
  };
}

interface GateCJson {
  person: {
    first_name?: string | null;
    last_name?: string | null;
    full_name?: string | null;
    title?: string | null;
    linkedin_url?: string | null;
    evidence_sources?: Array<{ type?: string; url?: string | null; excerpt?: string }>;
  } | null;
  personal_stake: {
    stake_type?: string | null;
    rationale?: string | null;
  } | null;
  search_trail?: string[];
}

function nonEmpty(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === "null") return null;
  return s;
}

const STAKE_VALUES = new Set<StakeType>([
  "personal_pl",
  "personal_equity",
  "exit_value",
  "direct_compensation",
  "no_stake",
  "unknown",
]);

function clampStakeType(v: unknown): StakeType {
  if (v == null) return "unknown";
  const s = String(v).toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (STAKE_VALUES.has(s as StakeType)) return s as StakeType;
  if (s === "equity" || s === "ownership") return "personal_equity";
  if (s === "pl" || s === "p&l" || s === "p_and_l") return "personal_pl";
  if (s === "exit" || s === "business_value") return "exit_value";
  if (s === "compensation" || s === "bonus" || s === "commission") {
    return "direct_compensation";
  }
  if (s === "none" || s === "no") return "no_stake";
  return "unknown";
}

const GATE_C_SYSTEM_PROMPT = `You are screening for whether a brand has a NAMED HUMAN BUYER with personal financial skin in recovering Amazon-reseller-leaked margin.

The user provides:
  - the brand name
  - the controlling entity (resolved by an earlier gate)
  - the recoverable revenue at stake

You will be asked two questions: (1) name the person, (2) characterize their personal stake.

Output STRICTLY this JSON schema (no markdown, no prose):

{
  "person": {
    "first_name": "<first or null>",
    "last_name": "<last or null>",
    "full_name": "<full or null>",
    "title": "<title or null>",
    "linkedin_url": "<url or null>",
    "evidence_sources": [
      { "type": "linkedin|about_page|press_release|podcast|trade_pub|other", "url": "<url>", "excerpt": "<short quote>" }
    ]
  } | null,
  "personal_stake": {
    "stake_type": "<one of: personal_pl | personal_equity | exit_value | direct_compensation | no_stake | unknown>",
    "rationale": "<one paragraph explaining their financial connection to the recoverable revenue>"
  } | null,
  "search_trail": [
    "<one-line description of each public source you checked (LinkedIn, About page, press releases, podcast appearances, trade pubs)>"
  ]
}

Rules:
  - Return person:null and stake_type:'no_stake' when you cannot name a specific human from public information.
  - Do NOT invent a name. Job titles alone (e.g. 'Director of Private Label E-commerce') are not acceptable.
  - personal_pl applies when the person owns the P&L and missed targets jeopardize their job.
  - personal_equity applies when the person owns shares of the controlling entity (co-founder, co-owner, family principal).
  - exit_value applies when the person is owner-operator preparing for a liquidity event.
  - direct_compensation applies when commission/bonus is directly tied to channel performance.
  - no_stake means salaried middle-management at a large org where the recoverable amount is rounding error to them personally.`;
