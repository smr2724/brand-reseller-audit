/**
 * Phase 81 — Single source of truth for per-API unit costs (USD).
 *
 * Update this file when pricing changes. Every constant has a comment
 * documenting the source / rationale. The values are intentionally
 * blended/rounded — the goal is "transparently approximate", not
 * accountant-grade billing.
 */

export type CostProvider =
  | "keepa"
  | "apollo"
  | "hunter"
  | "million_verifier"
  | "openai"
  | "resend";

// Keepa Pro plan: $50/mo ≈ 60 tokens/min ≈ ~70,000 tokens/mo blended.
// ~$0.0007/token. /product calls 1 token per ASIN (stats only).
export const KEEPA_COST_PER_TOKEN_USD = 0.0007;

// Phase 84 — `offers=20` roughly doubles the per-ASIN token cost on
// `/product` (Keepa docs: offers=20 ≈ 2×, offers=100 ≈ 6×). Without this
// multiplier, api_costs would understate the true cost of full-offers
// capture by ~50%. Bumped from the implicit 1× when stats-only.
export const KEEPA_OFFERS_TOKEN_MULTIPLIER = 2;

// Phase 84 follow-up #3 — Keepa `/seller` endpoint cost. 1 token per
// resolved seller_id lookup (Keepa docs). With full-offers capture now
// resolving 10–20× more sellers per brand than the old buy-box-only path,
// this is a real and growing cost surface that was previously untracked.
export const KEEPA_SELLER_LOOKUP_COST_PER_UNIT_USD = KEEPA_COST_PER_TOKEN_USD;

// Apollo: Search/filter is free per Apollo docs.
export const APOLLO_COST_PER_SEARCH_USD = 0.0;

// Apollo email-reveal credit: industry analysis says $0.03–$0.05/credit;
// pick the midpoint.
export const APOLLO_COST_PER_REVEAL_CREDIT_USD = 0.04;

// Hunter Growth plan: $104/mo ÷ 3000 credits ≈ $0.0347/credit.
// Charged only when an email is returned.
export const HUNTER_COST_PER_CREDIT_USD = 0.034;

// MillionVerifier: $389 / 1M verifications = $0.000389 ≈ $0.0004.
export const MILLION_VERIFIER_COST_PER_VERIFY_USD = 0.0004;

// OpenAI gpt-4o-mini public pricing: $0.15 / 1M input tokens, $0.60 / 1M output.
export const OPENAI_GPT4O_MINI_INPUT_USD_PER_TOKEN = 0.15 / 1_000_000;
export const OPENAI_GPT4O_MINI_OUTPUT_USD_PER_TOKEN = 0.6 / 1_000_000;

// Resend Pro: $20/mo + 50k emails = $0.0004/send blended.
export const RESEND_COST_PER_SEND_USD = 0.0004;

// NOTE: Microsoft Graph createDraft is not metered — covered by the
// user's Microsoft 365 license — so no constant or trackCost call.
// Per-brand outreach drafts use Graph (not Resend), which is why the
// per-brand Resend column is omitted from the email/UI breakdown.

/**
 * Human-readable cost basis lines for the email summary legend.
 * Kept in sync with constants above (manual — these are documentation
 * strings, not computed, since the user asked for transparent prose).
 */
export const COST_BASIS_LINES: string[] = [
  "Keepa product: $0.0007 / token (Phase 84: ~2× when offers=20)",
  "Keepa seller lookup: $0.0007 / token (1 token per seller_id; cached 30d)",
  "Apollo people match: $0.04 / credit (email reveal only)",
  "Hunter Email Finder: $0.034 / credit (charged only when email found)",
  "MillionVerifier: $0.0004 / verification",
  "OpenAI gpt-4o-mini: $0.15 / 1M input tokens, $0.60 / 1M output tokens",
  "Resend send: $0.0004 / email",
  "Resend cost reflects only the summary email below; per-brand outreach drafts are created in Outlook via Microsoft Graph at no API cost.",
];
