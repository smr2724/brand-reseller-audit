/**
 * Phase 34.6 — Trademark search via OpenAI web_search.
 *
 * USPTO's `tmsearch.uspto.gov/api/lookup/` endpoint that Phase 34.4 targeted
 * does not exist (returns S3 404 NoSuchKey). TESS retired in November 2023
 * and the replacement front-end is an Angular SPA on S3 with active anti-bot
 * protection — there is no public REST replacement for name-based trademark
 * search. `developer.uspto.gov`'s only trademark APIs are TSDR (serial-number
 * lookup, requires API key) and Trademark Assignment Search (XML bulk dump),
 * neither of which fits the resolver's "name → owner" path.
 *
 * Replacement: a *targeted* OpenAI Responses API call with the built-in
 * `web_search` tool, scoped to USPTO / Justia / TSDR sources, parsed into a
 * strict JSON schema (mark, owner, status, serial, registration date,
 * source URL). The result is the new "trademark evidence" the orchestrator
 * already understands — same shape as before, just sourced from a focused
 * web search instead of a dead REST endpoint.
 *
 * The legacy USPTO field names (`markIdentification`, `ownerInformation`,
 * `serialNumber`, `status`) are preserved on the per-mark `raw_payload`
 * objects we emit, so the evidence panel and any downstream extractor that
 * still reads them keeps working.
 *
 * Soft-fails: any OpenAI / parse / network error returns a structured
 * failure (empty candidates + error string) so the orchestrator keeps
 * web-search results. The error is also stamped onto `raw.search_error`
 * with the same shape Phase 34.4 used.
 *
 * Rate-limit: shares the `openai-web-search` bucket with the broader web
 * search adapter so a multi-brand recovery doesn't burn through quota.
 *
 * `parseTsdrInfo` and `pickLiveSerialsFromTmSearch` are retained so unit
 * tests / scripts that exercised the TSDR / TM-Search JSON shapes still
 * compile; production no longer calls them.
 */
import type { RawOwnerCandidate } from "./types";
import { rateLimit } from "./rate-limit";

export interface UsptoFetchOptions {
  /** Override the OpenAI API key — used by tests. */
  apiKey?: string;
  /** Override the global fetch implementation — used by tests. */
  fetchImpl?: typeof fetch;
  /** Skip retries on transient failures (used by tests). */
  skipRetries?: boolean;
  /** Skip the rate-limit / shared bucket (used by tests). */
  skipRateLimit?: boolean;
  /** Hard cap on candidates returned per search. */
  maxCandidates?: number;
  /** Override the model — used by tests. */
  model?: string;
  /** Per-attempt delay (ms) used by retry/backoff. */
  retryDelaysMs?: number[];
}

export interface UsptoSearchResult {
  query: string;
  candidates: RawOwnerCandidate[];
  raw: unknown;
  error: string | null;
  results_count: number;
}

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4.1";
const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_RETRY_DELAYS_MS = [500, 1500];

const LIVE_REGISTERED_STATUS_TOKENS: ReadonlyArray<string> = [
  "REGISTERED",
  "REGISTRATION",
  "RENEWED",
  "SECTION 8",
];
const DEAD_OR_PENDING_STATUS_TOKENS: ReadonlyArray<string> = [
  "DEAD",
  "ABANDON",
  "CANCEL",
  "EXPIRED",
  "PUBLISHED FOR OPPOSITION",
  "PUBLISHED",
  "ALLOWED",
  "INTENT TO USE",
  "PENDING",
];

/**
 * Returns true if the USPTO status text indicates a fully-registered LIVE
 * trademark. Pending / opposed / abandoned statuses return false.
 */
export function isLive(rawStatus: unknown, statusCode?: unknown): boolean {
  if (typeof statusCode === "number" && statusCode >= 700 && statusCode <= 749) {
    return true;
  }
  if (typeof rawStatus !== "string") return false;
  const upper = rawStatus.toUpperCase();
  for (const tok of DEAD_OR_PENDING_STATUS_TOKENS) {
    if (upper.includes(tok)) return false;
  }
  for (const tok of LIVE_REGISTERED_STATUS_TOKENS) {
    if (upper.includes(tok)) return true;
  }
  if (upper === "LIVE" || upper.startsWith("LIVE/")) return true;
  return false;
}

function isDeadStatus(rawStatus: unknown): boolean {
  if (typeof rawStatus !== "string") return false;
  const upper = rawStatus.toUpperCase();
  for (const tok of ["DEAD", "ABANDON", "CANCEL", "EXPIRED"]) {
    if (upper.includes(tok)) return true;
  }
  return false;
}

