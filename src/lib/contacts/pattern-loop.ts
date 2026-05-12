/**
 * Phase 73 — 8-pattern email construction fallback.
 *
 * Triggered after Apollo people/match, Apollo mixed_people/search, and
 * Hunter email-finder have all missed. Iterates through an ordered list
 * of patterns, MV-verifying each constructed email, and STOPS on the
 * first MV `verified` result. If only `risky` / `catch_all` results
 * come back, the best one is kept as a fallback (is_primary=false). If
 * every pattern yields `invalid`, the caller falls through to the LLM
 * web-search step.
 *
 * Patterns (deduped against the recommended pattern when present):
 *   1. Hunter's recommended (confidence ≥ 0.85)
 *   2. {first}.{last}
 *   3. {first}{last}
 *   4. {first}
 *   5. {f}{last}
 *   6. {first}_{last}
 *   7. {f}.{last}
 *   8. {last}
 *
 * Cost ceiling: 8 MV calls × ~$0.0008 = $0.0064/brand. No throttle.
 */
import type { VerifyResult, VerifyStatus } from "./email-verify";
import { verifyEmail } from "./email-verify";

export type PatternAttemptOutcome =
  | "verified"
  | "risky"
  | "catch_all"
  | "invalid"
  | "error";

export interface PatternAttempt {
  pattern: string;
  email: string;
  mv_status: VerifyStatus | null;
  mv_score: number | null;
  outcome: PatternAttemptOutcome;
}

export interface PatternLoopResult {
  ok: boolean;
  best_email: string | null;
  best_pattern: string | null;
  best_status: VerifyStatus | null;
  best_score: number | null;
  /** `valid` when we found an MV=verified hit; `risky` when only
   *  catch_all/risky results came back; `invalid` when every attempt
   *  came back invalid (and we should fall through to LLM web-search). */
  best_kind: "valid" | "risky" | "invalid" | "none";
  attempts: PatternAttempt[];
}

const BASE_PATTERNS = [
  "{first}.{last}",
  "{first}{last}",
  "{first}",
  "{f}{last}",
  "{first}_{last}",
  "{f}.{last}",
  "{last}",
] as const;

const RECOGNIZED_TOKENS = new Set([
  "{first}",
  "{last}",
  "{f}",
  "{l}",
]);

/**
 * Phase 73 — strip diacritics (NFD-normalize, drop combining marks)
 * and remove characters that are not SMTP local-part-safe. Hyphens
 * are preserved (Smith-Jones stays Smith-Jones); apostrophes and
 * other punctuation are dropped (O'Brien → obrien). Spaces in
 * multi-part last names collapse out.
 *
 * MV (and most provider MTAs) reject SMTPUTF8 local parts, so
 * `María.Ringo@…` returns invalid 100% of the time. Normalizing
 * here avoids burning 8 MV credits on doomed addresses.
 */
function safeLocalPart(input: string): string {
  return input
    .trim()
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\-]/g, "");
}

/**
 * Inspect the tokens in `pattern` and return the set of required
 * fields. Used so we can skip patterns whose required fields are
 * unavailable (e.g., skip `{last}` for a single-name candidate).
 */
function patternRequires(pattern: string): {
  needsFirst: boolean;
  needsLast: boolean;
  unknownTokens: string[];
} {
  const tokens = Array.from(pattern.matchAll(/\{[^}]+\}/g)).map((m) => m[0]);
  let needsFirst = false;
  let needsLast = false;
  const unknownTokens: string[] = [];
  for (const t of tokens) {
    if (t === "{first}" || t === "{f}") {
      needsFirst = true;
      continue;
    }
    if (t === "{last}" || t === "{l}") {
      needsLast = true;
      continue;
    }
    if (!RECOGNIZED_TOKENS.has(t)) {
      unknownTokens.push(t);
    }
  }
  return { needsFirst, needsLast, unknownTokens };
}

function constructFromToken(
  pattern: string,
  first: string,
  last: string,
  domain: string,
): string | null {
  const f = first[0] ?? "";
  const l = last[0] ?? "";
  // Substitute multi-char tokens first so single-char ones don't eat
  // their substrings.
  let local = pattern
    .replace(/\{first\}\.\{last\}/g, `${first}.${last}`)
    .replace(/\{first\}_\{last\}/g, `${first}_${last}`)
    .replace(/\{f\}\.\{last\}/g, `${f}.${last}`)
    .replace(/\{f\}\{last\}/g, `${f}${last}`)
    .replace(/\{first\}\{last\}/g, `${first}${last}`)
    .replace(/\{first\}\{l\}/g, `${first}${l}`)
    .replace(/\{first\}/g, first)
    .replace(/\{last\}/g, last)
    .replace(/\{f\}/g, f)
    .replace(/\{l\}/g, l);
  if (!local || local.includes("{") || local.includes("}")) return null;
  const email = `${local}@${domain}`;
  if (email.length < 5 || !email.includes("@") || !email.includes(".")) {
    return null;
  }
  return email;
}

function classify(s: VerifyStatus | null): PatternAttemptOutcome {
  if (s === "verified") return "verified";
  if (s === "risky") return "risky";
  if (s === "catch_all") return "catch_all";
  if (s === "invalid") return "invalid";
  return "error";
}

