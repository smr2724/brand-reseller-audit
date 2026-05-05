/**
 * Phase 34.5 / 34.6 — Evidence transparency normalizer.
 *
 * Boils down a raw `owner_resolution_runs` row into a small, allowlisted
 * shape the brand-page evidence panel can render without ever seeing the
 * raw provider payloads. Never returns raw OpenAI / USPTO JSON.
 *
 * Payload shapes consumed:
 *
 * `raw_uspto_payload` — written by `src/lib/owner-resolver/uspto.ts`
 * (Phase 34.6, OpenAI web-search-based):
 *   - success:  { method: "openai_web_search", request_summary,
 *                 marks: [{ mark, owner, serial_number, status,
 *                 registration_date, source_url }],
 *                 notes, sources, full_text }
 *   - failure:  { method: "openai_web_search", request_summary,
 *                 search_error }
 *   For backwards compatibility we still read pre-34.6 payloads
 *   (`{ search: <usptoLookupJson>, ... }`) by falling back to the legacy
 *   `markIdentification / ownerInformation / serialNumber / status`
 *   field names.
 *
 * `raw_web_search_payload` — written by
 * `src/lib/owner-resolver/web-search.ts`:
 *   `{ [query: string]: <openaiResponsesJson> }` where each value is an
 *   OpenAI Responses API body. We extract `output[]` items of `type ===
 *   "message"` whose `content[]` blocks carry `text` + `annotations[]` of
 *   `type === "url_citation"`.
 */
import type { OwnerResolutionRunRow } from "./types";

const SNIPPET_MAX = 200;
const FULL_TEXT_MAX = 2000;
const MAX_MARKS = 5;
const MAX_SOURCES = 8;

export interface UsptoMarkSummary {
  serialNumber: string | null;
  mark: string | null;
  owner: string | null;
  status: string | null;
  // Phase 34.6 — direct citation URL for the mark (e.g. tsdr.uspto.gov,
  // trademarks.justia.com). `null` for legacy pre-34.6 payloads.
  sourceUrl: string | null;
}

export interface WebSearchSourceSummary {
  title: string | null;
  url: string;
  snippet: string | null;
}

export interface EvidenceSummary {
  uspto: {
    query: string | null;
    resultsCount: number;
    errored: boolean;
    errorMessage: string | null;
    // Phase 34.6 — `requestUrl` is now optional; the OpenAI web-search
    // method exposes a `requestSummary` and `notes` line instead.
    requestUrl: string | null;
    requestSummary: string | null;
    notes: string | null;
    marks: UsptoMarkSummary[];
  };
  webSearch: {
    queries: string[];
    resultsCount: number;
    errored: boolean;
    errorMessage: string | null;
    sources: WebSearchSourceSummary[];
    fullText: string | null;
    fullTextTruncated: boolean;
  };
}

type RunForEvidence = Pick<
  OwnerResolutionRunRow,
  | "uspto_query"
  | "uspto_results_count"
  | "raw_uspto_payload"
  | "web_search_queries"
  | "web_search_results_count"
  | "raw_web_search_payload"
> & { error_message?: string | null };

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function clampSnippet(s: string | null): string | null {
  if (!s) return null;
  const trimmed = s.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  if (trimmed.length <= SNIPPET_MAX) return trimmed;
  return trimmed.slice(0, SNIPPET_MAX - 1) + "…";
}

function pickFirstString(
  o: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const k of keys) {
    const s = asString(o[k]);
    if (s) return s;
  }
  return null;
}

/**
 * USPTO `ownerInformation` is sometimes a string, sometimes an object
 * (`partyName` / `name`), sometimes an array of those. Pull the first
 * non-empty owner name available without trusting deep shapes.
 */
