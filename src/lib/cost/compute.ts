/**
 * Phase 81 — Pure cost computation from per-provider unit prices.
 */
import {
  APOLLO_COST_PER_REVEAL_CREDIT_USD,
  APOLLO_COST_PER_SEARCH_USD,
  CostProvider,
  HUNTER_COST_PER_CREDIT_USD,
  KEEPA_COST_PER_TOKEN_USD,
  MILLION_VERIFIER_COST_PER_VERIFY_USD,
  OPENAI_GPT4O_MINI_INPUT_USD_PER_TOKEN,
  OPENAI_GPT4O_MINI_OUTPUT_USD_PER_TOKEN,
  RESEND_COST_PER_SEND_USD,
} from "./constants";

export interface ComputeCostArgs {
  provider: CostProvider;
  operation: string;
  units?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Pure function — given a provider/operation + unit counts, return the
 * USD cost as a number rounded to 4 decimal places. Unknown providers
 * return 0 and warn (fail-soft per spec).
 */
export function computeCost(args: ComputeCostArgs): number {
  const { provider, operation } = args;
  const units = Number.isFinite(args.units) ? Number(args.units) : 0;
  const inputTokens = Number.isFinite(args.inputTokens) ? Number(args.inputTokens) : 0;
  const outputTokens = Number.isFinite(args.outputTokens) ? Number(args.outputTokens) : 0;

  let cost = 0;
  switch (provider) {
    case "keepa":
      // Phase 84 follow-up #3 — `/seller` and `/product` are billed in the
      // same Keepa token bucket ($0.0007/token). `keepa_seller_lookup`
      // charges 1 token per resolved seller_id (Keepa /seller endpoint).
      // `keepa_product` callers pre-multiply units by the offers token
      // multiplier (see KEEPA_OFFERS_TOKEN_MULTIPLIER), so the math stays
      // a single units × per-token rate at this layer.
      cost = units * KEEPA_COST_PER_TOKEN_USD;
      break;
    case "apollo":
      if (
        operation === "apollo_org_search" ||
        // Phase 83 — Bug #1 split the single cascade label into two so
        // api_costs shows which Apollo search step produced a hit. Both
        // use the same /mixed_people/api_search endpoint with the same
        // per-search price.
        operation === "apollo_people_match_org" ||
        operation === "apollo_people_match_domain"
      ) {
        cost = APOLLO_COST_PER_SEARCH_USD;
      } else if (operation === "apollo_people_match") {
        cost = units * APOLLO_COST_PER_REVEAL_CREDIT_USD;
      } else {
        console.warn(`[cost] unknown apollo operation ${operation}; falling back to 0`);
        cost = 0;
      }
      break;
    case "hunter":
      if (operation === "hunter_email_finder") {
        cost = units * HUNTER_COST_PER_CREDIT_USD;
      } else if (operation === "hunter_email_finder_miss") {
        cost = 0;
      } else {
        console.warn(`[cost] unknown hunter operation ${operation}; falling back to 0`);
        cost = 0;
      }
      break;
    case "million_verifier":
      cost = units * MILLION_VERIFIER_COST_PER_VERIFY_USD;
      break;
    case "openai":
      cost =
        inputTokens * OPENAI_GPT4O_MINI_INPUT_USD_PER_TOKEN +
        outputTokens * OPENAI_GPT4O_MINI_OUTPUT_USD_PER_TOKEN;
      break;
    case "resend":
      cost = units * RESEND_COST_PER_SEND_USD;
      break;
    default:
      console.warn(`[cost] unknown provider ${provider}; falling back to 0`);
      cost = 0;
  }

  return Math.round(cost * 10_000) / 10_000;
}
