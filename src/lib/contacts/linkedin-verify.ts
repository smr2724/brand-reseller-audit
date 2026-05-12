/**
 * Phase 72 — LinkedIn URL HEAD-verification helper.
 *
 * Gate C's LLM-named decision-maker is reliable for the *name*, but
 * the LinkedIn slug is often hallucinated (Carna4 case: the real
 * Maria Ringo lives at `/in/maria-ringo-22a870266/` while Gate C
 * produced `/in/maria-ringo-4a6b1b16/` and Apollo `/people/match`
 * returned no email for the bogus URL). Before we hand a Gate C
 * LinkedIn URL to Apollo, HEAD-verify it. On failure we drop the
 * URL and call Apollo with first_name + last_name + organization_name
 * instead.
 *
 * Status interpretation:
 *   200            → reachable
 *   999            → rate_limited (LinkedIn anti-bot — NOT proof of slug
 *                    existence; Phase 73 fix. Caller falls through to
 *                    Apollo without the URL.)
 *   301/302        → follow ONE redirect, treat the final hop as result
 *   404            → not_found (definitely bogus)
 *   429            → rate_limited (don't penalize the URL)
 *   other/timeout  → timeout (transient — caller decides whether to drop)
 */

const LINKEDIN_HEAD_TIMEOUT_MS = 5000;
const LINKEDIN_USER_AGENT =
  "brand-reseller-audit steve@rollemanagementgroup.com";
const LINKEDIN_SLUG_RE = /^https:\/\/(www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+\/?$/;

export interface VerifyLinkedInUrlResult {
  ok: boolean;
  normalized: string | null;
  reason: "reachable" | "rate_limited" | "not_found" | "timeout" | "malformed";
}

export function normalizeLinkedInUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  let s = rawUrl.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, "")}`;
  // Force https:// — LinkedIn redirects http:// to https:// anyway and
  // the regex below only accepts https://.
  s = s.replace(/^http:\/\//i, "https://");
  // Drop trailing slash (the regex tolerates either; normalize for log
  // consistency).
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

interface FetchLike {
  (url: string, init?: RequestInit & { signal?: AbortSignal }): Promise<Response>;
}

export async function verifyLinkedInUrl(
  rawUrl: string,
  deps?: { fetchImpl?: FetchLike; timeoutMs?: number },
): Promise<VerifyLinkedInUrlResult> {
  const normalized = normalizeLinkedInUrl(rawUrl);
  if (!normalized || !LINKEDIN_SLUG_RE.test(normalized)) {
    return { ok: false, normalized: null, reason: "malformed" };
  }
  const doFetch: FetchLike = deps?.fetchImpl ?? (fetch as unknown as FetchLike);
  const timeoutMs = deps?.timeoutMs ?? LINKEDIN_HEAD_TIMEOUT_MS;

  const status = await headStatus(doFetch, normalized, timeoutMs);
  return mapStatusToResult(status, normalized, async (nextUrl) =>
    headStatus(doFetch, nextUrl, timeoutMs),
  );
}

async function headStatus(
  doFetch: FetchLike,
  url: string,
  timeoutMs: number,
): Promise<{ status: number | "timeout" | "error"; location: string | null }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await doFetch(url, {
      method: "HEAD",
      // The native fetch in Node 18+ does NOT auto-follow redirects when
      // we want to inspect them; pass `redirect: 'manual'` to capture
      // 301/302 and decide whether to follow.
      redirect: "manual",
      headers: {
        "User-Agent": LINKEDIN_USER_AGENT,
        Accept: "*/*",
      },
      signal: controller.signal,
    });
    const location = resp.headers?.get?.("location") ?? null;
    return { status: resp.status, location };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "AbortError") return { status: "timeout", location: null };
    return { status: "error", location: null };
  } finally {
    clearTimeout(t);
  }
}

async function mapStatusToResult(
  res: { status: number | "timeout" | "error"; location: string | null },
  normalized: string,
  followOnce: (nextUrl: string) => Promise<{
    status: number | "timeout" | "error";
    location: string | null;
  }>,
): Promise<VerifyLinkedInUrlResult> {
  if (res.status === "timeout" || res.status === "error") {
    return { ok: false, normalized, reason: "timeout" };
  }
  if (res.status === 200) {
    return { ok: true, normalized, reason: "reachable" };
  }
  // Phase 73 — HTTP 999 is LinkedIn's anti-bot status. It does NOT
  // confirm the profile slug exists. Treat it the same as 429 so Gate C
  // seeding falls through to Apollo without the (potentially
  // hallucinated) URL.
  if (res.status === 999) {
    return { ok: false, normalized, reason: "rate_limited" };
  }
  if ((res.status === 301 || res.status === 302) && res.location) {
    // Follow exactly one redirect. If the redirect target is itself
    // another redirect we treat it as the final outcome.
    const next = resolveLocation(normalized, res.location);
    if (!next) return { ok: false, normalized, reason: "not_found" };
    const r2 = await followOnce(next);
    if (r2.status === 200) {
      return { ok: true, normalized: next, reason: "reachable" };
    }
    if (r2.status === 999) return { ok: false, normalized, reason: "rate_limited" };
    if (r2.status === 404) return { ok: false, normalized, reason: "not_found" };
    if (r2.status === 429) return { ok: false, normalized, reason: "rate_limited" };
    return { ok: false, normalized, reason: "timeout" };
  }
  if (res.status === 404) return { ok: false, normalized, reason: "not_found" };
  if (res.status === 429) return { ok: false, normalized, reason: "rate_limited" };
  return { ok: false, normalized, reason: "timeout" };
}

function resolveLocation(base: string, location: string): string | null {
  if (!location) return null;
  try {
    return new URL(location, base).toString();
  } catch {
    return null;
  }
}
