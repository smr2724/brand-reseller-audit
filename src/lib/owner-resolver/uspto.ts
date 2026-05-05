/**
 * Phase 34.1 / 34.4 — Official USPTO trademark adapter.
 *
 * Phase 34.4 — Replaces the Phase 34.1 POST against
 * `tmsearch.uspto.gov/api/search-database` (which now responds with
 * `405 Method Not Allowed`) with a **GET** against the public lookup
 * endpoint:
 *
 *   GET https://tmsearch.uspto.gov/api/lookup/
 *     ?searchText={URL-encoded mark}&searchType=mark&page=1&rows=20
 *
 * The lookup response embeds the registered-owner string (`ownerInformation`)
 * alongside the mark text and status, so we no longer need a second
 * TSDR round-trip per serial — one GET produces the full candidate set.
 *
 * Field mapping for each search hit:
 *   markIdentification    -> mark text
 *   ownerInformation      -> candidate_company_name
 *   status                -> trademark_status
 *   serialNumber          -> trademark_serial_number
 *   registrationNumber    -> registration number (optional)
 *   filingDate / regDate  -> registration date (optional)
 *
 * Hits with status containing DEAD / ABANDON / CANCEL / EXPIRED are
 * dropped — they aren't a useful signal of who currently owns a brand.
 *
 * Soft-fails: any HTTP / parse error returns a structured failure
 * (empty candidates + error string) so the orchestrator keeps
 * web-search results. The error message is the actual `status statusText`
 * when the request hit the wire — no more bare "405 Method Not Allowed"
 * when the real problem is "we hit the wrong URL".
 *
 * Rate-limit: 1 in-flight call per bucket, 1.1s minimum between starts —
 * uses the shared `rate-limit` module so a multi-brand recovery doesn't
 * blast USPTO from one Vercel egress IP.
 *
 * `parseTsdrInfo` is retained so legacy unit tests that exercise the
 * TSDR JSON shape still pass; production no longer calls it.
 */
import type { RawOwnerCandidate } from "./types";
import { rateLimit } from "./rate-limit";

export interface UsptoFetchOptions {
  /** Override the search URL — used by tests. */
  searchUrl?: string;
  /** Override the TSDR base URL — kept for the parseTsdrInfo helper. */
  tsdrBaseUrl?: string;
  /** Override the global fetch implementation — used by tests. */
  fetchImpl?: typeof fetch;
  /** Override the per-request delay (ms) used by the rate limiter. */
  rateLimitDelayMs?: number;
  /** Skip the rate-limit delay entirely (used by tests). */
  skipRateLimit?: boolean;
  /** Disable retry-with-backoff on transient failures (used by tests). */
  skipRetries?: boolean;
  /** Hard cap on candidates returned per search. */
  maxCandidates?: number;
}

export interface UsptoSearchResult {
  query: string;
  candidates: RawOwnerCandidate[];
  raw: unknown;
  error: string | null;
  results_count: number;
}

const TMSEARCH_URL = "https://tmsearch.uspto.gov/api/lookup/";
const TSDR_BASE_URL = "https://tsdr.uspto.gov/status";
const DEFAULT_RATE_LIMIT_DELAY_MS = 1100;
const DEFAULT_MAX_CANDIDATES = 5;
const RETRY_DELAYS_MS = [500, 1500];
const RETRY_STATUSES = new Set<number>([403, 429, 500, 502, 503, 504]);

const USER_AGENT =
  "Mozilla/5.0 (compatible; BrandResellerAudit/1.0; +https://brand-reseller-audit.vercel.app)";

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

/**
 * Returns true if the status string is dead / abandoned / cancelled / expired
 * — those filings are dropped before we emit a candidate. Anything else
 * (LIVE, REGISTERED, plus pending / unknown statuses) is allowed through;
 * the caller decides whether to keep pending filings as evidence.
 */
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
 * Phase 34.4 — Pull RawOwnerCandidates straight out of a
 * `tmsearch.uspto.gov/api/lookup/` response. Drops dead / abandoned /
 * cancelled filings and dedupes on (owner, serial). Returns at most
 * `maxCandidates` rows.
 */
