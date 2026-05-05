/**
 * Phase 34.1 — Official USPTO trademark adapter.
 *
 * Replaces the prior `uspto.report` mirror (an unaffiliated scraper) with
 * direct calls to the official USPTO endpoints:
 *
 *   1. **Search by mark text** via the public USPTO trademark search backend
 *      `https://tmsearch.uspto.gov/api/search-database` (used by the
 *      `tmsearch.uspto.gov` UI). Returns serial + status + mark text +
 *      owner name list. We filter to LIVE registrations whose mark text
 *      matches the input brand exactly (case-insensitive) — anything looser
 *      produces too many false positives across unrelated industries.
 *
 *   2. **Authoritative owner lookup** via TSDR JSON by serial number:
 *      `https://tsdr.uspto.gov/status/sn{SERIAL}/info.json`. This returns
 *      the registered owner of record (name, entity type, address, country)
 *      — the legal source of truth on who currently owns the trademark.
 *
 * For each LIVE serial that matches the brand exactly, we hit TSDR once and
 * emit one RawOwnerCandidate. The orchestrator passes these to the extractor
 * tagged as authoritative ("REGISTERED TRADEMARK OWNER (USPTO TSDR): …")
 * so the model knows to lean on them when ranking candidates.
 *
 * Soft-fails: any HTTP / parse error returns a structured failure (empty
 * candidates + error string) so the orchestrator keeps web-search results.
 *
 * Rate-limit: 1 in-flight call per bucket (tmsearch / tsdr), 1.1s minimum
 * between starts — uses the shared `rate-limit` module so a multi-brand
 * recovery doesn't blast USPTO from one Vercel egress IP.
 */
import type { RawOwnerCandidate } from "./types";
import { rateLimit } from "./rate-limit";

export interface UsptoFetchOptions {
  /** Override the search URL — used by tests. */
  searchUrl?: string;
  /** Override the TSDR base URL — used by tests. */
  tsdrBaseUrl?: string;
  /** Override the global fetch implementation — used by tests. */
  fetchImpl?: typeof fetch;
  /** Override the per-request delay (ms) used by the rate limiter. */
  rateLimitDelayMs?: number;
  /** Skip the rate-limit delay entirely (used by tests). */
  skipRateLimit?: boolean;
  /** Disable retry-with-backoff on transient failures (used by tests). */
  skipRetries?: boolean;
  /** Hard cap on TSDR lookups per call. */
  maxSerials?: number;
}

export interface UsptoSearchResult {
  query: string;
  candidates: RawOwnerCandidate[];
  raw: unknown;
  error: string | null;
  results_count: number;
}

const TMSEARCH_URL = "https://tmsearch.uspto.gov/api/search-database";
const TSDR_BASE_URL = "https://tsdr.uspto.gov/status";
const DEFAULT_RATE_LIMIT_DELAY_MS = 1100;
const DEFAULT_MAX_SERIALS = 5;
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
  for (const tok of DEAD_OR_PENDING_STATUS_TOKENS) {
    if (upper.includes(tok)) return false;
  }
  for (const tok of LIVE_REGISTERED_STATUS_TOKENS) {
    if (upper.includes(tok)) return true;
  }
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

/**
 * Build a TSDR-derived RawOwnerCandidate from the trademark status JSON
 * returned by `https://tsdr.uspto.gov/status/sn{serial}/info.json`.
 *
 * The TSDR shape (simplified) wraps everything under `trademarks[0]` with
 * sub-objects for `status`, `parties`, `holders`/`owners`, etc. We accept a
 * few common variations defensively.
 */
