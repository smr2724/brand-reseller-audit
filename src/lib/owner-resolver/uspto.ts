/**
 * Phase 33 — USPTO trademark adapter.
 *
 * USPTO TSDR has no public name-search endpoint, so we use the
 * `uspto.report` open mirror at
 *   https://uspto.report/api/v1/trademark/search?q=<brand>
 * which is free, JSON, no auth. We filter to LIVE registrations only and
 * return up to 10 candidates ranked by exact-then-partial mark match.
 *
 * Rate-limit: 1 request/sec, 60/min. Soft-fails: on any error we return a
 * structured failure result rather than throwing, so the orchestrator can
 * still keep candidates from the web-search adapter.
 */
import type { RawOwnerCandidate } from "./types";

export interface UsptoFetchOptions {
  /** Override the search base URL — used by tests. */
  searchBaseUrl?: string;
  /** Override the global fetch implementation — used by tests. */
  fetchImpl?: typeof fetch;
  /** Override the per-request delay (ms) used by the rate limiter. */
  rateLimitDelayMs?: number;
  /** Skip the rate-limit delay entirely (used by tests). */
  skipRateLimit?: boolean;
}

export interface UsptoSearchResult {
  query: string;
  candidates: RawOwnerCandidate[];
  raw: unknown;
  error: string | null;
  results_count: number;
}

const DEFAULT_BASE_URL = "https://uspto.report/api/v1/trademark/search";
const DEFAULT_RATE_LIMIT_DELAY_MS = 1000;
const MAX_CANDIDATES = 10;

const LIVE_STATUS_TOKENS = ["LIVE", "REGISTERED", "PUBLISHED"];

function isLive(rawStatus: unknown): boolean {
  if (typeof rawStatus !== "string") return false;
  const upper = rawStatus.toUpperCase();
  if (upper.includes("LIVE")) return true;
  if (upper.includes("DEAD")) return false;
  if (upper.includes("ABANDON")) return false;
  if (upper.includes("CANCEL")) return false;
  if (upper.includes("EXPIRED")) return false;
  return LIVE_STATUS_TOKENS.some((tok) => upper.includes(tok));
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

function pickIsoDate(obj: unknown, ...keys: string[]): string | null {
  const s = pickString(obj, ...keys);
  if (!s) return null;
  // Accept either YYYY-MM-DD or YYYYMMDD or ISO timestamps.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function relevanceScore(brandName: string, markText: string | null): number {
  if (!markText) return 0;
  const a = brandName.trim().toLowerCase();
  const b = markText.trim().toLowerCase();
  if (a === b) return 100;
  if (b.includes(a)) return 60;
  if (a.includes(b)) return 40;
  return 10;
}

/**
 * Parse a single result row from `uspto.report` into a RawOwnerCandidate.
 * Returns null if the record can't be coerced into a usable candidate
 * (missing mark text, missing owner name, or non-LIVE status).
 */
export function parseUsptoRecord(record: unknown): RawOwnerCandidate | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;

  // The uspto.report API surface is not documented; we accept the
  // common field names used by their mirror plus TSDR-style fallbacks.
  const status =
    pickString(r, "status", "status_text", "tm_status", "current_status") ?? "";
  if (!isLive(status)) return null;

  const ownerName = pickString(
    r,
    "current_owner_name",
    "owner_name",
    "owner",
    "current_owner",
  );
  if (!ownerName) return null;

  const markText = pickString(r, "mark_text", "mark", "wordmark", "tm_text");
  const serial = pickString(r, "serial_number", "serial", "sn");
  const ownerAddress = pickString(
    r,
    "current_owner_address",
    "owner_address",
    "address",
  );
  const goodsServices = pickString(
    r,
    "goods_services_text",
    "goods_services",
    "description",
  );
  const registrationDate = pickIsoDate(
    r,
    "registration_date",
    "reg_date",
    "registered_on",
  );

  return {
    candidate_company_name: ownerName,
    candidate_domain: null,
    candidate_source: "uspto",
    evidence_text:
      markText && goodsServices
        ? `Mark "${markText}" — ${goodsServices}`
        : markText
          ? `Mark "${markText}"`
          : goodsServices,
    evidence_url: serial
      ? `https://tsdr.uspto.gov/#caseNumber=${encodeURIComponent(
          serial,
        )}&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch`
      : null,
    match_reason: markText
      ? `USPTO LIVE registration for mark "${markText}"`
      : "USPTO LIVE registration",
    trademark_serial_number: serial,
    trademark_status: status || "LIVE",
    trademark_registration_date: registrationDate,
    trademark_owner_address: ownerAddress,
    goods_services_text: goodsServices,
    raw_payload: r,
  };
}

/**
 * Search the USPTO mirror for trademarks matching `brandName` and return
 * up to `MAX_CANDIDATES` LIVE registrations as RawOwnerCandidates.
 */
export async function searchUsptoTrademarks(
  brandName: string,
  opts: UsptoFetchOptions = {},
): Promise<UsptoSearchResult> {
  const baseUrl = opts.searchBaseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const delayMs = opts.rateLimitDelayMs ?? DEFAULT_RATE_LIMIT_DELAY_MS;
  const url = `${baseUrl}?q=${encodeURIComponent(brandName)}`;
  const query = url;

  if (!opts.skipRateLimit && delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  let raw: unknown = null;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    } as RequestInit);
  } catch (e) {
    return {
      query,
      candidates: [],
      raw: null,
      error: e instanceof Error ? e.message : String(e),
      results_count: 0,
    };
  }

  if (!res.ok) {
    // 404 = no matches; treat as empty rather than failure.
    if (res.status === 404) {
      return { query, candidates: [], raw: null, error: null, results_count: 0 };
    }
    return {
      query,
      candidates: [],
      raw: null,
      error: `uspto search ${res.status} ${res.statusText}`,
      results_count: 0,
    };
  }

  try {
    raw = await res.json();
  } catch (e) {
    return {
      query,
      candidates: [],
      raw: null,
      error: e instanceof Error ? e.message : String(e),
      results_count: 0,
    };
  }

  const records = extractRecords(raw);
  const live: RawOwnerCandidate[] = [];
  for (const rec of records) {
    const parsed = parseUsptoRecord(rec);
    if (parsed) live.push(parsed);
  }

  // Rank by relevance (exact mark match first), then keep top N.
  live.sort((a, b) => {
    const sa = relevanceScore(brandName, extractMarkText(a.raw_payload));
    const sb = relevanceScore(brandName, extractMarkText(b.raw_payload));
    return sb - sa;
  });

  return {
    query,
    candidates: live.slice(0, MAX_CANDIDATES),
    raw,
    error: null,
    results_count: records.length,
  };
}

function extractMarkText(payload: unknown): string | null {
  return pickString(payload, "mark_text", "mark", "wordmark", "tm_text");
}

function extractRecords(raw: unknown): unknown[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  // Try common envelope shapes.
  for (const key of ["results", "items", "data", "records", "trademarks"]) {
    const v = r[key];
    if (Array.isArray(v)) return v;
  }
  if (Array.isArray(raw)) return raw;
  return [];
}
