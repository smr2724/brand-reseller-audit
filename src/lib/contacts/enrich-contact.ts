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
  readPatternCache,
  writePatternCache,
} from "./pattern";
import { recordDiscoveryEvent } from "./events";
import { runPatternLoop } from "./pattern-loop";
import { llmWebSearchEmail } from "./llm-websearch";
import { extractApexDomain } from "./domain";

/** Phase 73 — rough constant for one LLM web-search call. Used to
 *  surface cost telemetry both here and in gate-c-seed. */
const LLM_WEBSEARCH_COST_USD = 0.02;

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
  | "hunter_finder"
  | "hunter_pattern"
  | "llm_websearch"
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
  /** Phase 73 — brand name for the LLM web-search prompt. Falls back
   *  to `organization_name` when omitted; the LLM step is skipped if
   *  neither is available. */
  brand_name?: string | null;
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
  /** Phase 73 — extra LLM cost (web-search) attributed to this enrich.
   *  Folded into the parent flow's cost telemetry. 0 when web-search
   *  didn't fire. */
  llm_cost_usd?: number;
  /** Phase 73 — notes (e.g., LLM web-search source URL) for the row. */
  notes?: string | null;
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
  // Phase 73 — track LLM web-search cost so the caller can fold it
  // into the per-brand cost ledger. Notes carries the LLM source URL
  // when a row is materialized from web-search.
  let llm_cost_usd = 0;
  let notes: string | null = null;
  // Phase 73 — when the 8-pattern loop produces only `risky` /
  // `catch_all` results we hold the best one back and try LLM
  // web-search first. If web-search misses too, we fall back to the
  // risky pattern hit (per spec §3b).
  let riskyFallback: {
    email: string;
    status: VerifyResult["status"];
    score: number | null;
    pattern: string;
  } | null = null;
  // Phase 73 — when the pattern loop or LLM web-search already
  // MV-verified the chosen email, skip the redundant MV call in
  // step 4 to avoid double-spending MV credits and double-logging
  // the millionverifier event.
  let alreadyVerifiedStatus: VerifyResult["status"] | null = null;
  let alreadyVerifiedScore: number | null = null;
  // Phase 64 — track Apollo's own verdict separately. If Apollo says
  // "verified", that is the authoritative ground truth: MillionVerifier
  // /  ZeroBounce returning `unknown` later means the verifier is
  // uncertain, NOT that Apollo's answer is wrong. We must NOT downgrade
  // a verified-by-Apollo email to status='unknown' / 'not_found' on the
  // back of an inconclusive verifier. We still persist the verifier
  // score so the operator can see the verifier was inconclusive.
  let apolloVerified = false;
  // Phase 65 — track each verifier's resolved verdict so we can stamp
  // `email_verifier` correctly (millionverifier / zerobounce / none) and
  // surface failed-vs-inconclusive in the UI.
  let finalMvVerdict: "verified" | "inconclusive" | "failed" | "skipped" = "skipped";
  let finalZbVerdict: "verified" | "inconclusive" | "failed" | "skipped" = "skipped";
  // Phase 65 — remember MV's raw status (verified/invalid/risky/catch_all/
  // unknown/null) so the email_verifier cascade can distinguish a
  // truly-decisive MV verdict (verified/invalid/risky) from MV catch_all,
  // which is a definite-but-inconclusive verdict that triggers ZB
  // fallthrough.
  let finalMvStatus: string | null = null;

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
      // Phase 64 — write the constraint-allowed 'apollo' value to
      // brand_contacts.email_source. The DB CHECK declared in migration
      // 0040 does NOT include 'apollo_match', so writing 'apollo_match'
      // here was the root cause of the persistence failure: Postgres
      // rejected the update, leaving email/email_source/last_name as
      // null while the audit events still logged success. The Phase
      // 63 'apollo_match' provider tag survives unchanged on
      // brand_contact_discovery_events (provider CHECK there does
      // allow it) — only the brand_contacts column value moves to the
      // permitted enum.
      email_source = "apollo";
      apolloVerified = apolloMapped === "found";
      emailStatus = apolloVerified ? "verified" : "guessed";
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

  // 3. Phase 73 — 8-pattern email construction loop. Replaces the
  //    Phase 63 cached-pattern_guess step in the per-row enrich path.
  //    Triggers only when Apollo + Hunter-finder didn't produce an
  //    email. Iterates Hunter's recommended pattern (if confidence ≥
  //    0.85, deduped, unrecognized tokens silently skipped) then the
  //    seven canonical patterns. Per-pattern token requirements are
  //    checked (so a `first=Madonna, last=null` candidate can still
  //    try `{first}` / `{f}`). MV-verifies each; STOP on first
  //    `verified`. Diacritics stripped before substitution (NFD +
  //    drop combining marks) so `María` → `maria`.
  //
  //    The apex domain is used for construction — `shop.carna4.com`
  //    becomes `carna4.com` so we don't burn credits on
  //    `maria@shop.carna4.com`. The raw `domain` continues to flow
  //    to Apollo / Hunter providers above (which sometimes accept
  //    subdomains).
  const apexDomain = extractApexDomain(domain) ?? domain;
  if (!email && (first || last)) {
    let recommendedPattern: string | null = null;
    let recommendedConfidence: number | null = null;
    // Read cached pattern (or fetch fresh) so the loop can prioritize
    // Hunter's recommendation when it's high-confidence.
    let cache = await readPatternCache(apexDomain);
    if (!cache) {
      const pat = await hunterDomainPattern(apexDomain);
      if (pat.ok) {
        await writePatternCache({
          domain: apexDomain,
          email_pattern: pat.pattern,
          pattern_source: "hunter",
          pattern_confidence: pat.pattern_confidence,
          is_catch_all: pat.is_catch_all,
        });
        cache = await readPatternCache(apexDomain);
        await recordDiscoveryEvent({
          brand_id,
          run_id,
          contact_id,
          provider: "hunter_domain",
          outcome: pat.pattern ? "found" : "not_found",
          reason: pat.pattern
            ? `Hunter: pattern ${pat.pattern} (confidence ${pat.pattern_confidence.toFixed(2)}) for ${apexDomain}.`
            : `Hunter: no email pattern available for ${apexDomain}.`,
          score_returned: clampScore(pat.pattern_confidence),
          raw_payload: pat.raw,
        });
      }
    }
    recommendedPattern = cache?.email_pattern ?? null;
    recommendedConfidence = cache?.pattern_confidence ?? null;

    const loop = await runPatternLoop(
      {
        first_name: first || null,
        last_name: last || null,
        domain: apexDomain,
        recommended_pattern: recommendedPattern,
        recommended_confidence: recommendedConfidence,
      },
      {
        onAttempt: async (a) => {
          await recordDiscoveryEvent({
            brand_id,
            run_id,
            contact_id,
            provider: "hunter_pattern",
            outcome:
              a.outcome === "verified"
                ? "found"
                : a.outcome === "risky" || a.outcome === "catch_all"
                  ? "found"
                  : "not_found",
            reason: `pattern_loop attempt ${a.pattern} → ${a.email || "(unconstructable)"}: MV=${a.mv_status ?? "error"}`,
            email_returned: a.email || null,
            status_returned: a.mv_status,
            score_returned:
              typeof recommendedConfidence === "number"
                ? recommendedConfidence
                : null,
          });
        },
      },
    );
    // Summary event.
    await recordDiscoveryEvent({
      brand_id,
      run_id,
      contact_id,
      provider: "hunter_pattern",
      outcome:
        loop.best_kind === "valid" || loop.best_kind === "risky"
          ? "found"
          : "not_found",
      reason: `pattern_loop_complete: tried ${loop.attempts.length} patterns; best=${loop.best_email ?? "none"}; best_status=${loop.best_status ?? "none"}`,
      email_returned: loop.best_email,
      status_returned: loop.best_status,
    });
    if (loop.ok && loop.best_kind === "valid" && loop.best_email) {
      email = loop.best_email;
      email_source = "hunter_pattern";
      email_pattern_used = loop.best_pattern;
      alreadyVerifiedStatus = loop.best_status;
      alreadyVerifiedScore = loop.best_score;
    } else if (loop.ok && loop.best_kind === "risky" && loop.best_email) {
      riskyFallback = {
        email: loop.best_email,
        status: (loop.best_status ?? "risky") as VerifyResult["status"],
        score: loop.best_score,
        pattern: loop.best_pattern ?? "",
      };
    }
  } else if (!email) {
    await recordDiscoveryEvent({
      brand_id,
      run_id,
      contact_id,
      provider: "hunter_pattern",
      outcome: "skipped",
      reason: `pattern_loop skipped — neither first_name nor last_name available for ${fullName}.`,
    });
  } else {
    await recordDiscoveryEvent({
      brand_id,
      run_id,
      contact_id,
      provider: "hunter_pattern",
      outcome: "skipped",
      reason: `pattern_loop skipped — email already resolved via ${email_source}.`,
    });
  }

  // 3b. Phase 73 — LLM web-search last resort. Fires when Apollo +
  //     Hunter-finder + 8-pattern loop all miss (or only produced
  //     risky), AND we have at least full_name + brand_name. Uses
  //     the OpenAI Responses API with the web_search tool and the
  //     verbatim Phase 73 prompt. The result is MV-verified inside
  //     llmWebSearchEmail's downstream verify; here we MV-verify
  //     once after writing the candidate.
  const brandNameForSearch =
    (input.brand_name ?? "").trim() ||
    (input.organization_name ?? "").trim();
  if (!email && first && last && fullName && brandNameForSearch) {
    let websearch;
    try {
      websearch = await llmWebSearchEmail({
        full_name: fullName,
        brand_name: brandNameForSearch,
      });
    } catch (e) {
      websearch = {
        email: null,
        source_url: null,
        confidence: "none" as const,
        error: e instanceof Error ? e.message : String(e),
        raw_text: null,
      };
    }
    llm_cost_usd += LLM_WEBSEARCH_COST_USD;
    if (websearch.email) {
      // Phase 73.1 — MV-verify the LLM-returned email BEFORE writing
      // it to brand_contacts.
      //
      // Two cases:
      //   (a) MV says verified/risky/catch_all → we set `email` here
      //       so step 4 short-circuits via `alreadyVerifiedStatus`,
      //       AND step 4 emits its own provider='millionverifier'
      //       event with the same verdict. So we DO NOT emit a
      //       millionverifier event here — it would duplicate.
      //   (b) MV says invalid (or anything else that doesn't lift
      //       to `email`) → step 4 won't run with this LLM email,
      //       so there is NO downstream MV event. We emit a
      //       millionverifier event here so the invariant "no
      //       LLM-sourced email skipped by MV without an
      //       MV audit row" holds.
      //
      // Use try/catch (not .catch) so a verifyEmail throw doesn't
      // get swallowed silently — surface it via an error event.
      let v: Awaited<ReturnType<typeof verifyEmail>> | null = null;
      let verifyError: string | null = null;
      try {
        v = await verifyEmail(websearch.email);
      } catch (e) {
        verifyError = e instanceof Error ? e.message : String(e);
      }
      const mvStatus = v?.status ?? "unknown";
      const mvScore =
        typeof v?.score === "number" ? clampScore(v.score) : null;
      const isVerified = mvStatus === "verified";
      const isRisky = mvStatus === "risky" || mvStatus === "catch_all";
      await recordDiscoveryEvent({
        brand_id,
        run_id,
        contact_id,
        provider: "llm_websearch",
        outcome:
          isVerified || isRisky
            ? "found"
            : mvStatus === "invalid"
              ? "not_found"
              : "skipped",
        reason: `llm_websearch found ${websearch.email} (confidence=${websearch.confidence}); MV=${mvStatus}${verifyError ? ` (MV error: ${verifyError})` : ""}`,
        email_returned: websearch.email,
        status_returned: mvStatus,
        raw_payload: {
          source_url: websearch.source_url,
          confidence: websearch.confidence,
        },
      });
      if (isVerified || isRisky) {
        // Case (a) — lift email and let step 4 emit the MV event.
        email = websearch.email;
        email_source = "llm_websearch";
        email_pattern_used = null;
        notes = `Found via LLM web search; source: ${websearch.source_url ?? "(no URL)"}`;
        alreadyVerifiedStatus = mvStatus;
        alreadyVerifiedScore = typeof v?.score === "number" ? v.score : null;
      } else {
        // Case (b) — MV rejected (invalid) OR verifyEmail threw OR
        // MV returned unknown for the LLM email. Step 4 won't run
        // with this email; emit an explicit millionverifier audit
        // event here so the invariant holds.
        await recordDiscoveryEvent({
          brand_id,
          run_id,
          contact_id,
          provider: "millionverifier",
          outcome: verifyError
            ? "error"
            : mvStatus === "invalid"
              ? "not_found"
              : "skipped",
          reason: verifyError
            ? `MillionVerifier gate (llm_websearch) error: ${verifyError}`
            : `MillionVerifier gate (llm_websearch): ${mvStatus} for ${websearch.email}`,
          email_returned: websearch.email,
          status_returned: verifyError ? null : mvStatus,
          score_returned: mvScore,
          raw_payload: v?.raw ?? null,
        });
      }
    } else {
      await recordDiscoveryEvent({
        brand_id,
        run_id,
        contact_id,
        provider: "llm_websearch",
        outcome: websearch.error ? "error" : "not_found",
        reason: websearch.error
          ? `llm_websearch error: ${websearch.error}`
          : `llm_websearch found no public email for ${fullName} at ${brandNameForSearch}`,
      });
    }
  } else if (!email) {
    await recordDiscoveryEvent({
      brand_id,
      run_id,
      contact_id,
      provider: "llm_websearch",
      outcome: "skipped",
      reason: brandNameForSearch
        ? `llm_websearch skipped — need full first+last+full_name for ${fullName}.`
        : `llm_websearch skipped — no brand_name available.`,
    });
  }

  // 3c. Phase 73 — fall back to best-risky pattern hit when LLM
  //     web-search didn't improve on it.
  if (!email && riskyFallback) {
    email = riskyFallback.email;
    email_source = "hunter_pattern";
    email_pattern_used = riskyFallback.pattern;
    alreadyVerifiedStatus = riskyFallback.status;
    alreadyVerifiedScore = riskyFallback.score;
  }

  // 4. Verify whatever email we have.
  if (email) {
    // Phase 73 — skip the redundant MV call when the pattern loop or
    // LLM web-search already MV-verified this exact email. We fabricate
    // a `verify` shape that matches the millionverifier branch so the
    // downstream classification + event-logging behaves identically.
    if (alreadyVerifiedStatus) {
      verify = {
        status: alreadyVerifiedStatus,
        verifier: "millionverifier",
        score: alreadyVerifiedScore ?? undefined,
        raw: { source: "phase73_already_verified" },
        mv_status: alreadyVerifiedStatus,
        mv_raw: { source: "phase73_already_verified" },
      } as VerifyResult;
    } else {
      verify = await verifyEmail(email);
    }
    const verifierStatus = mapVerifyStatus(verify.status);
    // Phase 64 — don't downgrade an Apollo-verified email to
    // 'unknown' / 'not_found' just because the verifier was
    // inconclusive. If Apollo said 'verified', keep emailStatus
    // 'verified' (we still persist the verifier score so the operator
    // can see the verifier disagreed). If Apollo said 'guessed', keep
    // 'guessed' on inconclusive verifier — but a definite negative
    // verifier verdict (invalid / risky) DOES override Apollo's
    // optimism. catch_all / unknown are inconclusive and must not
    // downgrade.
    const verifierIsDefiniteNegative =
      verify.status === "invalid" || verify.status === "risky";
    const verifierIsInconclusive =
      verify.status === "unknown" ||
      verify.status === "catch_all" ||
      verify.verifier === "none";
    if (verifierIsDefiniteNegative) {
      emailStatus = verifierStatus;
    } else if (apolloVerified && verifierIsInconclusive) {
      // Keep emailStatus = 'verified' from Apollo.
    } else if (apolloVerified) {
      // Verifier returned 'verified' / 'likely' — still verified.
      emailStatus = "verified";
    } else {
      // Apollo wasn't a definite verified, defer to the verifier
      // (but its 'unknown' just means 'guessed', not 'not_found').
      emailStatus = verifierIsInconclusive ? "guessed" : verifierStatus;
    }
    // Phase 65 — classify each provider's run as one of:
    //   verified     — provider returned a definite verdict (verified /
    //                  invalid / risky / catch_all)
    //   inconclusive — provider ran fine but verdict was 'unknown' or
    //                  the request fell through (status undefined)
    //   failed       — provider-level error (HTTP / auth / Apikey not
    //                  found / network). Stamped as outcome='error'
    //                  with verbatim error message in `reason`.
    //   skipped      — provider was not called (no key, or short-circuit)
    const isMv = verify.verifier === "millionverifier";
    const isZb = verify.verifier === "zerobounce";
    // MV "ran" if it was the authoritative verifier OR if its raw / status
    // were forwarded after ZB ended up authoritative.
    const mvRan =
      isMv ||
      verify.mv_raw != null ||
      verify.mv_status !== undefined ||
      verify.mv_error !== undefined;
    const mvErrorMsg = isMv ? verify.error : verify.mv_error;
    const mvStatus = isMv ? verify.status : (verify.mv_status ?? null);
    const mvRawPayload = isMv ? verify.raw : (verify.mv_raw ?? null);
    let mvOutcome: "found" | "skipped" | "error" = "skipped";
    let mvReason: string;
    let mvVerdict: "verified" | "inconclusive" | "failed" | "skipped";
    if (!mvRan) {
      mvOutcome = "skipped";
      mvVerdict = "skipped";
      mvReason = verify.verifier === "none"
        ? `MillionVerifier: skipped — provider unavailable or unconfigured.`
        : `MillionVerifier: skipped.`;
    } else if (mvErrorMsg) {
      mvOutcome = "error";
      mvVerdict = "failed";
      mvReason = `${mvErrorMsg} — falling through to ZeroBounce.`;
    } else if (mvStatus === "verified" || mvStatus === "invalid" || mvStatus === "risky" || mvStatus === "catch_all") {
      mvOutcome = "found";
      mvVerdict = "verified";
      const definitiveSuffix = isZb ? "; fell through to ZeroBounce" : "";
      const scoreSuffix = isMv && typeof verify.score === "number"
        ? ` (score ${verify.score.toFixed(2)})`
        : "";
      mvReason = `MillionVerifier: ${mvStatus} for ${email}${scoreSuffix}${definitiveSuffix}.`;
    } else {
      mvOutcome = "found";
      mvVerdict = "inconclusive";
      mvReason = `MillionVerifier: ${mvStatus ?? "unknown"} (inconclusive) for ${email}; fell through to ZeroBounce.`;
    }
    await recordDiscoveryEvent({
      brand_id,
      run_id,
      contact_id,
      provider: "millionverifier",
      outcome: mvOutcome,
      reason: mvReason,
      email_returned: email,
      // Phase 65 — status_returned is null when the provider failed
      // (it's not a verdict; the failure message is in `reason`).
      status_returned: mvErrorMsg ? null : mvStatus,
      score_returned:
        isMv && !mvErrorMsg && typeof verify.score === "number"
          ? clampScore(verify.score)
          : null,
      // Phase 64 — persist the MV raw payload regardless of which
      // verifier ended up authoritative. We need this to debug the
      // "MV returns unknown for everything" symptom from prod.
      raw_payload: mvRawPayload,
    });
    // ZB classification mirrors MV.
    const zbRan = isZb;
    const zbErrorMsg = isZb ? verify.error : undefined;
    let zbOutcome: "found" | "skipped" | "error" = "skipped";
    let zbReason: string;
    let zbVerdict: "verified" | "inconclusive" | "failed" | "skipped";
    if (!zbRan) {
      zbOutcome = "skipped";
      zbVerdict = "skipped";
      if (mvVerdict === "verified") {
        zbReason = `ZeroBounce: skipped — MillionVerifier returned a definite verdict (${mvStatus}).`;
      } else if (mvVerdict === "skipped") {
        zbReason = `ZeroBounce: skipped — provider unavailable or unconfigured.`;
      } else {
        zbReason = `ZeroBounce: skipped — provider unavailable or unconfigured.`;
      }
    } else if (zbErrorMsg) {
      zbOutcome = "error";
      zbVerdict = "failed";
      zbReason = `${zbErrorMsg}.`;
    } else if (verify.status === "verified" || verify.status === "invalid" || verify.status === "risky" || verify.status === "catch_all") {
      zbOutcome = "found";
      zbVerdict = "verified";
      const scoreSuffix = typeof verify.score === "number"
        ? ` (score ${verify.score.toFixed(2)})`
        : "";
      zbReason = `ZeroBounce: ${verify.status}${scoreSuffix} for ${email}.`;
    } else {
      zbOutcome = "found";
      zbVerdict = "inconclusive";
      zbReason = `ZeroBounce: ${verify.status} (inconclusive) for ${email}.`;
    }
    await recordDiscoveryEvent({
      brand_id,
      run_id,
      contact_id,
      provider: "zerobounce",
      outcome: zbOutcome,
      reason: zbReason,
      email_returned: email,
      status_returned: isZb && !zbErrorMsg ? verify.status : null,
      score_returned:
        isZb && !zbErrorMsg && typeof verify.score === "number"
          ? clampScore(verify.score)
          : null,
      raw_payload: isZb ? verify.raw : null,
    });
    // Stash for the return value.
    finalMvVerdict = mvVerdict;
    finalZbVerdict = zbVerdict;
    finalMvStatus = mvStatus ?? null;
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

  // Phase 65 — `email_verifier` names the provider whose verdict
  // MATERIALLY shaped the final `email_status` on this row:
  //   - 'millionverifier' if MV returned a decisive verdict
  //     (verified/likely/risky/invalid) AND ZB therefore short-circuited.
  //     MV `catch_all` does NOT qualify — it's a definite-but-inconclusive
  //     verdict that triggers ZB fallthrough; if ZB runs, ZB owns it.
  //   - 'zerobounce' if ZB ran and produced any verdict (definite or
  //     inconclusive). When MV was catch_all / inconclusive / failed and
  //     ZB ran, ZB is authoritative.
  //   - 'none' otherwise: no verifier produced a verdict that materially
  //     decided email_status (Apollo's verdict, if any, is preserved).
  //     Covers: MV failed + ZB skipped/failed; MV inconclusive + ZB
  //     skipped/failed; MV catch_all + ZB skipped/failed.
  //   - null if no email was resolved (nothing to verify).
  const mvWasDecisive =
    finalMvVerdict === "verified" &&
    finalMvStatus !== "catch_all" &&
    finalMvStatus !== "unknown" &&
    finalMvStatus !== null;
  let emailVerifierStamp: "millionverifier" | "zerobounce" | "none" | null = null;
  if (email) {
    if (mvWasDecisive && finalZbVerdict === "skipped") {
      emailVerifierStamp = "millionverifier";
    } else if (finalZbVerdict === "verified" || finalZbVerdict === "inconclusive") {
      emailVerifierStamp = "zerobounce";
    } else {
      emailVerifierStamp = "none";
    }
  }

  return {
    email,
    email_source: email ? email_source : "unknown",
    email_pattern_used,
    email_status: emailStatus,
    email_verifier: emailVerifierStamp,
    email_verifier_score:
      email && verify && typeof verify.score === "number" ? verify.score : null,
    email_verified_at: email && verify ? new Date().toISOString() : null,
    last_name: last || null,
    full_name: fullName,
    raw_apollo_match,
    raw_hunter,
    verify_raw: verify?.raw ?? null,
    llm_cost_usd,
    notes,
  };
}
