/**
 * Phase 33 — OpenAI web-search adapter.
 *
 * Uses OpenAI's Responses API with the built-in `web_search` tool to
 * harvest candidate owner companies. Endpoint:
 *   POST https://api.openai.com/v1/responses
 * Body:
 *   {
 *     "model": "gpt-4.1",
 *     "tools": [{ "type": "web_search" }],
 *     "tool_choice": "auto",
 *     "input": "<query>"
 *   }
 *
 * The Responses API returns an `output` array containing items of various
 * types. Web-search results land in `message` items as `output_text`
 * content blocks whose `annotations` array carries `url_citation` entries
 * pointing at the matched pages. We extract `(url, title, snippet)` tuples
 * from those annotations, falling back to harvesting URLs out of the model
 * text when annotations are absent.
 */
import type { ProviderResult, WebSearchResultItem } from "./web-search-types";
import { rateLimit } from "./rate-limit";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4.1";

export async function searchOpenAI(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  model: string = DEFAULT_MODEL,
): Promise<ProviderResult> {
  return rateLimit(
    { key: "openai-web-search", maxConcurrent: 3, minIntervalMs: 200, maxWaitMs: 60_000 },
    () => searchOpenAIImpl(query, apiKey, fetchImpl, model),
  );
}

async function searchOpenAIImpl(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  model: string,
): Promise<ProviderResult> {
  try {
    const res = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model,
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
        input: query,
      }),
      cache: "no-store",
    } as RequestInit);
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        // ignore
      }
      return {
        items: [],
        raw: null,
        error: `openai web-search ${res.status}${detail ? `: ${detail}` : ""}`,
      };
    }
    const json = (await res.json()) as unknown;
    const items = parseOpenAIResponse(json, query);
    return { items, raw: json, error: null };
  } catch (e) {
    return {
      items: [],
      raw: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Walk the OpenAI Responses API output array. Web-search results appear
 * as `url_citation` annotations attached to `output_text` content blocks
 * inside `message` items. We dedupe by URL and keep the first title /
 * snippet seen for each.
 */
export function parseOpenAIResponse(
  json: unknown,
  query: string,
): WebSearchResultItem[] {
  if (!json || typeof json !== "object") return [];
  const root = json as Record<string, unknown>;
  const output = Array.isArray(root.output) ? (root.output as unknown[]) : [];
  const seen = new Map<string, WebSearchResultItem>();
  const allText: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const type = typeof obj.type === "string" ? obj.type : "";
    if (type !== "message") continue;

    const content = Array.isArray(obj.content) ? (obj.content as unknown[]) : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      const text = typeof b.text === "string" ? (b.text as string) : null;
      if (text) allText.push(text);
      const annotations = Array.isArray(b.annotations)
        ? (b.annotations as unknown[])
        : [];
      for (const ann of annotations) {
        if (!ann || typeof ann !== "object") continue;
        const a = ann as Record<string, unknown>;
        const aType = typeof a.type === "string" ? a.type : "";
        if (aType !== "url_citation") continue;
        const url = typeof a.url === "string" ? (a.url as string) : null;
        if (!url) continue;
        const title = typeof a.title === "string" ? (a.title as string) : null;
        // Try to pull the cited slice of the model text as a snippet.
        const startIdx =
          typeof a.start_index === "number" ? (a.start_index as number) : null;
        const endIdx =
          typeof a.end_index === "number" ? (a.end_index as number) : null;
        let snippet: string | null = null;
        if (
          text &&
          startIdx !== null &&
          endIdx !== null &&
          endIdx > startIdx &&
          endIdx <= text.length
        ) {
          snippet = text.slice(startIdx, endIdx).trim() || null;
        }
        if (!seen.has(url)) {
          seen.set(url, { url, title, snippet, query });
        }
      }
    }
  }

  // Fallback: if no annotations were produced (some model variants emit
  // bare URLs in text), scrape http(s) URLs from the concatenated text so
  // we at least get domain-level candidates downstream.
  if (seen.size === 0 && allText.length > 0) {
    const joined = allText.join("\n");
    const re = /https?:\/\/[^\s<>"')\]]+/g;
    const matches = joined.match(re) ?? [];
    for (const raw of matches) {
      const cleaned = raw.replace(/[.,;:!?)\]]+$/, "");
      if (!seen.has(cleaned)) {
        seen.set(cleaned, { url: cleaned, title: null, snippet: null, query });
      }
    }
  }

  return Array.from(seen.values());
}
