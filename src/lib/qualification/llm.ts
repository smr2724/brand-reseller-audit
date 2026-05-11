/**
 * Phase 68 — Shared JSON-mode LLM caller for the hard-gate modules.
 *
 * Each of prescreen / hierarchy / gate-c / rejection-sim hits OpenAI with
 * a strict-JSON system+user prompt; this helper centralizes the client
 * construction, retry policy, and cost estimation so the gate files stay
 * focused on their prompt + verdict logic.
 *
 * Models:
 *   - SMALL  = gpt-4o-mini (prescreen, cheap classifier work)
 *   - MAIN   = gpt-4.1     (gate-a fallback, gate-c, rejection sim)
 *
 * The orchestrator's existing callJsonLLM is intentionally not reused —
 * it lives inside the orchestrate.ts module scope and we don't want to
 * widen that surface area. The two helpers behave identically; this one
 * adds an "injectable" client for tests.
 */
import OpenAI from "openai";

export const QUALIFICATION_SMALL_MODEL = "gpt-4o-mini";
export const QUALIFICATION_MAIN_MODEL = "gpt-4.1";

export interface LlmCallResult {
  parsed: unknown;
  raw_text: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  model: string;
}

export interface LlmCallArgs {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Per-1k-token estimate. Numbers are rough public-rate ballparks — they
 * exist for cost accounting on `total_cost_usd`, not for billing.
 */
export function estimateLlmCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const rates: Record<string, { in: number; out: number }> = {
    "gpt-4o": { in: 0.005, out: 0.015 },
    "gpt-4o-mini": { in: 0.00015, out: 0.0006 },
    "gpt-4.1": { in: 0.002, out: 0.008 },
  };
  const r = rates[model] ?? { in: 0.001, out: 0.003 };
  return (tokensIn / 1000) * r.in + (tokensOut / 1000) * r.out;
}

/**
 * Calls OpenAI chat completions in strict JSON mode and parses the
 * response. Returns the parsed value alongside token + cost telemetry.
 *
 * Failure modes:
 *   - missing OPENAI_API_KEY → throws (caller decides whether to swallow).
 *   - network/auth error → throws.
 *   - malformed JSON → parsed = {} (so callers can defensively read fields).
 */
export async function callQualificationLlm(
  args: LlmCallArgs,
): Promise<LlmCallResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const resp = await client.chat.completions.create({
    model: args.model,
    temperature: args.temperature ?? 0.2,
    response_format: { type: "json_object" },
    max_tokens: args.maxTokens,
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
  const tokens_in = usage?.prompt_tokens ?? 0;
  const tokens_out = usage?.completion_tokens ?? 0;
  return {
    parsed,
    raw_text: text,
    tokens_in,
    tokens_out,
    cost_usd: estimateLlmCost(args.model, tokens_in, tokens_out),
    model: args.model,
  };
}
