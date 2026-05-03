/**
 * Phase 22 — Tiny timing helper used by the audit-generation pipeline
 * to log how long each stage takes. Prefer this over scattered
 * `console.time` / `Date.now()` pairs because it logs one line per
 * stage with the report id and a stable label so we can grep prod logs
 * for `[timing]` and reconstruct the full waterfall.
 */
export async function withTiming<T>(
  label: string,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - startedAt;
    console.log("[timing]", { label, ms, ok: true, ...(meta ?? {}) });
    return result;
  } catch (e) {
    const ms = Date.now() - startedAt;
    console.log("[timing]", {
      label,
      ms,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      ...(meta ?? {}),
    });
    throw e;
  }
}

/**
 * Wrap any `fetch()` call with a hard deadline. The default is 60s — a
 * single hung upstream request shouldn't be allowed to silently consume
 * the entire 300s function budget. Callers can override per-call.
 *
 * Usage:
 *
 *   const res = await fetchWithTimeout(url, { headers: { ... } });
 *   // throws AbortError after 60s
 */
export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit & { timeoutMs?: number; label?: string } = {},
): Promise<Response> {
  const { timeoutMs = 60_000, label, signal: externalSignal, ...rest } = init;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  if (externalSignal) {
    if (externalSignal.aborted) ac.abort();
    else externalSignal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  try {
    return await fetch(input, { ...rest, signal: ac.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      throw new Error(`fetchWithTimeout timed out after ${timeoutMs}ms${label ? ` [${label}]` : ""} for ${url.slice(0, 200)}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
