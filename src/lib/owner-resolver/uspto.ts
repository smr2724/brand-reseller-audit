/**
 * Phase 33 — USPTO trademark adapter.
 *
 * USPTO TSDR has no public name-search endpoint, so we use the
 * `uspto.report` open mirror at
 *   https://uspto.report/api/v1/trademark/search?q=<brand>
 * which is free, JSON, no auth. We filter to LIVE registrations only and
 * return up to 10 candidates ranked by exact-then-partial mark match.
 *
 * Rate-limit: 1 request/sec, 60/min — enforced cross-request via the
 * shared rate-limit module (B8).
 *
 * Soft-fails: on any error we return a structured failure result rather
 * than throwing, so the orchestrator can still keep candidates from the
 * web-search adapter.
 */
import type { RawOwnerCandidate } from "./types";
import { rateLimit } from "./rate-limit";

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

// M4 fix: strict allow-list of LIVE-equivalent USPTO statuses. "PUBLISHED
// FOR OPPOSITION" is an in-process application that the public can
// challenge — NOT a registered trademark. We only accept fully-issued
// registrations and renewals.
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
 *
 * Also accepts numeric `status_code` if supplied (USPTO TSDR codes 700-749
 * are LIVE registered).
 */
export function isLive(rawStatus: unknown, statusCode?: unknown): boolean {
  if (typeof statusCode === "number" && statusCode >= 700 && statusCode <= 749) {
    return true;
  }
  if (typeof rawStatus !== "string") return false;
  const upper = rawStatus.toUpperCase();
  // Reject if any dead/pending token is present (PUBLISHED FOR OPPOSITION
  // takes precedence over a bare "REGISTERED" mention in narrative status
  // text — though the tokens are mutually exclusive in practice, we check
  // the deny list first to be safe).
  for (const tok of DEAD_OR_PENDING_STATUS_TOKENS) {
    if (upper.includes(tok)) return false;
  }
  // Accept only if a strong LIVE-registered token is present.
  for (const tok of LIVE_REGISTERED_STATUS_TOKENS) {
    if (upper.includes(tok)) return true;
  }
  // Bare "LIVE" alone with no other context — accept (uspto.report often
  // returns "LIVE/REGISTRATION ISSUED" but trims to "LIVE" in some rows).
  if (upper === "LIVE" || upper.startsWith("LIVE/")) return true;
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
 * (M5: missing mark text, owner name, OR serial number → drop entirely).
 */
export function parseUsptoRecord(record: unknown): RawOwnerCandidate | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;

  const status =
    pickString(r, "status", "status_text", "tm_status", "current_status") ?? "";
  const statusCode = pickNumber(r, "status_code");
  if (!isLive(status, statusCode)) return null;

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
  // M5: drop records missing the core fields entirely so they never reach
  // scoring (where they'd otherwise still get +35 LIVE).
  if (!markText || !serial) return null;

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
      goodsServices
        ? `Mark "${markText}" — ${goodsServices}`
        : `Mark "${markText}"`,
    evidence_url: `https://tsdr.uspto.gov/#caseNumber=${encodeURIComponent(serial)}&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch`,
    match_reason: `USPTO LIVE registration for mark "${markText}"`,
    trademark_serial_number: serial,
    trademark_status: status || "LIVE",
    trademark_registration_date: registrationDate,
    trademark_owner_address: ownerAddress,
    goods_services_text: goodsServices,
    raw_payload: r,
  };
}

interface ScoredCandidate {
  cand: RawOwnerCandidate;
  rel: number;
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

  const doFetch = async (): Promise<UsptoSearchResult> => {
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
    // M6: pre-compute relevance once per record, then sort by the cached
    // value — avoids extracting mark text on every comparator call.
    const scored: ScoredCandidate[] = [];
    for (const rec of records) {
      const parsed = parseUsptoRecord(rec);
      if (parsed) {
        scored.push({
          cand: parsed,
          rel: relevanceScore(brandName, extractMarkText(parsed.raw_payload)),
        });
      }
    }
    scored.sort((a, b) => b.rel - a.rel);

    return {
      query,
      candidates: scored.slice(0, MAX_CANDIDATES).map((s) => s.cand),
      raw,
      error: null,
      results_count: records.length,
    };
  };

  if (opts.skipRateLimit) {
    return doFetch();
  }

  // B8: cross-request rate limit on top of the legacy per-request delay.
  // Allows only 1 in-flight USPTO call at a time and enforces a min
  // interval between starts so a 50-brand recovery doesn't fire 50
  // concurrent USPTO requests.
  return rateLimit(
    {
      key: "uspto",
      maxConcurrent: 1,
      minIntervalMs: Math.max(delayMs, 1100),
      maxWaitMs: 60_000,
    },
    async () => {
      // Preserve the original intra-request delay so tests (and operators)
      // can still tune it down to a small value via rateLimitDelayMs.
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return doFetch();
    },
  );
}

function extractMarkText(payload: unknown): string | null {
  return pickString(payload, "mark_text", "mark", "wordmark", "tm_text");
}

function extractRecords(raw: unknown): unknown[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  for (const key of ["results", "items", "data", "records", "trademarks"]) {
    const v = r[key];
    if (Array.isArray(v)) return v;
  }
  if (Array.isArray(raw)) return raw;
  return [];
}