function pickString(obj: unknown, ...keys: string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function pickNumber(obj: unknown, ...keys: string[]): number | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  }
  return null;
}

function pickIsoDate(obj: unknown, ...keys: string[]): string | null {
  const s = pickString(obj, ...keys);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

/**
 * Phase 34.6 — Build the natural-language query the resolver fires at
 * OpenAI. Echoed back to the UI via `uspto_query`.
 */
export function buildTrademarkQuery(brandName: string): string {
  return (
    `Find USPTO trademark filings for the mark "${brandName}". ` +
    "Return the registered owner name, serial number, registration status (live/dead/abandoned), " +
    "and registration date. Prefer official sources: tsdr.uspto.gov, trademarks.justia.com, " +
    "tmsearch.uspto.gov. Skip dead/cancelled/abandoned marks unless none are live."
  );
}

interface ParsedMark {
  mark: string;
  owner: string;
  serial_number: string | null;
  status: string;
  registration_date: string | null;
  source_url: string;
}

interface ParsedSearch {
  marks: ParsedMark[];
  notes: string;
  sources: { url: string; title: string | null }[];
  full_text: string | null;
}

/**
 * Walk an OpenAI Responses API body. Returns the concatenated text of the
 * last `message` item plus any `url_citation` annotations harvested from
 * the same message blocks.
 */
function extractMessageTextAndSources(
  json: unknown,
): { text: string; sources: { url: string; title: string | null }[] } {
  const root =
    json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null;
  if (!root) return { text: "", sources: [] };
  const output = Array.isArray(root.output) ? (root.output as unknown[]) : [];
  const chunks: string[] = [];
  const seen = new Set<string>();
  const sources: { url: string; title: string | null }[] = [];
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
      const annotations = Array.isArray(b.annotations)
        ? (b.annotations as unknown[])
        : [];
      for (const ann of annotations) {
        if (!ann || typeof ann !== "object") continue;
        const a = ann as Record<string, unknown>;
        if (a.type !== "url_citation") continue;
        const url = typeof a.url === "string" ? (a.url as string) : null;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const title = typeof a.title === "string" ? (a.title as string) : null;
        sources.push({ url, title });
      }
    }
  }
  return { text: chunks.join("\n\n"), sources };
}

/**
 * Pull a `{ marks: [...], notes: "..." }` object out of the model's text.
 * Tolerant of fenced code blocks, leading prose, and stray whitespace.
 */
export function parseStrictMarksJson(
  text: string,
): { marks: ParsedMark[]; notes: string } | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  const slice = candidate.slice(firstBrace, lastBrace + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  const arr = Array.isArray(root.marks) ? (root.marks as unknown[]) : [];
  const notes =
    typeof root.notes === "string" ? (root.notes as string) : "";
  const marks: ParsedMark[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const mark = pickString(o, "mark", "markIdentification") ?? "";
    const owner =
      pickString(o, "owner", "ownerInformation", "owner_name", "company") ?? "";
    if (!mark && !owner) continue;
    const serial = pickString(o, "serial_number", "serialNumber", "serial");
    const status =
      pickString(o, "status", "registration_status", "trademark_status") ?? "";
    const regDate = pickIsoDate(
      o,
      "registration_date",
      "registrationDate",
      "regDate",
    );
    const sourceUrl = pickString(o, "source_url", "url", "source") ?? "";
    marks.push({
      mark,
      owner,
      serial_number: serial,
      status,
      registration_date: regDate,
      source_url: sourceUrl,
    });
  }
  return { marks, notes };
}

/**
 * Phase 34.6 — Convert a list of strict `marks[]` entries into the
 * `RawOwnerCandidate` shape the resolver pipeline already understands.
 * Drops dead / abandoned / cancelled rows; requires a non-empty owner.
 */