function extractOwner(inner: Record<string, unknown>): string | null {
  const flat = pickFirstString(inner, [
    "ownerInformation",
    "owner_information",
    "owner",
    "current_owner_name",
    "ownerName",
  ]);
  if (flat) return flat;
  const candidates: unknown[] = [];
  const oi = inner.ownerInformation ?? inner.owner_information ?? inner.owners;
  if (Array.isArray(oi)) candidates.push(...oi);
  else if (oi) candidates.push(oi);
  for (const c of candidates) {
    const obj = asObject(c);
    if (!obj) continue;
    const name = pickFirstString(obj, [
      "partyName",
      "name",
      "ownerName",
      "current_owner_name",
    ]);
    if (name) return name;
  }
  return null;
}

function normalizeUspto(
  run: RunForEvidence,
): EvidenceSummary["uspto"] {
  const query = run.uspto_query ?? null;
  const resultsCount = run.uspto_results_count ?? 0;
  const payload = asObject(run.raw_uspto_payload);
  const requestUrl = payload ? asString(payload.request_url) : null;
  const requestSummary = payload ? asString(payload.request_summary) : null;
  const notes = payload ? asString(payload.notes) : null;
  const searchError = payload ? asString(payload.search_error) : null;
  const errored = Boolean(searchError);

  const marks: UsptoMarkSummary[] = [];
  if (!errored && payload) {
    // Phase 34.6 — preferred shape: marks[] at the top level, each row
    // already normalized into { mark, owner, serial_number, status,
    // registration_date, source_url }.
    const phase346Marks = Array.isArray(payload.marks)
      ? (payload.marks as unknown[])
      : null;
    if (phase346Marks && phase346Marks.length > 0) {
      for (const item of phase346Marks) {
        if (marks.length >= MAX_MARKS) break;
        const inner = asObject(item);
        if (!inner) continue;
        marks.push({
          serialNumber:
            pickFirstString(inner, ["serial_number", "serialNumber"]) ?? null,
          mark:
            pickFirstString(inner, [
              "mark",
              "markIdentification",
              "mark_identification",
            ]) ?? null,
          owner:
            pickFirstString(inner, ["owner", "ownerInformation"]) ??
            extractOwner(inner),
          status:
            pickFirstString(inner, [
              "status",
              "registration_status",
              "trademark_status",
            ]) ?? null,
          sourceUrl:
            pickFirstString(inner, ["source_url", "url", "source"]) ?? null,
        });
      }
    } else {
      // Pre-34.6 shape: { search: <usptoLookupJson>, ... }.
      const search = asObject(payload.search) ?? payload;
      const arr = findResultsArray(search);
      for (const item of arr) {
        if (marks.length >= MAX_MARKS) break;
        const inner = asObject(item);
        if (!inner) continue;
        const source = asObject(inner._source) ?? inner;
        marks.push({
          serialNumber: pickFirstString(source, [
            "serialNumber",
            "serial_number",
            "serial",
            "sn",
          ]),
          mark: pickFirstString(source, [
            "markIdentification",
            "mark_identification",
            "markVerbalElement",
            "mark_text",
            "wordmark",
            "mark",
          ]),
          owner: extractOwner(source),
          status: pickFirstString(source, [
            "status",
            "statusDescription",
            "tm_status",
            "current_status",
          ]),
          sourceUrl: null,
        });
      }
    }
  }

  return {
    query,
    resultsCount,
    errored,
    errorMessage: searchError,
    requestUrl,
    requestSummary,
    notes,
    marks,
  };
}

function findResultsArray(root: Record<string, unknown> | null): unknown[] {
  if (!root) return [];
  for (const key of [
    "results",
    "trademarks",
    "items",
    "records",
    "data",
    "hits",
    "docs",
  ]) {
    const v = root[key];
    if (Array.isArray(v) && v.length > 0) return v;
  }
  const hits = asObject(root.hits);
  if (hits) {
    const inner = hits.hits;
    if (Array.isArray(inner)) return inner;
  }
  return [];
}

