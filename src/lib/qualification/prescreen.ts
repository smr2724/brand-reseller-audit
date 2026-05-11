/**
 * Phase 68 — Pattern prescreen. The cheap first gate.
 *
 * Six known disqualification / needs-review patterns the LLM screens for
 * before we spend money on Gate A web-search and chain resolution:
 *
 *   1. public_company             — brand itself trades on a public market
 *   2. subsidiary_of_public       — brand is owned by a public parent
 *   3. pe_portfolio_large         — PE owner with > $500M AUM (needs_review)
 *   4. anti_amazon                — founder/brand has documented anti-Amazon stance
 *   5. dealer_network             — industries that REQUIRE authorized dealers
 *   6. holding_naming_signal_review — legal name contains Holdings/Group/etc.
 *
 * Only `pe_portfolio_large` and `holding_naming_signal_review` return
 * needs_review; the other four hard_disqualify. Short-circuits on the
 * first hit (caller decides whether to surface or to proceed).
 *
 * Budget: $0.05/brand on gpt-4o-mini.
 */
import {
  callQualificationLlm,
  QUALIFICATION_SMALL_MODEL,
  type LlmCallResult,
} from "./llm";

export type PrescreenPattern =
  | "public_company"
  | "subsidiary_of_public"
  | "pe_portfolio_large"
  | "dealer_network"
  | "anti_amazon"
  | "holding_naming_signal_review";

export type PrescreenVerdict = "hard_disqualify" | "needs_review";

export interface PrescreenEvidence {
  source: string;
  url?: string | null;
  excerpt: string;
}

export interface PrescreenHit {
  pattern: PrescreenPattern;
  verdict: PrescreenVerdict;
  reason: string;
  evidence: PrescreenEvidence[];
}

export interface PrescreenInput {
  brand_name: string;
  brand_description?: string | null;
  known_parent?: string | null;
  top_sellers?: string[];
  /** Free-text industry hints — e.g. "marine outboards" — fed in when
   *  available. The LLM uses these for the dealer_network check. */
  industry_hint?: string | null;
}

export interface PrescreenResult {
  hit: PrescreenHit | null;
  llm: LlmCallResult | null;
  /** Set when the prescreen LLM call itself failed; the orchestrator
   *  treats this as "no hit" but logs the error for visibility. */
  error: string | null;
}

const PATTERN_VERDICT: Record<PrescreenPattern, PrescreenVerdict> = {
  public_company: "hard_disqualify",
  subsidiary_of_public: "hard_disqualify",
  pe_portfolio_large: "needs_review",
  anti_amazon: "hard_disqualify",
  dealer_network: "hard_disqualify",
  holding_naming_signal_review: "needs_review",
};

const VALID_PATTERNS = new Set<PrescreenPattern>(
  Object.keys(PATTERN_VERDICT) as PrescreenPattern[],
);

const SYSTEM_PROMPT = `You are a hard-disqualification screener for an Amazon-reseller-recapture consulting firm.

Given a brand, decide whether the brand fits ONE of six well-known disqualification or needs-review patterns. Reply with a single JSON object describing the FIRST pattern that fires, or null when none fire.

Disqualification patterns (return verdict='hard_disqualify'):

  - public_company: the brand itself trades on a stock exchange (NYSE/NASDAQ/TSX/LSE etc).
  - subsidiary_of_public: the brand is owned by a publicly traded parent. Example: Realspace is owned by ODP Corporation (NASDAQ: ODP).
  - anti_amazon: the founder or brand has a documented, public anti-Amazon stance. Examples: "we don't sell on Amazon", "Amazon is bad for brands", "we pulled off Amazon". Documented in press, podcast, or interview.
  - dealer_network: the brand operates in an industry that REQUIRES authorized dealers and where Amazon resellers are by-design (marine outboards, agricultural equipment, automotive aftermarket, powersports, HVAC). Example: Can-Am by BRP.

Needs-review patterns (return verdict='needs_review'):

  - pe_portfolio_large: the brand is owned by a private-equity portfolio with > $500M AUM. PE shops vary in how much autonomy they give brand Presidents — escalate for human review.
  - holding_naming_signal_review: the brand's legal name contains 'Holding', 'Holdings', 'Group', or 'Inc.' AND there is evidence the entity is owned by another corporation. Triggers extra Gate A scrutiny but does not auto-fail.

Output schema (strict JSON, no markdown, no prose):
{
  "hit": null
}
or
{
  "hit": {
    "pattern": "<one of: public_company | subsidiary_of_public | pe_portfolio_large | dealer_network | anti_amazon | holding_naming_signal_review>",
    "reason": "<one short sentence justifying the call>",
    "evidence": [
      { "source": "<wikipedia | sec_edgar | trade_pub | brand_website | press_release | podcast | linkedin | other>", "url": "<url-or-null>", "excerpt": "<short quote or paraphrase>" }
    ]
  }
}

Rules:
  - If no pattern fires, return {"hit": null} — do NOT invent a pattern.
  - If evidence is weak or ambiguous, return {"hit": null}.
  - Do NOT include patterns that are not in the schema above.
  - Do NOT add extra keys.`;

export async function runPatternPrescreen(
  input: PrescreenInput,
): Promise<PrescreenResult> {
  const brandName = (input.brand_name ?? "").trim();
  if (!brandName) {
    return { hit: null, llm: null, error: "brand_name missing" };
  }

  const userParts: string[] = [`Brand: ${brandName}`];
  if (input.brand_description) {
    userParts.push(`Description: ${input.brand_description.trim()}`);
  }
  if (input.known_parent) {
    userParts.push(`Known/suspected parent: ${input.known_parent.trim()}`);
  }
  if (input.industry_hint) {
    userParts.push(`Industry hint: ${input.industry_hint.trim()}`);
  }
  if (input.top_sellers && input.top_sellers.length > 0) {
    userParts.push(
      `Top Amazon sellers: ${input.top_sellers.slice(0, 10).join(", ")}`,
    );
  }

  let llm: LlmCallResult;
  try {
    llm = await callQualificationLlm({
      model: QUALIFICATION_SMALL_MODEL,
      system: SYSTEM_PROMPT,
      user: userParts.join("\n"),
      maxTokens: 600,
    });
  } catch (e) {
    return {
      hit: null,
      llm: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const parsed = (llm.parsed ?? {}) as {
    hit?: {
      pattern?: string;
      reason?: string;
      evidence?: Array<{ source?: string; url?: string | null; excerpt?: string }>;
    } | null;
  };

  const rawHit = parsed?.hit;
  if (!rawHit || typeof rawHit !== "object") {
    return { hit: null, llm, error: null };
  }

  const pattern = String(rawHit.pattern ?? "").trim() as PrescreenPattern;
  if (!VALID_PATTERNS.has(pattern)) {
    return { hit: null, llm, error: null };
  }

  const evidence: PrescreenEvidence[] = Array.isArray(rawHit.evidence)
    ? rawHit.evidence
        .filter((e) => e && typeof e === "object")
        .map((e) => ({
          source: String(e.source ?? "other"),
          url: e.url == null ? null : String(e.url),
          excerpt: String(e.excerpt ?? "").slice(0, 600),
        }))
        .filter((e) => e.source || e.excerpt)
        .slice(0, 5)
    : [];

  const hit: PrescreenHit = {
    pattern,
    verdict: PATTERN_VERDICT[pattern],
    reason: String(rawHit.reason ?? "").slice(0, 400),
    evidence,
  };

  return { hit, llm, error: null };
}