export function buildCandidatesFromMarks(
  marks: ReadonlyArray<ParsedMark>,
  brandName: string,
  maxCandidates: number,
): RawOwnerCandidate[] {
  const out: RawOwnerCandidate[] = [];
  const seen = new Set<string>();
  const target = brandName.trim().toLowerCase();
  for (const m of marks) {
    if (!m.owner || !m.owner.trim()) continue;
    if (m.status && isDeadStatus(m.status)) continue;

    const serial = m.serial_number ?? null;
    const dedupeKey = `${m.owner.toLowerCase()}|${(serial ?? "").toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const tsdrUrl =
      serial && /^\d{6,}$/.test(serial.replace(/[^0-9]/g, ""))
        ? `https://tsdr.uspto.gov/#caseNumber=${encodeURIComponent(serial)}&caseType=DEFAULT&searchType=statusSearch`
        : null;
    const evidenceUrl = tsdrUrl ?? (m.source_url || null);

    const matchReason = serial
      ? `USPTO trademark owner of record (Serial ${serial})`
      : `USPTO trademark owner of record (mark="${m.mark || brandName}")`;

    const evidencePieces: string[] = [];
    evidencePieces.push(`REGISTERED TRADEMARK OWNER (USPTO): ${m.owner}`);
    if (m.mark) evidencePieces.push(`mark="${m.mark}"`);
    if (m.status) evidencePieces.push(`status=${m.status}`);
    if (m.registration_date) {
      evidencePieces.push(`registration_date=${m.registration_date}`);
    }
    if (m.source_url) evidencePieces.push(`source=${m.source_url}`);
    if (target && m.mark && m.mark.toLowerCase() === target) {
      evidencePieces.push("exact_mark_match=true");
    }

    out.push({
      candidate_company_name: m.owner.trim(),
      candidate_domain: null,
      candidate_source: "uspto",
      evidence_text: evidencePieces.join(" | "),
      evidence_url: evidenceUrl,
      match_reason: matchReason,
      trademark_serial_number: serial,
      trademark_status: m.status || null,
      trademark_registration_date: m.registration_date,
      trademark_owner_address: null,
      goods_services_text: null,
      // Preserve the legacy USPTO field names so downstream code that still
      // reads `markIdentification` / `ownerInformation` / `serialNumber` /
      // `status` keeps working without changes.
      raw_payload: {
        markIdentification: m.mark || null,
        ownerInformation: m.owner,
        serialNumber: serial,
        status: m.status || null,
        registrationDate: m.registration_date,
        source_url: m.source_url || null,
      },
    });
    if (out.length >= maxCandidates) break;
  }
  return out;
}

function isLiveLike(status: string | null | undefined): boolean {
  if (!status) return true;
  const upper = status.toUpperCase();
  for (const tok of ["DEAD", "ABANDON", "CANCEL", "EXPIRED"]) {
    if (upper.includes(tok)) return false;
  }
  return true;
}

interface AttemptOk {
  ok: true;
  json: unknown;
}
interface AttemptErr {
  ok: false;
  error: string;
}

const RETRY_STATUS_HINTS: ReadonlyArray<string> = [
  "429",
  "500",
  "502",
  "503",
  "504",
];

