/**
 * Phase 47 — Email verification (MillionVerifier primary + ZeroBounce
 * fallback). Closes the Carna4-style bounce class — the path where
 * Apollo / Hunter return an email but it deflects on send.
 *
 * Behavior is documented in the brief:
 *   1. Syntax-validate first (fast `invalid` reject).
 *   2. MillionVerifier `/api/v3/?email=…` is primary.
 *   3. On `catch_all` / `unknown` / provider error → ZeroBounce.
 *   4. Cache the domain-level signal (catch-all flag, MX provider) in
 *      `contact_domain_cache` (30-day TTL enforced in code).
 *   5. Retry 3× with 250 / 1000 / 4000 ms backoff on 429 / 5xx; 401/403
 *      fail-closed so the operator sees the auth issue.
 *   6. Every call writes to the existing `api_logs` table (this also
 *      backfills the Phase-44-era telemetry gap as a side effect).
 *
 * Phase 65 — MV error classification. A MillionVerifier response with
 * `result === "error"`, `resultcode === 4`, or a non-empty `error`
 * field is a PROVIDER FAILURE, not a row-level 'unknown' verdict.
 * It must (a) fall through to ZeroBounce and (b) be surfaced to the
 * audit trail as outcome='error' with the verbatim error message,
 * NOT as a definite verdict. Same logic applies symmetrically to ZB.
 */
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type VerifyStatus =
  | "verified"
  | "likely"
  | "risky"
  | "catch_all"
  | "invalid"
  | "unknown";

export type VerifyResult = {
  status: VerifyStatus;
  verifier: "millionverifier" | "zerobounce" | "none";
  score?: number; // 0-1, when provider returns one
  raw?: unknown;
  /**
   * Phase 65 — when set, the authoritative verifier (in `verifier`) was
   * a provider-level FAILURE (HTTP non-2xx, auth, API key rejection,
   * malformed response, network), NOT an inconclusive verdict. Callers
   * use this to distinguish "MV ran fine but said unknown" from
   * "MV could not run". `status` is set to 'unknown' in both cases for
   * back-compat, but only the latter has `error` populated.
   */
  error?: string;
  // Phase 64 — preserve BOTH providers' raw responses so the audit
  // trail can show what MV said even when we ended up using ZB's
  // verdict (and vice versa). `raw` continues to point at the
  // authoritative provider's payload to preserve the prior contract.
  mv_raw?: unknown;
  mv_status?: VerifyStatus;
  mv_error?: string;
  zb_raw?: unknown;
  zb_status?: VerifyStatus;
  zb_error?: string;
};

const SYNTAX_RE =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const DOMAIN_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logApi(
  provider: string,
  endpoint: string,
  status: number | string,
  costEstimate: number | null,
  summary: string,
): Promise<void> {
  try {
    const admin = createSupabaseAdminClient();
    if (!admin) return;
    await admin.from("api_logs").insert({
      provider,
      endpoint,
      request_summary: summary.slice(0, 500),
      response_status: String(status),
      cost_estimate: costEstimate,
    });
  } catch {
    /* never block verification on log failures */
  }
}

/**
 * 3 attempts with exponential backoff on 429/5xx.
 * 401/403 fail-closed (do NOT silently fall through).
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const delays = [250, 1000, 4000];
  let last: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const r = await fetch(url, init);
    if (r.status === 401 || r.status === 403) {
      // Hard auth error — caller must see this.
      throw new Error(`auth_failure_${r.status}`);
    }
    if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
      last = r;
      await sleep(delays[attempt] ?? 4000);
      continue;
    }
    return r;
  }
  if (last) return last;
  throw new Error("retry_exhausted");
}

function syntaxOk(email: string): boolean {
  if (!email || email.length > 254) return false;
  return SYNTAX_RE.test(email);
}

function extractDomain(email: string): string | null {
  const at = email.indexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

interface DomainCacheRow {
  domain: string;
  is_catch_all: boolean | null;
  has_mx: boolean | null;
  smtp_provider: string | null;
  last_checked_at: string;
}

async function readDomainCache(
  domain: string,
): Promise<DomainCacheRow | null> {
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data } = await admin
    .from("contact_domain_cache")
    .select("domain, is_catch_all, has_mx, smtp_provider, last_checked_at")
    .eq("domain", domain)
    .maybeSingle();
  if (!data) return null;
  const ts = Date.parse(data.last_checked_at);
  if (!Number.isFinite(ts)) return null;
  if (Date.now() - ts > DOMAIN_CACHE_TTL_MS) return null;
  return data as DomainCacheRow;
}

async function writeDomainCache(args: {
  domain: string;
  is_catch_all?: boolean | null;
  has_mx?: boolean | null;
  smtp_provider?: string | null;
}): Promise<void> {
  try {
    const admin = createSupabaseAdminClient();
    if (!admin) return;
    await admin.from("contact_domain_cache").upsert(
      {
        domain: args.domain,
        is_catch_all: args.is_catch_all ?? null,
        has_mx: args.has_mx ?? null,
        smtp_provider: args.smtp_provider ?? null,
        last_checked_at: new Date().toISOString(),
      },
      { onConflict: "domain" },
    );
  } catch {
    /* cache writes never block */
  }
}

