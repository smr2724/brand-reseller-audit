/**
 * Phase 9 — anti-abuse helpers for the public /audit-request flow.
 *
 * - Free-email provider blocklist (edit FREE_EMAIL_PROVIDERS as needed).
 * - Cloudflare Turnstile siteverify.
 * - Supabase-backed rate limit counters keyed by email/IP/global-day.
 * - Email-verification token generation + hashing (SHA-256 hex).
 */
import { createHash, randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const FREE_EMAIL_PROVIDERS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "rocketmail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "proton.me",
  "protonmail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
]);

export function isFreeEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase().trim();
  if (!domain) return false;
  return FREE_EMAIL_PROVIDERS.has(domain);
}

// =============================================================
// Cloudflare Turnstile
// =============================================================

const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(
  token: string,
  remoteIp: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Allow in non-production without a configured secret so local dev
    // works, but return a clear flag — the API route logs and proceeds.
    return { ok: true, error: "TURNSTILE_SECRET_KEY missing — bypass" };
  }
  if (!token) return { ok: false, error: "missing token" };
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (remoteIp) form.set("remoteip", remoteIp);
  let resp: Response;
  try {
    resp = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } catch (e) {
    return { ok: false, error: `network error: ${String((e as Error)?.message ?? e)}` };
  }
  if (!resp.ok) return { ok: false, error: `siteverify HTTP ${resp.status}` };
  const data = (await resp.json().catch(() => null)) as
    | { success?: boolean; "error-codes"?: string[] }
    | null;
  if (!data?.success) {
    return {
      ok: false,
      error: `failed: ${(data?.["error-codes"] ?? ["unknown"]).join(", ")}`,
    };
  }
  return { ok: true };
}

// =============================================================
// Rate limits
// =============================================================

export interface RateLimitConfig {
  emailPerDay: number; // 1 audit per email / 24h
  ipPerDay: number;    // 3 per IP / 24h
  globalPerDay: number; // 50 / day total
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  emailPerDay: 1,
  ipPerDay: 3,
  globalPerDay: 50,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RateCheckResult {
  ok: boolean;
  reason?: "email" | "ip" | "global";
}

function dayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function bumpKey(
  admin: SupabaseClient<any, any, any>,
  key: string,
  windowMs: number,
): Promise<number> {
  const now = new Date();
  const { data: existing } = await admin
    .from("audit_request_rate_limits")
    .select("count, window_start")
    .eq("key", key)
    .maybeSingle();
  if (!existing) {
    await admin
      .from("audit_request_rate_limits")
      .insert({ key, count: 1, window_start: now.toISOString() });
    return 1;
  }
  const start = new Date(existing.window_start).getTime();
  if (Number.isFinite(start) && now.getTime() - start > windowMs) {
    // Window expired — reset.
    await admin
      .from("audit_request_rate_limits")
      .update({ count: 1, window_start: now.toISOString() })
      .eq("key", key);
    return 1;
  }
  const next = (existing.count ?? 0) + 1;
  await admin
    .from("audit_request_rate_limits")
    .update({ count: next })
    .eq("key", key);
  return next;
}

export async function checkAndConsumeRateLimit(
  admin: SupabaseClient<any, any, any>,
  args: { email: string; ip: string | null },
  cfg: RateLimitConfig = DEFAULT_RATE_LIMITS,
): Promise<RateCheckResult> {
  const emailKey = `email:${args.email.toLowerCase()}`;
  const globalKey = `global:${dayKey()}`;
  const ipKey = args.ip ? `ip:${args.ip}` : null;

  // Pre-check counts WITHOUT bumping so a single rejected request doesn't
  // burn the user's quota for the day.
  const checks: { key: string; limit: number; reason: RateCheckResult["reason"] }[] = [
    { key: emailKey, limit: cfg.emailPerDay, reason: "email" },
    { key: globalKey, limit: cfg.globalPerDay, reason: "global" },
  ];
  if (ipKey) checks.push({ key: ipKey, limit: cfg.ipPerDay, reason: "ip" });

  for (const c of checks) {
    const { data: row } = await admin
      .from("audit_request_rate_limits")
      .select("count, window_start")
      .eq("key", c.key)
      .maybeSingle();
    if (!row) continue;
    const start = new Date(row.window_start).getTime();
    const fresh = Number.isFinite(start) && Date.now() - start <= DAY_MS;
    if (fresh && (row.count ?? 0) >= c.limit) {
      return { ok: false, reason: c.reason };
    }
  }

  // All clear — bump everything.
  await bumpKey(admin, emailKey, DAY_MS);
  await bumpKey(admin, globalKey, DAY_MS);
  if (ipKey) await bumpKey(admin, ipKey, DAY_MS);
  return { ok: true };
}

// =============================================================
// Verification token
// =============================================================

export function generateVerificationToken(): { plain: string; hash: string } {
  const plain = randomBytes(32).toString("base64url");
  const hash = sha256Hex(plain);
  return { plain, hash };
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function getClientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    null
  );
}

export function firstNameFromContact(contactName: string | null | undefined): string | null {
  if (!contactName) return null;
  const trimmed = contactName.trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/)[0];
  return first || null;
}