async function fetchOpenAIWithRetry(
  body: Record<string, unknown>,
  apiKey: string,
  fetchImpl: typeof fetch,
  retryDelaysMs: number[],
  skipRetries: boolean,
): Promise<AttemptOk | AttemptErr> {
  const attempts = skipRetries ? 1 : retryDelaysMs.length + 1;
  let lastError = "openai web-search failed";
  for (let i = 0; i < attempts; i += 1) {
    try {
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
      if (res.ok) {
        const json = (await res.json()) as unknown;
        return { ok: true, json };
      }
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        // ignore
      }
      lastError = `openai web-search ${res.status}${detail ? `: ${detail}` : ""}`;
      const isRetryable = RETRY_STATUS_HINTS.some((s) =>
        String(res.status).startsWith(s.charAt(0)) && lastError.includes(s),
      ) || res.status === 429 || res.status >= 500;
      if (!isRetryable) return { ok: false, error: lastError };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    const delay = retryDelaysMs[i];
    if (delay !== undefined && i < attempts - 1) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return { ok: false, error: lastError };
}

/**
 * Phase 34.6 — Search trademarks via OpenAI's `web_search` tool, scoped
 * to USPTO / Justia / TSDR sources. Returns RawOwnerCandidates compatible
 * with the rest of the resolver pipeline.
 */
export async function searchUsptoTrademarks(
  brandName: string,
  opts: UsptoFetchOptions = {},
): Promise<UsptoSearchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const model = opts.model ?? DEFAULT_MODEL;
  const retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const query = buildTrademarkQuery(brandName);
  const requestSummary = `trademark search for "${brandName}" via OpenAI web_search`;

  if (!apiKey) {
    return {
      query,
      candidates: [],
      raw: {
        method: "openai_web_search",
        request_summary: requestSummary,
        search_error: "missing OPENAI_API_KEY",
      },
      error: "missing OPENAI_API_KEY",
      results_count: 0,
    };
  }

  const promptInstructions =
    `${query}\n\n` +
    "Return ONLY a JSON object (no prose, no markdown fences) of the form:\n" +
    `{
  "marks": [
    {
      "mark": string,
      "owner": string,
      "serial_number": string | null,
      "status": "live" | "dead" | "abandoned" | "cancelled" | "registered" | "pending" | "unknown",
      "registration_date": string | null,
      "source_url": string
    }
  ],
  "notes": string
}` +
    "\n\nRules:\n" +
    "- Always include the JSON object even if marks is empty.\n" +
    '- registration_date must be ISO YYYY-MM-DD or null.\n' +
    '- source_url must be one of the URLs you cited.\n' +
    "- Skip dead / cancelled / abandoned marks unless none are live, then include them with their actual status.\n" +
    "- notes: one short sentence summarizing what you found.\n";

  const body: Record<string, unknown> = {
    model,
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    input: promptInstructions,
  };

  const doFetch = async (): Promise<UsptoSearchResult> => {
    const attempt = await fetchOpenAIWithRetry(
      body,
      apiKey,
      fetchImpl,
      retryDelaysMs,
      opts.skipRetries === true,
    );
    if (!attempt.ok) {
      return {
        query,
        candidates: [],
        raw: {
          method: "openai_web_search",
          request_summary: requestSummary,
          search_error: attempt.error,
        },
        error: attempt.error,
        results_count: 0,
      };
    }

    const { text, sources } = extractMessageTextAndSources(attempt.json);
    const parsed = parseStrictMarksJson(text);
    if (!parsed) {
      const note = "openai web-search returned no parseable JSON";
      return {
        query,
        candidates: [],
        raw: {
          method: "openai_web_search",
          request_summary: requestSummary,
          marks: [],
          notes: note,
          sources,
          full_text: text || null,
        },
        error: null,
        results_count: 0,
      };
    }

    const candidates = buildCandidatesFromMarks(
      parsed.marks,
      brandName,
      maxCandidates,
    );
    const liveCount = parsed.marks.filter((m) => isLiveLike(m.status)).length;

    return {
      query,
      candidates,
      raw: {
        method: "openai_web_search",
        request_summary: requestSummary,
        marks: parsed.marks,
        notes: parsed.notes,
        sources,
        full_text: text || null,
      },
      error: null,
      results_count: liveCount,
    };
  };

  if (opts.skipRateLimit) {
    return doFetch();
  }
  // Share the OpenAI bucket with the broader web-search adapter so the two
  // calls don't fight each other on a multi-brand recovery.
  return rateLimit(
    {
      key: "openai-web-search",
      maxConcurrent: 3,
      minIntervalMs: 200,
      maxWaitMs: 60_000,
    },
    doFetch,
  );
}

/**
 * Phase 34.1 — Legacy export kept so unit tests / scripts that still
 * exercise the TSDR JSON shape compile. Production no longer calls it.
 */