/**
 * MillionVerifier `/api/v3/?api=KEY&email=…&timeout=10`.
 * Maps `result` → VerifyStatus.
 *
 * Phase 65 — distinguish provider failure from inconclusive verdict:
 *  - HTTP non-2xx, network exception, auth_failure_* → provider failure.
 *  - `result === "error"` OR `resultcode === 4` OR non-empty `error`
 *    field in the JSON body → provider failure (e.g. "Apikey not found").
 *  - Bare `unknown` (no error field, resultcode != 4) → inconclusive
 *    verdict, still status='unknown' but error is undefined so the
 *    caller can tell the difference.
 *
 * Always returns a VerifyResult (no longer returns null on failure) so
 * downstream code has a stable shape to inspect via `error`.
 */
async function callMillionVerifier(
  email: string,
): Promise<VerifyResult | null> {
  const key = process.env.MILLIONVERIFIER_API_KEY;
  if (!key) return null;
  const url = `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}&timeout=10`;
  let resp: Response;
  try {
    resp = await fetchWithRetry(url, { method: "GET" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logApi(
      "millionverifier",
      "/api/v3",
      "error",
      0.005,
      `email=${email} err=${msg}`,
    );
    return {
      status: "unknown",
      verifier: "millionverifier",
      error: `MillionVerifier request failed: ${msg}`,
      raw: { error: msg },
    };
  }
  if (!resp.ok) {
    await logApi(
      "millionverifier",
      "/api/v3",
      resp.status,
      0.005,
      `email=${email} non-ok`,
    );
    return {
      status: "unknown",
      verifier: "millionverifier",
      error: `MillionVerifier HTTP ${resp.status}`,
      raw: { http_status: resp.status },
    };
  }
  const json = await resp.json().catch(() => ({}));
  await logApi(
    "millionverifier",
    "/api/v3",
    resp.status,
    0.005,
    `email=${email} result=${(json as { result?: string })?.result ?? "?"}`,
  );
  const body = json as {
    result?: string;
    resultcode?: number;
    error?: string;
    quality_score?: number;
  };
  const result = String(body?.result ?? "").toLowerCase();
  const resultcode = typeof body?.resultcode === "number" ? body.resultcode : null;
  const errorField = typeof body?.error === "string" ? body.error.trim() : "";
  // Phase 65 — provider-level failure detection. resultcode 4 ===
  // "Apikey not found" per the MV docs; non-empty `error` field or
  // `result === "error"` are equally clear signals.
  if (result === "error" || resultcode === 4 || errorField.length > 0) {
    const msg = errorField || `result=${result || "error"} resultcode=${resultcode ?? "?"}`;
    return {
      status: "unknown",
      verifier: "millionverifier",
      error: `MillionVerifier: ${msg}`,
      raw: json,
    };
  }
  const qualityRaw = body?.quality_score;
  const score =
    typeof qualityRaw === "number" && Number.isFinite(qualityRaw)
      ? Math.max(0, Math.min(1, qualityRaw / 100))
      : undefined;
  switch (result) {
    case "ok":
      return { status: "verified", verifier: "millionverifier", score, raw: json };
    case "invalid":
      return { status: "invalid", verifier: "millionverifier", raw: json };
    case "disposable":
      return { status: "risky", verifier: "millionverifier", raw: json };
    case "catch_all":
    case "catchall":
      return { status: "catch_all", verifier: "millionverifier", raw: json };
    case "unknown":
      return { status: "unknown", verifier: "millionverifier", raw: json };
    default:
      return { status: "unknown", verifier: "millionverifier", raw: json };
  }
}

/**
 * ZeroBounce `/v2/validate?api_key=KEY&email=…`.
 * Maps `status` → VerifyStatus.
 *
 * Phase 65 — same provider-failure classification as MV. ZeroBounce
 * may also return a JSON body with `error` populated on auth failure
 * (e.g. "Invalid API Key"). Treat HTTP non-2xx, network, auth, and
 * `error` field as provider failure.
 */
async function callZeroBounce(
  email: string,
): Promise<VerifyResult | null> {
  const key = process.env.ZEROBOUNCE_API_KEY;
  if (!key) return null;
  const url = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}`;
  let resp: Response;
  try {
    resp = await fetchWithRetry(url, { method: "GET" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logApi(
      "zerobounce",
      "/v2/validate",
      "error",
      0.008,
      `email=${email} err=${msg}`,
    );
    return {
      status: "unknown",
      verifier: "zerobounce",
      error: `ZeroBounce request failed: ${msg}`,
      raw: { error: msg },
    };
  }
  if (!resp.ok) {
    await logApi(
      "zerobounce",
      "/v2/validate",
      resp.status,
      0.008,
      `email=${email} non-ok`,
    );
    return {
      status: "unknown",
      verifier: "zerobounce",
      error: `ZeroBounce HTTP ${resp.status}`,
      raw: { http_status: resp.status },
    };
  }
  const json = (await resp.json().catch(() => ({}))) as {
    status?: string;
    sub_status?: string;
    mx_found?: string | boolean;
    mx_record?: string;
    domain?: string;
    error?: string;
  };
  await logApi(
    "zerobounce",
    "/v2/validate",
    resp.status,
    0.008,
    `email=${email} status=${json?.status ?? "?"}`,
  );
  const errorField = typeof json?.error === "string" ? json.error.trim() : "";
  if (errorField.length > 0) {
    return {
      status: "unknown",
      verifier: "zerobounce",
      error: `ZeroBounce: ${errorField}`,
      raw: json,
    };
  }
  const status = String(json?.status ?? "").toLowerCase();
  const mxFound =
    json?.mx_found === true ||
    String(json?.mx_found ?? "").toLowerCase() === "true";
  const provider =
    typeof json?.mx_record === "string" && json.mx_record
      ? json.mx_record.split(".").slice(-3, -2)[0] ?? null
      : null;
  // Cache the MX signal opportunistically.
  const domain = json?.domain || extractDomain(email);
  if (domain) {
    await writeDomainCache({
      domain: domain.toLowerCase(),
      has_mx: mxFound,
      smtp_provider: provider,
      is_catch_all: status === "catch-all" || status === "catch_all" ? true : null,
    });
  }
  switch (status) {
    case "valid":
      return { status: "verified", verifier: "zerobounce", raw: json };
    case "invalid":
      return { status: "invalid", verifier: "zerobounce", raw: json };
    case "catch-all":
    case "catch_all":
      return { status: "catch_all", verifier: "zerobounce", raw: json };
    case "do_not_mail":
    case "spamtrap":
    case "abuse":
      return { status: "risky", verifier: "zerobounce", raw: json };
    case "unknown":
      return { status: "unknown", verifier: "zerobounce", raw: json };
    default:
      return { status: "unknown", verifier: "zerobounce", raw: json };
  }
}

/**
 * Verify a single email. See module docstring for behavior.
 *
 * Phase 64 — when MV returns 'unknown' / 'catch_all' / fails we MUST
 * fall through to ZeroBounce. Phase 65 extends the fallthrough to MV
 * provider failures (HTTP, auth, "Apikey not found"). We stash BOTH
 * providers' raw responses + error messages on the returned
 * VerifyResult so the caller can persist each one onto its own audit
 * event row.
 */
export async function verifyEmail(email: string): Promise<VerifyResult> {
  if (!syntaxOk(email)) {
    return { status: "invalid", verifier: "none" };
  }

  const mv = await callMillionVerifier(email);
  // MV returned a definite result (and no provider error) — short-circuit.
  if (
    mv &&
    !mv.error &&
    (mv.status === "verified" ||
      mv.status === "invalid" ||
      mv.status === "risky")
  ) {
    return {
      ...mv,
      mv_raw: mv.raw,
      mv_status: mv.status,
    };
  }
  // MV returned catch_all / unknown / errored, OR no key → fall through to ZB.
  const zb = await callZeroBounce(email);
  if (zb) {
    // If ZB also failed at the provider level, we still report ZB as
    // the authoritative verifier here (its `error` field tells the
    // caller what happened). The caller is responsible for deciding
    // whether to stamp email_verifier='zerobounce' vs 'none'.
    return {
      ...zb,
      mv_raw: mv?.raw ?? null,
      mv_status: mv?.status,
      mv_error: mv?.error,
      zb_raw: zb.raw,
      zb_status: zb.status,
      zb_error: zb.error,
    };
  }
  // ZB not configured.
  if (mv) {
    return {
      ...mv,
      mv_raw: mv.raw,
      mv_status: mv.status,
      mv_error: mv.error,
    };
  }
  return { status: "unknown", verifier: "none" };
}

/**
 * Read-only domain-level cache lookup. Used by orchestrate.ts to decide
 * whether to bother with Hunter / pattern guess.
 */
export async function readDomainSignal(
  domain: string,
): Promise<{ is_catch_all: boolean | null; has_mx: boolean | null; smtp_provider: string | null } | null> {
  if (!domain) return null;
  const row = await readDomainCache(domain.toLowerCase());
  if (!row) return null;
  return {
    is_catch_all: row.is_catch_all ?? null,
    has_mx: row.has_mx ?? null,
    smtp_provider: row.smtp_provider ?? null,
  };
}