export interface PatternLoopInput {
  first_name: string | null;
  last_name: string | null;
  domain: string | null;
  /** Hunter's recommended pattern + confidence. Used as the first
   *  attempt when confidence ≥ 0.85. Pass null when not available. */
  recommended_pattern?: string | null;
  recommended_confidence?: number | null;
}

export interface PatternLoopDeps {
  verifyEmail?: typeof verifyEmail;
  /** Called once per attempt with the per-row event payload. Lets the
   *  orchestrator stream `hunter_pattern` audit events without coupling
   *  this helper to the events table. */
  onAttempt?: (attempt: PatternAttempt) => Promise<void>;
}

export async function runPatternLoop(
  input: PatternLoopInput,
  deps: PatternLoopDeps = {},
): Promise<PatternLoopResult> {
  // Phase 73 BLOCKER 2 — strip diacritics + non-ASCII before
  // constructing emails. MV rejects SMTPUTF8 local parts so
  // `maría.ringo@…` returns invalid 100% of the time.
  const first = safeLocalPart(input.first_name ?? "");
  const last = safeLocalPart(input.last_name ?? "");
  const domain = (input.domain ?? "").trim().toLowerCase();
  const verify = deps.verifyEmail ?? verifyEmail;

  // Phase 73 NIT 5 — we need a domain and at least one of first/last.
  // Each pattern then independently checks its own required tokens
  // (so a `first=Madonna, last=null` candidate can still try `{first}`
  // and `{f}`).
  if (!domain || (!first && !last)) {
    return {
      ok: false,
      best_email: null,
      best_pattern: null,
      best_status: null,
      best_score: null,
      best_kind: "none",
      attempts: [],
    };
  }

  const ordered: string[] = [];
  const seen = new Set<string>();

  // 1. Hunter's recommended pattern — only when confidence ≥ 0.85.
  //    Phase 73 NIT 6: if the recommendation contains unrecognized
  //    tokens (e.g., `{first}-{last}` which our substituter doesn't
  //    cover), silently skip it — don't burn an "attempted" slot in
  //    telemetry.
  const recPattern = (input.recommended_pattern ?? "").trim();
  const recConf =
    typeof input.recommended_confidence === "number"
      ? input.recommended_confidence
      : 0;
  if (recPattern && recConf >= 0.85) {
    const recReq = patternRequires(recPattern);
    if (recReq.unknownTokens.length === 0) {
      ordered.push(recPattern);
      seen.add(recPattern);
    }
  }

  // 2-8. The seven canonical patterns. Deduped against recommended.
  for (const p of BASE_PATTERNS) {
    if (!seen.has(p)) {
      ordered.push(p);
      seen.add(p);
    }
  }

  const attempts: PatternAttempt[] = [];
  let bestRisky: PatternAttempt | null = null;

  for (const pattern of ordered) {
    // Phase 73 NIT 4 — per-pattern token check. Skip a pattern when
    // its required field isn't filled (e.g., a `first=Madonna,
    // last=""` candidate skips `{last}` but still tries `{first}`).
    const req = patternRequires(pattern);
    if (req.needsFirst && !first) continue;
    if (req.needsLast && !last) continue;
    const email = constructFromToken(pattern, first, last, domain);
    if (!email) {
      const attempt: PatternAttempt = {
        pattern,
        email: "",
        mv_status: null,
        mv_score: null,
        outcome: "error",
      };
      attempts.push(attempt);
      if (deps.onAttempt) {
        try {
          await deps.onAttempt(attempt);
        } catch {
          /* never block on event-log */
        }
      }
      continue;
    }
    let v: VerifyResult | null = null;
    try {
      v = await verify(email);
    } catch {
      v = null;
    }
    const status = (v?.status ?? null) as VerifyStatus | null;
    const score = typeof v?.score === "number" ? v.score : null;
    const outcome = classify(status);
    const attempt: PatternAttempt = {
      pattern,
      email,
      mv_status: status,
      mv_score: score,
      outcome,
    };
    attempts.push(attempt);
    if (deps.onAttempt) {
      try {
        await deps.onAttempt(attempt);
      } catch {
        /* never block on event-log */
      }
    }
    if (outcome === "verified") {
      return {
        ok: true,
        best_email: email,
        best_pattern: pattern,
        best_status: status,
        best_score: score,
        best_kind: "valid",
        attempts,
      };
    }
    if (outcome === "risky" || outcome === "catch_all") {
      // Remember the best risky-class hit. Prefer 'risky' over
      // 'catch_all' since catch_all means MX accepts everything (low
      // signal). On ties, the first one wins so the recommended
      // pattern is preferred.
      const prevIsCatchAll = bestRisky?.outcome === "catch_all";
      const thisIsRisky = outcome === "risky";
      if (!bestRisky || (prevIsCatchAll && thisIsRisky)) {
        bestRisky = attempt;
      }
    }
    // outcome 'invalid' / 'error' → continue.
  }

  if (bestRisky) {
    return {
      ok: true,
      best_email: bestRisky.email,
      best_pattern: bestRisky.pattern,
      best_status: bestRisky.mv_status,
      best_score: bestRisky.mv_score,
      best_kind: "risky",
      attempts,
    };
  }

  // No verified, no risky — every attempt was invalid or errored.
  const anyInvalid = attempts.some((a) => a.outcome === "invalid");
  return {
    ok: false,
    best_email: null,
    best_pattern: null,
    best_status: null,
    best_score: null,
    best_kind: anyInvalid ? "invalid" : "none",
    attempts,
  };
}