export function parseLookupResults(
  json: unknown,
  brandName: string,
  maxCandidates: number,
): { candidates: RawOwnerCandidate[]; total: number } {
  if (!json || typeof json !== "object") return { candidates: [], total: 0 };
  const root = json as Record<string, unknown>;
  let arr: unknown[] = [];
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
    if (Array.isArray(v) && v.length > 0) {
      arr = v;
      break;
    }
  }
  if (arr.length === 0 && root.hits && typeof root.hits === "object") {
    const hitsArr = (root.hits as { hits?: unknown }).hits;
    if (Array.isArray(hitsArr)) arr = hitsArr;
  }

  const target = brandName.trim().toLowerCase();
  const candidates: RawOwnerCandidate[] = [];
  const seen = new Set<string>();

  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    let inner = item as Record<string, unknown>;
    if (inner._source && typeof inner._source === "object") {
      inner = inner._source as Record<string, unknown>;
    }

    // 34.4 field names per the lookup schema: markIdentification,
    // ownerInformation, status, serialNumber. Older / alt names are
    // accepted as fallbacks.
    const mark =
      pickString(
        inner,
        "markIdentification",
        "mark_identification",
        "markVerbalElement",
        "mark_text",
        "wordmark",
        "mark",
      ) ?? "";
    const status =
      pickString(
        inner,
        "status",
        "statusDescription",
        "tm_status",
        "current_status",
      ) ?? "";

    if (status && isDeadStatus(status)) continue;
    // We do NOT require `isLive` here — the lookup endpoint returns
    // pending filings too, and a brand-new application is still a
    // useful signal of who is claiming the mark. The dead-status check
    // is the only hard filter.

    const serial =
      pickString(
        inner,
        "serialNumber",
        "serial_number",
        "serial",
        "sn",
      );
    const ownerName = extractOwnerName(inner);
    if (!ownerName) continue;

    const dedupeKey = `${ownerName.toLowerCase()}|${(serial ?? "").toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const registrationNumber = pickString(
      inner,
      "registrationNumber",
      "registration_number",
    );
    const registrationDate =
      pickIsoDate(
        inner,
        "registrationDate",
        "registration_date",
        "regDate",
      ) ?? pickIsoDate(inner, "filingDate", "filing_date");
    const goodsServices = pickString(
      inner,
      "goodsServices",
      "goods_services_text",
      "description",
    );

    const tsdrUrl = serial
      ? `https://tsdr.uspto.gov/#caseNumber=${encodeURIComponent(serial)}&caseType=DEFAULT&searchType=statusSearch`
      : null;

    const matchReason = serial
      ? registrationNumber
        ? `USPTO trademark owner of record (Reg. ${registrationNumber}, Serial ${serial})`
        : `USPTO trademark owner of record (Serial ${serial})`
      : `USPTO trademark owner of record (mark="${mark}")`;

    const evidencePieces: string[] = [];
    evidencePieces.push(
      `REGISTERED TRADEMARK OWNER (USPTO): ${ownerName}`,
    );
    if (registrationNumber) evidencePieces.push(`registration=${registrationNumber}`);
    if (mark) evidencePieces.push(`mark="${mark}"`);
    if (status) evidencePieces.push(`status=${status}`);
    if (goodsServices) evidencePieces.push(`goods/services=${goodsServices.slice(0, 200)}`);
    if (target && mark && mark.toLowerCase() === target) {
      evidencePieces.push("exact_mark_match=true");
    }

    candidates.push({
      candidate_company_name: ownerName,
      candidate_domain: null,
      candidate_source: "uspto",
      evidence_text: evidencePieces.join(" | "),
      evidence_url: tsdrUrl,
      match_reason: matchReason,
      trademark_serial_number: serial,
      trademark_status: status || null,
      trademark_registration_date: registrationDate,
      trademark_owner_address: null,
      goods_services_text: goodsServices,
      raw_payload: inner,
    });
    if (candidates.length >= maxCandidates) break;
  }

  return { candidates, total: arr.length };
}

/**
 * `ownerInformation` in the lookup response is sometimes a string,
 * sometimes a structured object (`partyName`, `name`), sometimes an
 * array of those. We pull the first non-empty owner string we can find.
 */
function extractOwnerName(inner: Record<string, unknown>): string | null {
  const flat = pickString(inner, "ownerInformation", "owner_information", "owner", "current_owner_name", "ownerName");
  if (flat) return flat;

  const ownerObj = inner.ownerInformation;
  if (ownerObj && typeof ownerObj === "object" && !Array.isArray(ownerObj)) {
    const n = pickString(ownerObj, "partyName", "name", "ownerName");
    if (n) return n;
  }
  if (Array.isArray(ownerObj) && ownerObj.length > 0) {
    const first = ownerObj[0];
    if (typeof first === "string" && first.trim().length > 0) return first.trim();
    if (first && typeof first === "object") {
      const n = pickString(first, "partyName", "name", "ownerName");
      if (n) return n;
    }
  }

  // Some payloads put owners under `owners[0]` or `parties.owners[0]`.
  const ownersArr = Array.isArray(inner.owners) ? (inner.owners as unknown[]) : [];
  if (ownersArr.length > 0) {
    const first = ownersArr[0];
    if (typeof first === "string" && first.trim().length > 0) return first.trim();
    if (first && typeof first === "object") {
      const n = pickString(first, "partyName", "name", "ownerName");
      if (n) return n;
    }
  }
  const parties = inner.parties as Record<string, unknown> | undefined;
  if (parties && typeof parties === "object") {
    const partyOwners = Array.isArray(parties.owners) ? (parties.owners as unknown[]) : [];
    if (partyOwners.length > 0) {
      const first = partyOwners[0];
      if (typeof first === "string" && first.trim().length > 0) return first.trim();
      if (first && typeof first === "object") {
        const n = pickString(first, "partyName", "name", "ownerName");
        if (n) return n;
      }
    }
  }
  return null;
}

