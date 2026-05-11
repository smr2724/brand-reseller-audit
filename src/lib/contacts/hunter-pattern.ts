/**
 * Phase 72 — Construct an email from a Hunter `pattern` plus first/last
 * name. Used as a fallback when Apollo people/match, Apollo
 * mixed_people/search, and Hunter email-finder all miss but Hunter's
 * domain-search returned a high-confidence pattern.
 *
 * Carna4 motivating case: Apollo+Hunter-finder all missed Maria Ringo,
 * but Hunter domain-search returned `{last}` at 0.98 confidence for
 * carna4.com. Substituting `Ringo` → `ringo@carna4.com` matches her
 * actual published address.
 *
 * Supported tokens (lowercased before substitution):
 *   {first}, {last}, {f}, {l},
 *   {first}.{last}, {f}{last}, {first}{l}, {first}_{last}
 *
 * Unrecognized tokens → returns { ok: false, reason: 'unrecognized_token' }
 * so the caller can surface NEEDS_HUMAN_REVIEW instead of guessing.
 */

export const HUNTER_PATTERN_MIN_CONFIDENCE = 0.85;

export type HunterPatternFailure =
  | "missing_inputs"
  | "unrecognized_token"
  | "empty_result";

export type HunterPatternConstructResult =
  | { ok: true; email: string; pattern: string }
  | { ok: false; reason: HunterPatternFailure; pattern: string };

const RECOGNIZED_TOKENS = new Set([
  "{first}",
  "{last}",
  "{f}",
  "{l}",
  "{first}.{last}",
  "{f}{last}",
  "{first}{l}",
  "{first}_{last}",
]);

/**
 * Substitute Hunter pattern tokens with lowercased name parts and
 * append `@domain`. Returns `{ok:false}` when the pattern contains an
 * unrecognized token (so we don't silently guess).
 */
export function constructEmailFromHunterPattern(input: {
  pattern: string | null | undefined;
  first_name: string | null | undefined;
  last_name: string | null | undefined;
  domain: string | null | undefined;
}): HunterPatternConstructResult {
  const pattern = (input.pattern ?? "").trim();
  const first = (input.first_name ?? "").trim().toLowerCase();
  const last = (input.last_name ?? "").trim().toLowerCase();
  const domain = (input.domain ?? "").trim().toLowerCase();
  if (!pattern || !first || !last || !domain) {
    return { ok: false, reason: "missing_inputs", pattern };
  }

  // Tokens that are NOT in the recognized set should fail loudly.
  // Hunter's pattern grammar uses the explicit tokens above; any other
  // `{…}` group is an unsupported convention we won't guess on.
  const allTokens = Array.from(pattern.matchAll(/\{[^}]+\}/g)).map((m) => m[0]);
  for (const t of allTokens) {
    if (!RECOGNIZED_TOKENS.has(t)) {
      return { ok: false, reason: "unrecognized_token", pattern };
    }
  }

  const f = first[0] ?? "";
  const l = last[0] ?? "";
  // Substitute the multi-character tokens first so single-letter ones
  // don't eat their substrings.
  let local = pattern
    .replace(/\{first\}\.\{last\}/g, `${first}.${last}`)
    .replace(/\{first\}_\{last\}/g, `${first}_${last}`)
    .replace(/\{f\}\{last\}/g, `${f}${last}`)
    .replace(/\{first\}\{l\}/g, `${first}${l}`)
    .replace(/\{first\}/g, first)
    .replace(/\{last\}/g, last)
    .replace(/\{f\}/g, f)
    .replace(/\{l\}/g, l);

  if (!local || local.includes("{") || local.includes("}")) {
    return { ok: false, reason: "unrecognized_token", pattern };
  }
  const email = `${local}@${domain}`;
  if (email.length < 5 || !email.includes("@") || !email.includes(".")) {
    return { ok: false, reason: "empty_result", pattern };
  }
  return { ok: true, email, pattern };
}
