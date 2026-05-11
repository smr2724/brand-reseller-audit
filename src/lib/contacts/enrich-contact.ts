/**
 * Phase 63 — Single-contact enrichment pipeline. Shared between the
 * orchestrator (auto-runs on the primary discovered candidate) and the
 * on-demand POST /api/brands/[id]/contacts/[contactId]/enrich endpoint.
 *
 * Pipeline:
 *   1. Apollo /people/match with `reveal_personal_emails=true` (this is
 *      the credit-burning unlock variant — `apolloUnlockPerson`).
 *      - If Apollo returns an email → MillionVerifier.
 *   2. If no email but Apollo returned `last_name`:
 *      - Hunter email-finder with first+last+domain.
 *      - If Hunter returns an email → MillionVerifier.
 *      - Else if a domain pattern is cached at ≥0.7 confidence:
 *          pattern_guess(first, last, pattern) → MillionVerifier.
 *   3. If Apollo returned no `last_name`, skip Hunter finder + pattern
 *      guess (we can't form an email guess without a last name).
 *
 * Emits one event per provider boundary into
 * `brand_contact_discovery_events` keyed by (brand_id, run_id, contact_id).
 *
 * Returns the resolved enrichment fields so callers can persist them
 * on the contact row in one update.
 */
import {
  apolloUnlockPerson,
  mapApolloEmailStatus,
} from "./apollo";
import {
  hunterDomainPattern,
  hunterEmailFinder,
} from "./hunter";
import { verifyEmail, type VerifyResult } from "./email-verify";
import {
  applyEmailPattern,
  readPatternCache,
  writePatternCache,
} from "./pattern";
import { recordDiscoveryEvent } from "./events";

const PATTERN_CONFIDENCE_FLOOR = 0.7;

export type EnrichEmailStatus =
  | "verified"
  | "likely"
  | "risky"
  | "catch_all"
  | "guessed"
  | "bounced"
  | "invalid"
  | "unknown"
  | "not_found"
  | "found";

export type EnrichEmailSource =
  | "apollo"
  | "apollo_match"
  | "apollo_crm"
  | "hunter"
  | "hunter_pattern"
  | "pattern_guess"
  | "manual"
  | "unknown";

export interface EnrichContactInput {
  brand_id: string;
  run_id: string;
  contact_id: string | null;
  domain: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string;
  organization_name: string | null;
  apollo_person_id: string | null;
}

export interface EnrichContactResult {
  email: string | null;
  email_source: EnrichEmailSource;
  email_pattern_used: string | null;
  email_status: EnrichEmailStatus;
  email_verifier: "millionverifier" | "zerobounce" | "none" | null;
  email_verifier_score: number | null;
  email_verified_at: string | null;
  last_name: string | null;
  full_name: string;
  raw_apollo_match: unknown;
  raw_hunter: unknown;
  verify_raw: unknown;
}

function clampScore(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function mapVerifyStatus(s: VerifyResult["status"]): EnrichEmailStatus {
  switch (s) {
    case "verified":
    case "likely":
    case "risky":
    case "catch_all":
    case "invalid":
    case "unknown":
      return s;
    default:
      return "unknown";
  }
}

/**
 * Apollo basic plan returns sentinel values like
 * "email_not_unlocked@domain.com" when the email field is locked. Treat
 * those as no-email so we fall through to Hunter.
 */
export function sanitizeApolloEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = String(input).trim().toLowerCase();
  if (!v) return null;
  if (
    v.startsWith("email_not_unlocked") ||
    v.startsWith("domain_catch_all") ||
    v.includes("not_unlocked@") ||
    v.includes("@domain.com")
  ) {
    return null;
  }
  return v;
}