/**
 * Build a TSDR-derived RawOwnerCandidate from the trademark status JSON
 * returned by `https://tsdr.uspto.gov/status/sn{serial}/info.json`.
 *
 * Retained for tests that still exercise the TSDR shape; the production
 * search path now reads owner info directly from the lookup response.
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

interface FetchAttemptResult {
  res: Response | null;
  error: string | null;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  skipRetries: boolean,
): Promise<FetchAttemptResult> {
  const attempts = skipRetries ? 1 : RETRY_DELAYS_MS.length + 1;
  let res: Response | null = null;
  let lastError: string | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      res = null;
    }
    if (res && res.ok) return { res, error: null };
    if (res) {
      lastError = `${res.status} ${res.statusText}`;
      if (!RETRY_STATUSES.has(res.status)) return { res, error: lastError };
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return { res, error: lastError };
}

function buildLookupUrl(baseUrl: string, brandName: string): string {
  // Phase 34.4 — `tmsearch.uspto.gov/api/lookup/` accepts query params:
  //   searchText, searchType=mark, page, rows. Anything else is ignored.
  const sep = baseUrl.includes("?") ? "&" : "?";
  const params = [
    `searchText=${encodeURIComponent(brandName)}`,
    "searchType=mark",
    "page=1",
    "rows=20",
  ].join("&");
  return `${baseUrl}${sep}${params}`;
}

/**
 * Search USPTO trademarks for `brandName` and return RawOwnerCandidates
 * built directly from the lookup endpoint's response. Output is capped
 * at `maxCandidates` (default 5).
 */
export async function searchUsptoTrademarks(
  brandName: string,
  opts: UsptoFetchOptions = {},
): Promise<UsptoSearchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const delayMs = opts.rateLimitDelayMs ?? DEFAULT_RATE_LIMIT_DELAY_MS;
  const searchBase = opts.searchUrl ?? TMSEARCH_URL;
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const query = `tmsearch:${brandName}`;
  // Touch the optional override so the param is unused-warning-free.
  void opts.tsdrBaseUrl;
  void TSDR_BASE_URL;

  const doFetch = async (): Promise<UsptoSearchResult> => {
    const url = buildLookupUrl(searchBase, brandName);
    let searchJson: unknown = null;
    let searchError: string | null = null;
    try {
      const attempt = await fetchWithRetry(
        url,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
          },
          cache: "no-store",
        } as RequestInit,
        fetchImpl,
        opts.skipRetries === true,
      );
      if (attempt.res && attempt.res.ok) {
        try {
          searchJson = await attempt.res.json();
        } catch (e) {
          searchError = e instanceof Error ? e.message : String(e);
        }
      } else {
        searchError =
          attempt.error ??
          (attempt.res
            ? `${attempt.res.status} ${attempt.res.statusText}`
            : "uspto search failed");
      }
    } catch (e) {
      searchError = e instanceof Error ? e.message : String(e);
    }

    if (searchError && !searchJson) {
      return {
        query,
        candidates: [],
        raw: { search_error: searchError, request_url: url, request_method: "GET" },
        error: `uspto tmsearch lookup: ${searchError}`,
        results_count: 0,
      };
    }

    const { candidates, total } = parseLookupResults(
      searchJson,
      brandName,
      maxCandidates,
    );

    return {
      query,
      candidates,
      raw: {
        search: searchJson,
        request_url: url,
        request_method: "GET",
        total_search_hits: total,
        // Phase 34.4 — A successful empty result is not an error; the
        // orchestrator falls back to web-search candidates. Surface the
        // "no live marks found" message in the raw payload only so the
        // log entry is clearer than `search_error: 405 Method Not Allowed`.
        ...(candidates.length === 0
          ? { search_note: `no live marks found for query '${brandName}'` }
          : {}),
      },
      error: null,
      results_count: candidates.length,
    };
  };

  if (opts.skipRateLimit) {
    return doFetch();
  }

  return rateLimit(
    {
      key: "uspto",
      maxConcurrent: 1,
      minIntervalMs: Math.max(delayMs, 1100),
      maxWaitMs: 60_000,
    },
    async () => {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return doFetch();
    },
  );
}

/**
 * Phase 34.1 — Legacy export kept so callers still importing
 * `pickLiveSerialsFromTmSearch` compile. Returns up to `maxSerials`
 * LIVE serials whose mark text matches `brandName` exactly. The
 * production code path no longer uses this.
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
