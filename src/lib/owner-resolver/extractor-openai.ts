/**
 * Phase 34 — Owner-name extractor (OpenAI Responses API, gpt-5-mini).
 *
 * Reads ALL raw hits (USPTO + web) for a brand and asks a reasoning model
 * to extract the canonical OWNING company entities. Page titles like
 * "About Us" or "Safety Data Sheet" are not company names; the model is
 * instructed to extract the underlying owner from URL + title + snippet.
 *
 * Output is parsed against a strict JSON shape; anything below
 * confidence 0.3 is dropped, and the top 3 (by confidence) are returned.
 */
import type { RawOwnerCandidate } from "./types";
import { rateLimit } from "./rate-limit";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5-mini";
const MIN_CONFIDENCE = 0.3;
const MAX_CANDIDATES = 3;

export interface ExtractedCandidate {
  canonical_company_name: string;
  domain: string | null;
  confidence: number;
  reasoning: string;
  evidence_urls: string[];
}

export interface ExtractorInputHit {
  source: string; // "uspto" | "web_search"
  title: string | null;
  snippet: string | null;
  url: string | null;
}

export interface ExtractorOptions {
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  model?: string;
}

export interface ExtractorResult {
  candidates: ExtractedCandidate[];
  raw: unknown;
  error: string | null;
}

const SYSTEM_PROMPT =
  `You are an expert at identifying the legal entity that owns a consumer brand. ` +
  `Given a brand name and a list of raw web/trademark search hits, extract the ` +
  `OWNING company entity (the legal entity that owns the brand or holds its trademark). ` +
  `\n\nRules:` +
  `\n- Page titles like "About Us", "Home", "Inicio", "Safety Data Sheet", "Contact" ` +
  `are NOT company names. Look at the domain and snippet to figure out who runs the page.` +
  `\n- Prefer canonical legal names that appear in trademark filings (USPTO, Justia), ` +
  `corporate "About Us" pages, or SDS/regulatory filings.` +
  `\n- Use the Inc./LLC/Ltd./Corp./S.A./GmbH suffix when the evidence shows it.` +
  `\n- Reject obvious resellers, distributors, marketplaces, and law firms.` +
  `\n- Reject duplicates (same legal entity with minor name variations — pick one canonical form).` +
  `\n- Domain is your best guess of the canonical website for that entity (omit if unsure).` +
  `\n- Confidence reflects how certain you are this is THE owner (not just a reseller or related entity).` +
  `\n- evidence_urls must be 1–5 URLs drawn from the input hits that support the extraction.` +
  `\n- Return at most 5 candidates; order by confidence DESC.`;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          canonical_company_name: { type: "string" },
          domain: { type: ["string", "null"] },
          confidence: { type: "number" },
          reasoning: { type: "string" },
          evidence_urls: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: [
          "canonical_company_name",
          "domain",
          "confidence",
          "reasoning",
          "evidence_urls",
        ],
      },
    },
  },
  required: ["candidates"],
} as const;

function buildUserPrompt(
  brandName: string,
  category: string | null,
  hits: ExtractorInputHit[],
): string {
  const lines: string[] = [];
  lines.push(`Brand name: ${brandName}`);
  if (category) lines.push(`Category: ${category}`);
  lines.push("");
  lines.push(`Raw hits (${hits.length}):`);
  for (let i = 0; i < hits.length; i += 1) {
    const h = hits[i]!;
    const title = (h.title ?? "").slice(0, 200);
    const snippet = (h.snippet ?? "").slice(0, 400);
    const url = h.url ?? "";
    lines.push(
      `[${i + 1}] (${h.source}) ${title}\n    ${url}\n    ${snippet}`,
    );
  }
  lines.push("");
  lines.push(
    "Extract the canonical owning company entities. Return strict JSON " +
      "matching the schema. If no hit clearly identifies the owner, return " +
      "an empty candidates array.",
  );
  return lines.join("\n");
}

/**
 * Build extractor input from RawOwnerCandidate arrays — convenience for the
 * orchestrator which already has the merged candidate list.
 */
export function buildExtractorHitsFromCandidates(
  candidates: ReadonlyArray<RawOwnerCandidate>,
): ExtractorInputHit[] {
  const hits: ExtractorInputHit[] = [];
  for (const c of candidates) {
    hits.push({
      source: c.candidate_source,
      title: c.candidate_company_name || null,
      snippet: c.evidence_text,
      url: c.evidence_url,
    });
  }
  return hits;
}