export async function enrichSingleContact(
  input: EnrichContactInput,
): Promise<EnrichContactResult> {
  const { brand_id, run_id, contact_id, domain } = input;
  const first = (input.first_name ?? "").trim();
  let last = (input.last_name ?? "").trim();
  let fullName = input.full_name;

  let email: string | null = null;
  let email_source: EnrichEmailSource = "unknown";
  let email_pattern_used: string | null = null;
  let raw_apollo_match: unknown = null;
  let raw_hunter: unknown = null;
  let verify: VerifyResult | null = null;
  let emailStatus: EnrichEmailStatus = "not_found";

  // 1. Apollo unlock.
  const unlock = await apolloUnlockPerson({
    domain,
    first_name: first || undefined,
    last_name: last || undefined,
    organization_name: input.organization_name ?? undefined,
    id: input.apollo_person_id ?? undefined,
  });
  if (!unlock.ok) {
    await recordDiscoveryEvent({
      brand_id,
      run_id,
      contact_id,
      provider: "apollo_match",
      outcome:
        unlock.error === "apollo_retry_exhausted" ? "retry_exhausted" : "error",
      reason: `Apollo: /people/match (unlock) failed for ${fullName} at ${domain}: ${unlock.error}`,
      http_status: unlock.status ?? null,
      raw_payload: { error: unlock.error, status: unlock.status ?? null },
    });
  } else {
    raw_apollo_match = unlock.raw;
    if (unlock.person?.last_name && !last) {
      last = unlock.person.last_name.trim();
      if (first && last) fullName = `${first} ${last}`;
    }
    const matchedEmail = sanitizeApolloEmail(unlock.person?.email ?? null);
    const apolloMapped = mapApolloEmailStatus(
      unlock.person?.email_status_raw ?? null,
    );
    if (matchedEmail) {
      email = matchedEmail;
      email_source = "apollo_match";
      emailStatus = apolloMapped === "found" ? "verified" : "guessed";
      await recordDiscoveryEvent({
        brand_id,
        run_id,
        contact_id,
        provider: "apollo_match",
        outcome: "found",
        reason: `Apollo: unlocked ${fullName} at ${domain} → ${matchedEmail} (status=${unlock.person?.email_status_raw ?? "unknown"}).`,
        email_returned: matchedEmail,
        status_returned: unlock.person?.email_status_raw ?? null,
        raw_payload: unlock.raw,
      });
    } else {
      await recordDiscoveryEvent({
        brand_id,
        run_id,
        contact_id,
        provider: "apollo_match",
        outcome: "not_found",
        reason: unlock.person
          ? `Apollo: unlock returned ${fullName} but no email (status=${unlock.person.email_status_raw ?? "null"}); will fall back to Hunter if last_name is available.`
          : `Apollo: no person match for ${fullName} at ${domain}.`,
        status_returned: unlock.person?.email_status_raw ?? null,
        raw_payload: unlock.raw,
      });
    }
  }

  // 2. Hunter email-finder fallback — only if no email yet and we have
  //    a last_name. Without last_name we can't form a finder query or a
  //    pattern guess.
  if (!email) {
    if (first && last) {
      const hf = await hunterEmailFinder({
        domain,
        first_name: first,
        last_name: last,
      });
      raw_hunter = hf.raw;
      if (!hf.ok) {
        await recordDiscoveryEvent({
          brand_id,
          run_id,
          contact_id,
          provider: "hunter_finder",
          outcome: "error",
          reason: `Hunter email-finder failed for ${fullName} at ${domain}: ${hf.error ?? "unknown error"}`,
          raw_payload: hf.raw ?? { error: hf.error ?? null },
        });
      } else if (hf.email) {
        email = hf.email;
        email_source = "hunter";
        email_pattern_used = hf.pattern ?? null;
        await recordDiscoveryEvent({
          brand_id,
          run_id,
          contact_id,
          provider: "hunter_finder",
          outcome: "found",
          reason: `Hunter: ${fullName} → ${hf.email} (pattern ${hf.pattern ?? "n/a"}, score ${hf.score ?? "?"}).`,
          email_returned: hf.email,
          score_returned:
            typeof hf.score === "number" ? clampScore(hf.score / 100) : null,
          raw_payload: hf.raw,
        });
      } else {
        await recordDiscoveryEvent({
          brand_id,
          run_id,
          contact_id,
          provider: "hunter_finder",
          outcome: "not_found",
          reason: `Hunter: no email found for ${fullName} at ${domain}.`,
          raw_payload: hf.raw,
        });
      }
    } else {
      await recordDiscoveryEvent({
        brand_id,
        run_id,
        contact_id,
        provider: "hunter_finder",
        outcome: "skipped",
        reason: `Hunter email-finder skipped for ${fullName} — Apollo unlock returned no last_name, so we can't form a finder query.`,
      });
    }
  } else {
    await recordDiscoveryEvent({
      brand_id,
      run_id,
      contact_id,
      provider: "hunter_finder",
      outcome: "skipped",
      reason: `Hunter email-finder skipped — Apollo unlock already produced ${email} for ${fullName}.`,
    });
  }

  // 3. Pattern-guess fallback (also requires last_name).
  if (!email && first && last) {
    let cache = await readPatternCache(domain);
    if (!cache) {
      const pat = await hunterDomainPattern(domain);
      if (pat.ok) {
        await writePatternCache({
          domain,
          email_pattern: pat.pattern,
          pattern_source: "hunter",
          pattern_confidence: pat.pattern_confidence,
          is_catch_all: pat.is_catch_all,
        });
        cache = await readPatternCache(domain);
        await recordDiscoveryEvent({
          brand_id,
          run_id,
          contact_id,
          provider: "hunter_domain",
          outcome: pat.pattern ? "found" : "not_found",
          reason: pat.pattern
            ? `Hunter: pattern ${pat.pattern} (confidence ${pat.pattern_confidence.toFixed(2)}) for ${domain}.`
            : `Hunter: no email pattern available for ${domain}.`,
          score_returned: clampScore(pat.pattern_confidence),
          raw_payload: pat.raw,
        });
      }
    }
    if (cache?.email_pattern) {
      const conf = cache.pattern_confidence ?? 0;
      if (conf >= PATTERN_CONFIDENCE_FLOOR) {
        const guessed = applyEmailPattern(cache.email_pattern, first, last, domain);
        if (guessed) {
          email = guessed;
          email_source = "pattern_guess";
          email_pattern_used = cache.email_pattern;
          await recordDiscoveryEvent({
            brand_id,
            run_id,
            contact_id,
            provider: "pattern_guess",
            outcome: "found",
            reason: `Pattern guess: applied ${cache.email_pattern} (confidence ${conf.toFixed(2)}) → ${guessed}.`,
            email_returned: guessed,
            score_returned: clampScore(conf),
          });
        } else {
          await recordDiscoveryEvent({
            brand_id,
            run_id,
            contact_id,
            provider: "pattern_guess",
            outcome: "not_found",
            reason: `Pattern guess: pattern ${cache.email_pattern} present but could not synthesize email for ${fullName}.`,
          });
        }
      } else {
        await recordDiscoveryEvent({
          brand_id,
          run_id,
          contact_id,
          provider: "pattern_guess",
          outcome: "skipped",
          reason: `Pattern guess: pattern_confidence ${conf.toFixed(2)} below floor ${PATTERN_CONFIDENCE_FLOOR} — skipped.`,
          score_returned: clampScore(conf),
        });
      }
    } else {
      await recordDiscoveryEvent({
        brand_id,
        run_id,
        contact_id,
        provider: "pattern_guess",
        outcome: "skipped",
        reason: `Pattern guess skipped — no domain pattern available for ${domain}.`,
      });
    }
  } else if (!email) {
    await recordDiscoveryEvent({
      brand_id,
      run_id,
      contact_id,
      provider: "pattern_guess",
      outcome: "skipped",
      reason: `Pattern guess skipped — missing last_name for ${fullName}.`,
    });
  } else {
    await recordDiscoveryEvent({
      brand_id,
      run_id,
      contact_id,
      provider: "pattern_guess",
      outcome: "skipped",
      reason: `Pattern guess skipped — email already resolved via ${email_source}.`,
    });
  }

  // 4. Verify whatever email we have.
  if (email) {
    verify = await verifyEmail(email);
    emailStatus = mapVerifyStatus(verify.status);
    const isMv = verify.verifier === "millionverifier";
    const isZb = verify.verifier === "zerobounce";
    const mvOutcome: "found" | "skipped" = isMv ? "found" : "skipped";
    const mvReason = isMv
      ? `MillionVerifier: ${verify.status}${typeof verify.score === "number" ? ` (score ${verify.score.toFixed(2)})` : ""} for ${email}.`
      : verify.verifier === "none"
        ? `MillionVerifier: skipped — provider unavailable or unconfigured.`
        : `MillionVerifier: ${verify.status === "catch_all" || verify.status === "unknown" ? `returned ${verify.status}, deferred to ZeroBounce` : "skipped"}.`;
    await recordDiscoveryEvent({
      brand_id,
      run_id,
      contact_id,
      provider: "millionverifier",
      outcome: mvOutcome,
      reason: mvReason,
      email_returned: email,
      status_returned: isMv ? verify.status : null,
      score_returned:
        isMv && typeof verify.score === "number" ? clampScore(verify.score) : null,
      raw_payload: isMv ? verify.raw : null,
    });
    const zbOutcome: "found" | "skipped" = isZb ? "found" : "skipped";
    const zbReason = isZb
      ? `ZeroBounce: ${verify.status}${typeof verify.score === "number" ? ` (score ${verify.score.toFixed(2)})` : ""} for ${email}.`
      : isMv
        ? `ZeroBounce: skipped — MillionVerifier returned ${verify.status}.`
        : `ZeroBounce: skipped — no verifier returned a definite result.`;
    await recordDiscoveryEvent({
      brand_id,
      run_id,
      contact_id,
      provider: "zerobounce",
      outcome: zbOutcome,
      reason: zbReason,
      email_returned: email,
      status_returned: isZb ? verify.status : null,
      score_returned:
        isZb && typeof verify.score === "number" ? clampScore(verify.score) : null,
      raw_payload: isZb ? verify.raw : null,
    });
  } else {
    await recordDiscoveryEvent({
      brand_id,
      run_id,
      contact_id,
      provider: "millionverifier",
      outcome: "skipped",
      reason: `MillionVerifier: skipped — no email candidate to verify for ${fullName}.`,
    });
    await recordDiscoveryEvent({
      brand_id,
      run_id,
      contact_id,
      provider: "zerobounce",
      outcome: "skipped",
      reason: `ZeroBounce: skipped — no email candidate to verify for ${fullName}.`,
    });
    await recordDiscoveryEvent({
      brand_id,
      run_id,
      contact_id,
      provider: "orchestrator",
      outcome: "not_found",
      reason: `No email resolved for ${fullName} after Apollo unlock, Hunter, and pattern-guess fallbacks.`,
    });
    emailStatus = "not_found";
  }

  return {
    email,
    email_source: email ? email_source : "unknown",
    email_pattern_used,
    email_status: emailStatus,
    email_verifier: email ? (verify?.verifier ?? "none") : null,
    email_verifier_score:
      email && verify && typeof verify.score === "number" ? verify.score : null,
    email_verified_at: email && verify ? new Date().toISOString() : null,
    last_name: last || null,
    full_name: fullName,
    raw_apollo_match,
    raw_hunter,
    verify_raw: verify?.raw ?? null,
  };
}
