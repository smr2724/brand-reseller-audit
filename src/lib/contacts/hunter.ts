/**
 * Phase 47 — Hunter.io integration. Pattern fallback for the contact
 * discovery flow when Apollo returns no email.
 *
 * Free tier: 25 searches/mo. Paid: $34/mo for 500. Strong on small
 * domains where Apollo is empty (Carna4-style). All calls retry with
 * 250 / 1000 / 4000 ms backoff on 429/5xx; 401/403 fail-closed.
 */
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { trackCost } from "@/lib/cost/track";

const HUNTER_BASE = "https://api.hunter.io/v2";

export interface HunterPatternResult {
  ok: boolean;
  pattern: string | null;        // e.g. "{first}.{last}", "{first}", "{f}{last}"
  pattern_confidence: number;    // 0-1
  organization: string | null;
  is_catch_all: boolean | null;
  has_mx: boolean | null;
  raw: unknown;
  error?: string;
}

export interface HunterFinderResult {
  ok: boolean;
  email: string | null;
  score: number | null; // 0-100 from Hunter
  pattern: string | null;
  raw: unknown;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string): Promise<Response> {
  const delays = [250, 1000, 4000];
  let last: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const r = await fetch(url, { method: "GET" });
    if (r.status === 401 || r.status === 403) {
      throw Object.assign(new Error(`hunter_auth_${r.status}`), {
        status: r.status,
      });
    }
    if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
      last = r;
      await sleep(delays[attempt] ?? 4000);
      continue;
    }
    return r;
  }
  if (last) return last;
  throw new Error("hunter_retry_exhausted");
}

async function logApi(
  endpoint: string,
  status: number | string,
  costEstimate: number,
  summary: string,
): Promise<void> {
  try {
    const admin = createSupabaseAdminClient();
    if (!admin) return;
    await admin.from("api_logs").insert({
      provider: "hunter",
      endpoint,
      request_summary: summary.slice(0, 500),
      response_status: String(status),
      cost_estimate: costEstimate,
    });
  } catch {
    /* no-op */
  }
}

export async function hunterDomainPattern(
  domain: string,
): Promise<HunterPatternResult> {
  const empty: HunterPatternResult = {
    ok: false,
    pattern: null,
    pattern_confidence: 0,
    organization: null,
    is_catch_all: null,
    has_mx: null,
    raw: null,
  };
  if (!domain) return { ...empty, error: "domain required" };
  const key = process.env.HUNTER_API_KEY;
  if (!key) return { ...empty, error: "HUNTER_API_KEY missing" };
  const url = `${HUNTER_BASE}/domain-search?domain=${encodeURIComponent(domain)}&limit=10&api_key=${encodeURIComponent(key)}`;
  let resp: Response;
  try {
    resp = await fetchWithRetry(url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logApi("/domain-search", "error", 0.04, `domain=${domain} err=${msg}`);
    return { ...empty, error: msg };
  }
  if (!resp.ok) {
    await logApi("/domain-search", resp.status, 0.04, `domain=${domain} non-ok`);
    return { ...empty, error: `hunter_${resp.status}` };
  }
  const json = (await resp.json().catch(() => ({}))) as {
    data?: {
      organization?: string;
      pattern?: string | null;
      accept_all?: boolean;
      disposable?: boolean;
      webmail?: boolean;
      emails?: Array<{ confidence?: number }>;
    };
  };
  await logApi("/domain-search", resp.status, 0.04, `domain=${domain}`);
  const data = json?.data;
  const pattern = data?.pattern ?? null;
  const emailList = Array.isArray(data?.emails) ? data!.emails! : [];
  const confidences = emailList
    .map((e) => (typeof e.confidence === "number" ? e.confidence : 0))
    .filter((n) => n > 0);
  const avgConf =
    confidences.length > 0
      ? confidences.reduce((s, n) => s + n, 0) / confidences.length / 100
      : pattern
        ? 0.6
        : 0;
  return {
    ok: true,
    pattern,
    pattern_confidence: Math.max(0, Math.min(1, avgConf)),
    organization: data?.organization ?? null,
    is_catch_all: data?.accept_all ?? null,
    has_mx: null,
    raw: json,
  };
}

export async function hunterEmailFinder(input: {
  domain: string;
  first_name: string;
  last_name: string;
}): Promise<HunterFinderResult> {
  const empty: HunterFinderResult = {
    ok: false,
    email: null,
    score: null,
    pattern: null,
    raw: null,
  };
  if (!input.domain || !input.first_name || !input.last_name) {
    return { ...empty, error: "domain, first_name, last_name required" };
  }
  const key = process.env.HUNTER_API_KEY;
  if (!key) return { ...empty, error: "HUNTER_API_KEY missing" };
  const params = new URLSearchParams({
    domain: input.domain,
    first_name: input.first_name,
    last_name: input.last_name,
    api_key: key,
  });
  const url = `${HUNTER_BASE}/email-finder?${params.toString()}`;
  let resp: Response;
  try {
    resp = await fetchWithRetry(url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logApi(
      "/email-finder",
      "error",
      0.07,
      `domain=${input.domain} err=${msg}`,
    );
    return { ...empty, error: msg };
  }
  if (!resp.ok) {
    await logApi(
      "/email-finder",
      resp.status,
      0.07,
      `domain=${input.domain} non-ok`,
    );
    return { ...empty, error: `hunter_${resp.status}` };
  }
  const json = (await resp.json().catch(() => ({}))) as {
    data?: { email?: string | null; score?: number; pattern?: string };
  };
  await logApi(
    "/email-finder",
    resp.status,
    0.07,
    `domain=${input.domain} ${input.first_name} ${input.last_name}`,
  );
  const emailFound = !!json?.data?.email;
  // Phase 81 — Hunter only charges a credit when an email is returned.
  await trackCost({
    provider: "hunter",
    operation: emailFound ? "hunter_email_finder" : "hunter_email_finder_miss",
    units: emailFound ? 1 : 0,
  });
  return {
    ok: true,
    email: json?.data?.email ?? null,
    score:
      typeof json?.data?.score === "number" ? json.data.score : null,
    pattern: json?.data?.pattern ?? null,
    raw: json,
  };
}
