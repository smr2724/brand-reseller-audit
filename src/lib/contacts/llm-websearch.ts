/**
 * Phase 73 — LLM web-search last-resort email discovery.
 *
 * Fires only after Apollo people/match + Apollo mixed_people/search +
 * Hunter email-finder + 8-pattern loop have all failed (or produced
 * only `invalid` / no MV signal). Uses OpenAI's Responses API with the
 * `web_search` tool to scan press releases, company About/Contact/
 * Press pages, interviews, podcasts, and trade publications for a
 * literally published email address.
 *
 * The prompt is VERBATIM per Phase 73 spec — do not paraphrase.
 *
 * Cost: ~$0.02 per call. Only fires on a full miss, so most brands
 * never invoke it. Net per-brand cost stays under the $3 target.
 */

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4.1";
const REQUEST_TIMEOUT_MS = 60_000;

export type LlmWebSearchConfidence = "high" | "medium" | "low" | "none";

export interface LlmWebSearchResult {
  email: string | null;
  source_url: string | null;
  confidence: LlmWebSearchConfidence;
  /** Free-text reason — populated on errors or when the model returned
   *  nothing parseable. Empty string on a successful structured reply. */
  error: string;
  raw_text: string | null;
}

export interface LlmWebSearchInput {
  full_name: string;
  brand_name: string;
}

export interface LlmWebSearchDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

function buildPrompt(input: LlmWebSearchInput): string {
  // VERBATIM per Phase 73 spec §4b. Do not edit this string.
  return `Find any public business email address for ${input.full_name} at ${input.brand_name}.

Search press releases, the company's website (especially /about, /contact, /press, /media), interviews, podcasts, LinkedIn posts, and trade publications. Look for emails published in public-facing copy — not data broker scrapes.

Return JSON: { "email": "...", "source_url": "...", "confidence": "high" | "medium" | "low" }

If you find no public email, return { "email": null, "source_url": null, "confidence": "none" }.

Do not guess or construct emails from patterns. Return only emails you can see literally published in source material you cite.`;
}

function extractMessageText(json: unknown): string {
  const root =
    json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null;
  if (!root) return "";
  const output = Array.isArray(root.output) ? (root.output as unknown[]) : [];
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (obj.type !== "message") continue;
    const content = Array.isArray(obj.content) ? (obj.content as unknown[]) : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      const text = typeof b.text === "string" ? (b.text as string) : null;
      if (text && text.length > 0) chunks.push(text);
    }
  }
  return chunks.join("\n\n");
}

function parseStructuredReply(text: string): {
  email: string | null;
  source_url: string | null;
  confidence: LlmWebSearchConfidence;
} | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const rawEmail =
    typeof o.email === "string" ? (o.email as string).trim() : null;
  const email = rawEmail && rawEmail.includes("@") ? rawEmail : null;
  const rawSource =
    typeof o.source_url === "string" ? (o.source_url as string).trim() : null;
  const source_url = rawSource && rawSource.length > 0 ? rawSource : null;
  const rawConf =
    typeof o.confidence === "string"
      ? (o.confidence as string).trim().toLowerCase()
      : "";
  const confidence: LlmWebSearchConfidence =
    rawConf === "high" || rawConf === "medium" || rawConf === "low"
      ? (rawConf as LlmWebSearchConfidence)
      : "none";
  return { email, source_url, confidence };
}

/**
 * Run the web-search call. Returns a `LlmWebSearchResult` with
 * `email=null` and a populated `error` field on every non-success
 * path (no API key, network failure, parse failure). The caller
 * always gets a structured result and decides whether to MV-verify.
 */
export async function llmWebSearchEmail(
  input: LlmWebSearchInput,
  deps: LlmWebSearchDeps = {},
): Promise<LlmWebSearchResult> {
  const apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    return {
      email: null,
      source_url: null,
      confidence: "none",
      error: "OPENAI_API_KEY not configured",
      raw_text: null,
    };
  }
  const doFetch = deps.fetchImpl ?? fetch;
  const model = deps.model ?? DEFAULT_MODEL;
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const body: Record<string, unknown> = {
    model,
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    input: buildPrompt(input),
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    } as RequestInit);
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      return {
        email: null,
        source_url: null,
        confidence: "none",
        error: `openai web-search HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
        raw_text: null,
      };
    }
    const json = (await res.json()) as unknown;
    const text = extractMessageText(json);
    const parsed = parseStructuredReply(text);
    if (!parsed) {
      return {
        email: null,
        source_url: null,
        confidence: "none",
        error: "openai web-search returned no parseable JSON",
        raw_text: text || null,
      };
    }
    return {
      email: parsed.email,
      source_url: parsed.source_url,
      confidence: parsed.confidence,
      error: "",
      raw_text: text || null,
    };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const msg = e instanceof Error ? e.message : String(e);
    return {
      email: null,
      source_url: null,
      confidence: "none",
      error: name === "AbortError" ? "openai web-search timeout" : msg,
      raw_text: null,
    };
  } finally {
    clearTimeout(t);
  }
}