export function parseTsdrInfo(
  json: unknown,
  fallbackSerial?: string | null,
): RawOwnerCandidate | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;

  const tmArr = Array.isArray(root.trademarks) ? (root.trademarks as unknown[]) : [];
  const tm = (tmArr[0] && typeof tmArr[0] === "object" ? tmArr[0] : root) as Record<string, unknown>;

  const status = tm.status as Record<string, unknown> | undefined;
  const statusText =
    pickString(status, "status", "statusDescription", "currentStatus", "tm_status") ??
    pickString(tm, "status_text", "statusDescription") ??
    "";
  const statusCode = pickNumber(status, "statusCode");
  if (statusText || statusCode != null) {
    if (!isLive(statusText, statusCode)) return null;
  }

  const parties = tm.parties as Record<string, unknown> | undefined;
  const ownersArr = Array.isArray(parties?.owners) ? (parties!.owners as unknown[]) : [];
  const holdersArr = Array.isArray(parties?.holders) ? (parties!.holders as unknown[]) : [];
  const ownerObj =
    (ownersArr[0] && typeof ownersArr[0] === "object" ? ownersArr[0] : null) ??
    (holdersArr[0] && typeof holdersArr[0] === "object" ? holdersArr[0] : null) ??
    (tm.currentOwner && typeof tm.currentOwner === "object" ? tm.currentOwner : null);

  const ownerName =
    pickString(ownerObj, "partyName", "name", "ownerName", "partyname") ??
    pickString(tm, "current_owner_name", "owner_name", "owner");
  if (!ownerName) return null;

  const ownerEntityType =
    pickString(ownerObj, "legalEntityType", "entity_type", "entityType") ?? null;

  const ownerAddress = formatTsdrAddress(ownerObj) ??
    pickString(tm, "current_owner_address", "owner_address", "address");

  const markText =
    pickString(tm, "markVerbalElement", "mark_text", "wordmark", "mark") ??
    pickString(status, "markVerbalElement", "wordmark") ??
    "";

  const serial =
    pickString(tm, "serial_number", "serialNumber", "serial", "sn") ??
    pickString(status, "serialNumber", "serial_number") ??
    fallbackSerial ??
    null;
  if (!serial) return null;

  const registrationNumber =
    pickString(tm, "registration_number", "registrationNumber") ??
    pickString(status, "registrationNumber") ??
    null;

  const goodsServices =
    pickString(tm, "goods_services_text", "goodsServices", "description") ?? null;

  const registrationDate =
    pickIsoDate(tm, "registration_date", "registrationDate", "regDate") ??
    pickIsoDate(status, "registrationDate", "registration_date");

  const tsdrUrl = `https://tsdr.uspto.gov/#caseNumber=${encodeURIComponent(serial)}&caseType=DEFAULT&searchType=statusSearch`;

  const matchReason = registrationNumber
    ? `USPTO TSDR registered owner (Reg. ${registrationNumber}, Serial ${serial})`
    : `USPTO TSDR registered owner (Serial ${serial})`;

  const evidencePieces: string[] = [];
  evidencePieces.push(
    `REGISTERED TRADEMARK OWNER (USPTO TSDR): ${ownerName}`,
  );
  if (ownerEntityType) evidencePieces.push(`entity_type=${ownerEntityType}`);
  if (ownerAddress) evidencePieces.push(`address=${ownerAddress}`);
  if (registrationNumber) evidencePieces.push(`registration=${registrationNumber}`);
  if (markText) evidencePieces.push(`mark="${markText}"`);
  if (goodsServices) evidencePieces.push(`goods/services=${goodsServices.slice(0, 200)}`);

  return {
    candidate_company_name: ownerName,
    candidate_domain: null,
    candidate_source: "uspto",
    evidence_text: evidencePieces.join(" | "),
    evidence_url: tsdrUrl,
    match_reason: matchReason,
    trademark_serial_number: serial,
    trademark_status: statusText || "LIVE/REGISTRATION",
    trademark_registration_date: registrationDate,
    trademark_owner_address: ownerAddress,
    goods_services_text: goodsServices,
    raw_payload: json,
  };
}

function formatTsdrAddress(owner: unknown): string | null {
  if (!owner || typeof owner !== "object") return null;
  const o = owner as Record<string, unknown>;
  const flat = pickString(o, "address", "fullAddress");
  if (flat) return flat;
  const parts: string[] = [];
  for (const k of [
    "addressLine1",
    "addressLine2",
    "city",
    "geoCode",
    "geographicArea",
    "postcode",
    "country",
  ]) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) parts.push(v.trim());
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Phase 34.1 — Legacy export kept so callers / tests still importing
 * `pickLiveSerialsFromTmSearch` compile. Production no longer uses it.
 */
export function pickLiveSerialsFromTmSearch(
  json: unknown,
  brandName: string,
  maxSerials: number,
): { serials: string[]; total: number } {
  if (!json || typeof json !== "object") return { serials: [], total: 0 };
  const target = brandName.trim().toLowerCase();
  if (!target) return { serials: [], total: 0 };

  const root = json as Record<string, unknown>;
  let arr: unknown[] = [];
  for (const key of [
    "results",
    "trademarks",
    "items",
    "records",
    "data",
    "hits",
  ]) {
    const v = root[key];
    if (Array.isArray(v) && v.length > 0) {
      arr = v;
      break;
    }
  }
  if (arr.length === 0 && root.hits && typeof root.hits === "object") {
    const hitsArr = (root.hits as { hits?: unknown }).hits;
    if (Array.isArray(hitsArr)) arr = hitsArr;
  }

  const serials: string[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    let inner = item as Record<string, unknown>;
    if (inner._source && typeof inner._source === "object") {
      inner = inner._source as Record<string, unknown>;
    }
    const status =
      pickString(inner, "status", "statusDescription", "tm_status", "current_status") ?? "";
    const statusCode = pickNumber(inner, "status_code", "statusCode");
    if (!isLive(status, statusCode)) continue;

    const mark =
      pickString(inner, "markVerbalElement", "mark_text", "wordmark", "mark", "mark_identification") ?? "";
    if (mark.trim().toLowerCase() !== target) continue;

    const serial = pickString(inner, "serial_number", "serialNumber", "serial", "sn");
    if (!serial) continue;
    if (seen.has(serial)) continue;
    seen.add(serial);
    serials.push(serial);
    if (serials.length >= maxSerials) break;
  }
  return { serials, total: arr.length };
}