/**
 * Walk an OpenAI Responses API body and harvest `(url, title, snippet)`
 * tuples from `url_citation` annotations. Mirrors the same parser the
 * resolver uses (see `web-search-openai.ts::parseOpenAIResponse`) but
 * trimmed for display.
 */
function harvestSources(
  json: unknown,
  out: WebSearchSourceSummary[],
  seen: Set<string>,
  fullTextChunks: string[],
): void {
  const root = asObject(json);
  if (!root) return;
  const output = Array.isArray(root.output) ? root.output : [];
  for (const item of output) {
    const obj = asObject(item);
    if (!obj) continue;
    if (obj.type !== "message") continue;
    const content = Array.isArray(obj.content) ? obj.content : [];
    for (const block of content) {
      const b = asObject(block);
      if (!b) continue;
      const text = asString(b.text);
      if (text) fullTextChunks.push(text);
      const annotations = Array.isArray(b.annotations) ? b.annotations : [];
      for (const ann of annotations) {
        const a = asObject(ann);
        if (!a) continue;
        if (a.type !== "url_citation") continue;
        const url = asString(a.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const title = asString(a.title);
        let snippet: string | null = null;
        const startIdx = typeof a.start_index === "number" ? a.start_index : null;
        const endIdx = typeof a.end_index === "number" ? a.end_index : null;
        if (
          text &&
          startIdx !== null &&
          endIdx !== null &&
          endIdx > startIdx &&
          endIdx <= text.length
        ) {
          const slice = text.slice(startIdx, endIdx).trim();
          if (slice) snippet = slice;
        }
        out.push({ title, url, snippet: clampSnippet(snippet) });
        if (out.length >= MAX_SOURCES) return;
      }
    }
  }
}

function normalizeWebSearch(
  run: RunForEvidence,
): EvidenceSummary["webSearch"] {
  const queries = Array.isArray(run.web_search_queries)
    ? run.web_search_queries.filter((q): q is string => typeof q === "string")
    : [];
  const resultsCount = run.web_search_results_count ?? 0;
  const payload = run.raw_web_search_payload;

  const sources: WebSearchSourceSummary[] = [];
  const seen = new Set<string>();
  const fullTextChunks: string[] = [];
  let errored = false;
  let errorMessage: string | null = null;

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    // The orchestrator stores payloads as `{ [query]: openaiJson }`. Walk
    // each value as an OpenAI Responses body.
    for (const value of Object.values(payload as Record<string, unknown>)) {
      if (sources.length >= MAX_SOURCES) break;
      harvestSources(value, sources, seen, fullTextChunks);
    }
    // Defensive fallback: if the payload itself was a single OpenAI
    // response body (not the orchestrator-shaped record), try parsing it
    // directly.
    if (sources.length === 0 && Array.isArray((payload as Record<string, unknown>).output)) {
      harvestSources(payload, sources, seen, fullTextChunks);
    }
  } else if (payload === null && resultsCount === 0) {
    // The safe wrappers null out `raw` when the provider threw — surface
    // that via the run-level error_message if present.
    if (run.error_message) {
      errored = true;
      errorMessage = run.error_message;
    }
  }

  const fullText = fullTextChunks.length > 0 ? fullTextChunks.join("\n\n") : null;
  const fullTextTruncated = Boolean(fullText && fullText.length > FULL_TEXT_MAX);
  const fullTextOut = fullText
    ? fullText.length > FULL_TEXT_MAX
      ? fullText.slice(0, FULL_TEXT_MAX) + "…"
      : fullText
    : null;

  return {
    queries,
    resultsCount,
    errored,
    errorMessage,
    sources,
    fullText: fullTextOut,
    fullTextTruncated,
  };
}

export function normalizeRunEvidence(run: RunForEvidence): EvidenceSummary {
  return {
    uspto: normalizeUspto(run),
    webSearch: normalizeWebSearch(run),
  };
}
