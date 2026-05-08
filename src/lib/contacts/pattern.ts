/**
 * Phase 47 — Pattern guess + `contact_domain_cache` helpers.
 *
 * The cache is a single source of truth for "what does this domain look
 * like" so we don't burn Hunter / MillionVerifier credits on a domain
 * we already pattern-matched today.
 */
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export interface DomainCacheEntry {
  domain: string;
  email_pattern: string | null;
  pattern_source: string | null;
  pattern_confidence: number | null;
  is_catch_all: boolean | null;
  has_mx: boolean | null;
  smtp_provider: string | null;
  last_checked_at: string;
}

export async function readPatternCache(
  domain: string,
): Promise<DomainCacheEntry | null> {
  if (!domain) return null;
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data } = await admin
    .from("contact_domain_cache")
    .select(
      "domain, email_pattern, pattern_source, pattern_confidence, is_catch_all, has_mx, smtp_provider, last_checked_at",
    )
    .eq("domain", domain.toLowerCase())
    .maybeSingle();
  return (data as DomainCacheEntry | null) ?? null;
}

export async function writePatternCache(args: {
  domain: string;
  email_pattern?: string | null;
  pattern_source?: string | null;
  pattern_confidence?: number | null;
  is_catch_all?: boolean | null;
  has_mx?: boolean | null;
  smtp_provider?: string | null;
}): Promise<void> {
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  await admin.from("contact_domain_cache").upsert(
    {
      domain: args.domain.toLowerCase(),
      email_pattern: args.email_pattern ?? null,
      pattern_source: args.pattern_source ?? null,
      pattern_confidence: args.pattern_confidence ?? null,
      is_catch_all: args.is_catch_all ?? null,
      has_mx: args.has_mx ?? null,
      smtp_provider: args.smtp_provider ?? null,
      last_checked_at: new Date().toISOString(),
    },
    { onConflict: "domain" },
  );
}

/**
 * Apply a Hunter-style pattern token to a (first, last, domain) triple.
 * Hunter encodes patterns as `{first}.{last}@{domain}` etc; we translate
 * `{f}` and `{l}` to first/last initial. Returns null when the pattern
 * isn't recognized or any required token is missing.
 */
export function applyEmailPattern(
  pattern: string | null | undefined,
  first: string | null | undefined,
  last: string | null | undefined,
  domain: string,
): string | null {
  if (!pattern || !domain) return null;
  const f = (first ?? "").trim().toLowerCase();
  const l = (last ?? "").trim().toLowerCase();
  if (!f && !l) return null;
  const fi = f[0] ?? "";
  const li = l[0] ?? "";
  let s = pattern;
  s = s.replace(/\{first\}/gi, f);
  s = s.replace(/\{last\}/gi, l);
  s = s.replace(/\{f\}/gi, fi);
  s = s.replace(/\{l\}/gi, li);
  s = s.replace(/\{firstname\}/gi, f);
  s = s.replace(/\{lastname\}/gi, l);
  // If pattern doesn't include an @ assume "{...}@{domain}".
  if (!s.includes("@")) {
    s = `${s}@${domain}`;
  } else {
    s = s.replace(/\{domain\}/gi, domain);
  }
  // sanity check
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s)) {
    return null;
  }
  return s.toLowerCase();
}