export function parseTsdrInfo(
  json: unknown,
  fallbackSerial?: string | null,
): RawOwnerCandidate | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;

  // TSDR returns trademarks[0] for the canonical record. Some response
  // variants put the top-level keys at root directly.
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

  // Owner of record — TSDR puts it under parties.owners[0] or
  // holders[0]. Some shapes also expose `currentOwner` directly.
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
  // TSDR sometimes returns a flat `address` string, sometimes a structured
  // address object (`addressLine1`, `addressLine2`, `city`, `geoCode`,
  // `postcode`, `country`).
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
 * Extract serial numbers + their LIVE-or-not status from the
 * `tmsearch.uspto.gov` search-database response. Returns the LIVE serials
 * whose mark text matches `brandName` exactly (case-insensitive) — looser
 * matches are dropped because cross-industry false positives are common.
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
  // tmsearch sometimes nests under hits.hits like Elasticsearch.
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

/**
 * Search USPTO trademarks for `brandName` and return RawOwnerCandidates
 * built from TSDR registered-owner-of-record JSON for each matching LIVE
 * serial. Output is capped at `maxSerials` (default 5).
 */
export async function searchUsptoTrademarks(
  brandName: string,
  opts: UsptoFetchOptions = {},
): Promise<UsptoSearchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const delayMs = opts.rateLimitDelayMs ?? DEFAULT_RATE_LIMIT_DELAY_MS;
  const searchUrl = opts.searchUrl ?? TMSEARCH_URL;
  const tsdrBase = opts.tsdrBaseUrl ?? TSDR_BASE_URL;
  const maxSerials = opts.maxSerials ?? DEFAULT_MAX_SERIALS;
  const query = `tmsearch:${brandName}`;

  const doFetch = async (): Promise<UsptoSearchResult> => {
    // 1. Search for matching serials by mark text.
    let searchJson: unknown = null;
    let searchError: string | null = null;
    try {
      const searchAttempt = await fetchWithRetry(
        searchUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
          },
          body: JSON.stringify({
            // tmsearch.uspto.gov accepts a structured query; this is the
            // simplest "exact wordmark" form.
            searchText: brandName,
            mark: brandName,
            limit: 30,
          }),
          cache: "no-store",
        } as RequestInit,
        fetchImpl,
        opts.skipRetries === true,
      );
      if (searchAttempt.res && searchAttempt.res.ok) {
        try {
          searchJson = await searchAttempt.res.json();
        } catch (e) {
          searchError = e instanceof Error ? e.message : String(e);
        }
      } else {
        searchError =
          searchAttempt.error ??
          (searchAttempt.res
            ? `${searchAttempt.res.status} ${searchAttempt.res.statusText}`
            : "uspto search failed");
      }
    } catch (e) {
      searchError = e instanceof Error ? e.message : String(e);
    }

    if (searchError && !searchJson) {
      return {
        query,
        candidates: [],
        raw: { search_error: searchError },
        error: `uspto tmsearch: ${searchError}`,
        results_count: 0,
      };
    }

    const { serials, total } = pickLiveSerialsFromTmSearch(
      searchJson,
      brandName,
      maxSerials,
    );

    // 2. For each LIVE serial, fetch TSDR JSON and parse the registered
    // owner of record. Soft-fail per-serial.
    const tsdrPayloads: Array<{ serial: string; raw: unknown; error?: string }> = [];
    const candidates: RawOwnerCandidate[] = [];
    for (const serial of serials) {
      const tsdrUrl = `${tsdrBase}/sn${encodeURIComponent(serial)}/info.json`;
      const attempt = await fetchWithRetry(
        tsdrUrl,
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
      if (!attempt.res || !attempt.res.ok) {
        tsdrPayloads.push({
          serial,
          raw: null,
          error: attempt.error ?? "tsdr fetch failed",
        });
        continue;
      }
      let tsdrJson: unknown = null;
      try {
        tsdrJson = await attempt.res.json();
      } catch (e) {
        tsdrPayloads.push({
          serial,
          raw: null,
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      tsdrPayloads.push({ serial, raw: tsdrJson });
      const cand = parseTsdrInfo(tsdrJson, serial);
      if (cand) candidates.push(cand);
    }

    return {
      query,
      candidates,
      raw: { search: searchJson, tsdr: tsdrPayloads, total_search_hits: total },
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