export async function extractOwnerCandidates(
  brandName: string,
  category: string | null,
  hits: ExtractorInputHit[],
  opts: ExtractorOptions = {},
): Promise<ExtractorResult> {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? null;
  if (!apiKey) {
    return {
      candidates: [],
      raw: null,
      error: "missing OPENAI_API_KEY",
    };
  }
  if (hits.length === 0) {
    return { candidates: [], raw: null, error: null };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model ?? DEFAULT_MODEL;

  return rateLimit(
    {
      key: "openai-extractor",
      maxConcurrent: 2,
      minIntervalMs: 200,
      maxWaitMs: 60_000,
    },
    () => extractImpl(brandName, category, hits, apiKey, fetchImpl, model),
  );
}

async function extractImpl(
  brandName: string,
  category: string | null,
  hits: ExtractorInputHit[],
  apiKey: string,
  fetchImpl: typeof fetch,
  model: string,
): Promise<ExtractorResult> {
  try {
    const body = {
      model,
      reasoning: { effort: "medium" },
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: SYSTEM_PROMPT }],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: buildUserPrompt(brandName, category, hits),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "owner_candidates",
          strict: true,
          schema: RESPONSE_SCHEMA,
        },
      },
    };

    const res = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    } as RequestInit);

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        // ignore
      }
      return {
        candidates: [],
        raw: null,
        error: `extractor ${res.status}${detail ? `: ${detail}` : ""}`,
      };
    }

    const json = (await res.json()) as unknown;
    const candidates = parseExtractorResponse(json);
    return { candidates, raw: json, error: null };
  } catch (e) {
    return {
      candidates: [],
      raw: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Walk the Responses API output to find the JSON payload, parse it, and
 * apply the confidence floor + top-K cap. Tolerant of variations in where
 * the JSON lands (output_text on a message, or output_parsed at root).
 */
export function parseExtractorResponse(json: unknown): ExtractedCandidate[] {
  const text = extractJsonText(json);
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const arr = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(arr)) return [];

  const out: ExtractedCandidate[] = [];
  const seenNames = new Set<string>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name =
      typeof o.canonical_company_name === "string"
        ? o.canonical_company_name.trim()
        : "";
    if (!name) continue;
    const conf = typeof o.confidence === "number" ? o.confidence : 0;
    if (conf < MIN_CONFIDENCE) continue;
    const key = name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);

    const domainRaw = typeof o.domain === "string" ? o.domain.trim() : "";
    const domain = domainRaw.length > 0 ? normalizeDomain(domainRaw) : null;
    const reasoning =
      typeof o.reasoning === "string" ? o.reasoning.trim() : "";
    const evidenceRaw = Array.isArray(o.evidence_urls)
      ? (o.evidence_urls as unknown[])
      : [];
    const evidence: string[] = [];
    for (const u of evidenceRaw) {
      if (typeof u === "string" && u.trim().length > 0) evidence.push(u.trim());
      if (evidence.length >= 5) break;
    }
    out.push({
      canonical_company_name: name,
      domain,
      confidence: Math.min(1, Math.max(0, conf)),
      reasoning,
      evidence_urls: evidence,
    });
  }
  out.sort((a, b) => b.confidence - a.confidence);
  return out.slice(0, MAX_CANDIDATES);
}

function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  try {
    if (/^https?:\/\//.test(s)) {
      s = new URL(s).hostname;
    }
  } catch {
    // not a URL — treat as host
  }
  s = s.replace(/^www\./, "").replace(/^m\./, "");
  if (!s || s.includes(" ")) return null;
  if (!s.includes(".")) return null;
  return s;
}

/**
 * Pull the JSON text from a Responses API payload. Modern responses put it
 * on `output[].content[].text` for message items; we also accept a top-level
 * `output_text` string (as the SDK sometimes synthesizes) for robustness.
 */
function extractJsonText(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;

  if (typeof root.output_text === "string" && root.output_text.length > 0) {
    return root.output_text;
  }

  const output = Array.isArray(root.output) ? (root.output as unknown[]) : [];
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
      if (text && text.trim().length > 0) return text;
    }
  }
  return null;
}
