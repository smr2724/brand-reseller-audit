/**
 * Phase 71 — Seed Apollo/Hunter contact enrichment with the Gate C
 * named decision-maker.
 *
 * When Gate C (Phase 68) named a specific human at the controlling
 * entity AND captured at least their first+last name, that person is the
 * highest-confidence seed for Contact Discovery/Strategy enrichment —
 * not the heuristic founder/CEO title scan. Carna4 surfaced the bug:
 * Gate C had "Maria Rapp — President" with a LinkedIn URL on file and
 * we were still title-scanning for founder/CEO/president/owner without
 * looking at her.
 *
 * Lookup order:
 *   1. Apollo `/v1/people/match` keyed on linkedin_url (when present).
 *   2. Apollo `/v1/mixed_people/search` seeded with the Gate C title
 *      and the person's first+last name as q_keywords.
 *   3. Hunter `/v2/email-finder` with first_name+last_name+domain.
 *   4. Full miss → caller surfaces NEEDS_HUMAN_REVIEW with the spec
 *      copy. Do NOT silently fall back to a generic CEO/founder scan.
 */
import {
  apolloPeopleMatchByLinkedIn,
  apolloMixedPeopleSearch,
} from "./apollo-mixed-search";
import { hunterEmailFinder, hunterDomainPattern } from "./hunter";
import { verifyLinkedInUrl } from "./linkedin-verify";
import { verifyEmail } from "./email-verify";
import { runPatternLoop, type PatternAttempt } from "./pattern-loop";
import { llmWebSearchEmail } from "./llm-websearch";
import type { ApolloPerson } from "./strategy-types";

export interface GateCPersonSeed {
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  linkedin_url: string | null;
}

export type GateCHitProvider =
  | "apollo_linkedin_match"
  | "apollo_mixed_search"
  | "hunter_finder"
  | "hunter_pattern"
  | "llm_websearch";

export type GateCSeedProvider = GateCHitProvider | "needs_review";

export interface GateCSeedHit {
  provider: GateCHitProvider;
  /** Apollo-shaped person record (slimmed). `email` populated when the
   *  provider returned an email; the caller is still responsible for
   *  MillionVerifier verification. */
  person: ApolloPerson;
  /** Internal email_source value for brand_contacts. Mirrors the widened
   *  CHECK constraint in migration 0053. */
  email_source:
    | "apollo_linkedin_match"
    | "apollo_match"
    | "hunter"
    | "hunter_pattern"
    | "llm_websearch"
    | "unknown";
  cost_credits: number;
  hunter_cost_usd: number;
  /** Phase 72/73 — set when the email came from the Hunter pattern-
   *  construction fallback OR the 8-pattern loop. Lets the orchestrator
   *  stamp email_verifier='millionverifier' / email_status='verified'
   *  or 'risky' on the brand_contacts row without recomputing here. */
  hunter_pattern_meta?: {
    pattern: string;
    constructed_email: string;
    mv_status: string;
    is_primary: boolean;
    notes: string;
  };
  /** Phase 73 — set when the email came from the LLM web-search
   *  last-resort. `source_url` is the citation the model returned;
   *  the orchestrator stamps it into brand_contacts.notes. */
  llm_websearch_meta?: {
    source_url: string | null;
    confidence: "high" | "medium" | "low";
    mv_status: string;
    is_primary: boolean;
    notes: string;
  };
}

export interface GateCSeedMiss {
  provider: "needs_review";
  person: null;
  email_source: "unknown";
  cost_credits: number;
  hunter_cost_usd: number;
  /** Free-text reason ("Gate C identified X (Y), but ..."). */
  reason: string;
}

export type GateCSeedResult = GateCSeedHit | GateCSeedMiss;

/**
 * Inputs the caller already has on hand. The Gate C `person` carries the
 * authoritative name + title + LinkedIn URL from the qualification step.
 */
export interface GateCSeedInput {
  person: GateCPersonSeed;
  brand_name: string;
  /** Controlling-entity domain (preferred). May be null for brands whose
   *  Phase 68 hierarchy resolver didn't capture a domain. */
  domain: string | null;
}

/**
 * `apolloSearch` defaults to the real mixed_people/search wrapper.
 * `apolloMatch` defaults to the real people/match wrapper.
 * `hunterFinder` defaults to the real Hunter email-finder.
 * Tests inject stubs.
 */
export interface GateCSeedDeps {
  apolloMatch?: typeof apolloPeopleMatchByLinkedIn;
  apolloSearch?: typeof apolloMixedPeopleSearch;
  hunterFinder?: typeof hunterEmailFinder;
  /** Phase 72 — HEAD-verify Gate C's LinkedIn URL before passing it to
   *  Apollo. Defaults to the real network impl; tests inject a stub. */
  verifyLinkedIn?: typeof verifyLinkedInUrl;
  /** Phase 72 — Hunter domain-search wrapper (pattern lookup). */
  hunterDomain?: typeof hunterDomainPattern;
  /** Phase 72 — MillionVerifier wrapper used to verify the constructed
   *  pattern email before we write a brand_contacts row. */
  verifyEmail?: typeof verifyEmail;
  /** Phase 72 — optional event-logging hook. Lets the orchestrator
   *  surface `linkedin_verify` events into the discovery audit trail
   *  without coupling this helper to the events table directly. */
  onLinkedInVerify?: (info: {
    raw_url: string;
    normalized: string | null;
    ok: boolean;
    reason: "reachable" | "rate_limited" | "not_found" | "timeout" | "malformed";
  }) => Promise<void>;
  /** Phase 72 — optional event-logging hook for hunter_pattern outcomes
   *  (construct + MV-verify). Phase 73 — also fires per-attempt during
   *  the 8-pattern fallback loop. */
  onHunterPattern?: (info: {
    pattern: string | null;
    pattern_confidence: number | null;
    constructed_email: string | null;
    mv_status: string | null;
    outcome: "found" | "not_found" | "skipped";
    reason: string;
  }) => Promise<void>;
  /** Phase 73 — pluggable web-search call. Tests inject a stub. */
  llmWebSearch?: typeof llmWebSearchEmail;
  /** Phase 73 — event-logging hook for the LLM web-search step. */
  onLlmWebSearch?: (info: {
    email: string | null;
    source_url: string | null;
    confidence: "high" | "medium" | "low" | "none";
    mv_status: string | null;
    outcome: "found" | "not_found" | "skipped" | "error";
    reason: string;
  }) => Promise<void>;
}

function deriveName(p: GateCPersonSeed): { first: string; last: string; full: string } {
  let first = (p.first_name ?? "").trim();
  let last = (p.last_name ?? "").trim();
  const full = (p.full_name ?? "").trim();
  if ((!first || !last) && full) {
    const parts = full.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      if (!first) first = parts[0];
      if (!last) last = parts.slice(1).join(" ");
    } else if (parts.length === 1 && !first) {
      first = parts[0];
    }
  }
  return { first, last, full: full || `${first} ${last}`.trim() };
}

/**
 * Phase 71 — defensive LinkedIn URL normalization. Gate C can land a URL
 * like `linkedin.com/in/foo` without a scheme; Apollo rejects schemeless
 * URLs silently and we'd miss the high-precision match. Trims, strips
 * trailing slashes, prepends https:// when no scheme is present.
 */
function normalizeLinkedInUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, "")}`;
  return s;
}

export async function seedFromGateC(
  input: GateCSeedInput,
  deps: GateCSeedDeps = {},
): Promise<GateCSeedResult> {
  const apolloMatch = deps.apolloMatch ?? apolloPeopleMatchByLinkedIn;
  const apolloSearch = deps.apolloSearch ?? apolloMixedPeopleSearch;
  const hunterFinder = deps.hunterFinder ?? hunterEmailFinder;
  const verifyLinkedIn = deps.verifyLinkedIn ?? verifyLinkedInUrl;

  const { first, last, full } = deriveName(input.person);
  const title = input.person.title?.trim() ?? null;
  const linkedinRaw = normalizeLinkedInUrl(input.person.linkedin_url);
  let cost_credits = 0;
  let hunter_cost_usd = 0;

  // Phase 72 — HEAD-verify the Gate C LinkedIn URL before passing it
  // to Apollo. Gate C's LLM is reliable on the *name* but routinely
  // hallucinates the slug; sending a bogus URL to Apollo wastes a
  // credit and (worse) silently misses real people.
  let linkedinUrl: string | null = null;
  if (linkedinRaw) {
    const check = await verifyLinkedIn(linkedinRaw);
    if (deps.onLinkedInVerify) {
      try {
        await deps.onLinkedInVerify({
          raw_url: linkedinRaw,
          normalized: check.normalized,
          ok: check.ok,
          reason: check.reason,
        });
      } catch {
        /* never block seed on event-log */
      }
    }
    if (check.ok) {
      linkedinUrl = check.normalized;
    }
  }

  // 1. Apollo /people/match.
  //
  // Phase 72 — call /people/match even when LinkedIn verification
  // failed, as long as we have first_name + last_name +
  // organization_name. Apollo accepts the name+org triple as a valid
  // matching signal.
  //
  // Spec §3b: "If /people/match returns a hit *with an email*, write it."
  // The "with an email" clause is load-bearing — Apollo commonly returns
  // a person record with `email=null` on plans/regions without reveal
  // permission. Treating that as a hit poisoned the pipeline: we'd
  // write a brand_contacts row with email=null, mark contacts_state
  // 'complete', skip the mixed_people/search + Hunter fallbacks, and
  // never surface NEEDS_HUMAN_REVIEW. Gate the early return on an
  // actual email being present; otherwise fall through.
  const hasNameTriple = !!first && !!last && !!input.brand_name;
  if (linkedinUrl || hasNameTriple) {
    const m = await apolloMatch({
      linkedin_url: linkedinUrl, // may be null when verification failed
      first_name: first || undefined,
      last_name: last || undefined,
      organization_name: input.brand_name || null,
    });
    cost_credits += m.cost_credits;
    const emailMatched =
      m.ok && m.person && typeof m.person.email === "string"
        ? m.person.email.trim()
        : "";
    if (m.ok && m.person && emailMatched.length > 0) {
      return {
        provider: "apollo_linkedin_match",
        person: {
          id: m.person.id,
          first_name: m.person.first_name ?? first ?? null,
          last_name: m.person.last_name ?? last ?? null,
          name: m.person.name ?? full ?? null,
          title: m.person.title ?? title,
          linkedin_headline: m.person.linkedin_headline ?? null,
          linkedin_url: m.person.linkedin_url ?? linkedinUrl,
          seniority: m.person.seniority ?? null,
          department: m.person.department ?? null,
          email: emailMatched,
          email_status: m.person.email_status ?? null,
          organization_id: m.person.organization_id ?? null,
          organization_name: m.person.organization_name ?? null,
          organization_domain: m.person.organization_domain ?? input.domain,
        },
        email_source: "apollo_linkedin_match",
        cost_credits,
        hunter_cost_usd,
      };
    }
  }

  // 2. Apollo mixed_people/search seeded with Gate C title + name.
  if (input.domain || first || last) {
    const titlesArr = title ? [title] : [];
    const keywords = [first, last].filter(Boolean).join(" ").trim();
    const s = await apolloSearch({
      q_organization_domains: input.domain ? [input.domain] : [],
      person_titles: titlesArr,
      q_keywords: keywords || undefined,
      per_page: 25,
    });
    cost_credits += s.cost_credits;
    if (s.ok && s.candidates.length > 0) {
      // Phase 71 — require a name-equality match to avoid the
      // wrong-person bug (e.g. picking the VP of Sales as a fallback
      // for "President Maria Rapp"). Drop the `?? s.candidates[0]`
      // silent fallback; if no candidate matches by name, fall through
      // to Hunter.
      const wantFull = full.toLowerCase();
      const wantFirst = first.toLowerCase();
      const wantLast = last.toLowerCase();
      const match = s.candidates.find((c) => {
        const cf = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim().toLowerCase();
        const cn = (c.name ?? "").trim().toLowerCase();
        return (
          (cf && cf === wantFull) ||
          (cn && cn === wantFull) ||
          (wantFirst &&
            wantLast &&
            (c.first_name ?? "").trim().toLowerCase() === wantFirst &&
            (c.last_name ?? "").trim().toLowerCase() === wantLast)
        );
      });
      if (match) {
        return {
          provider: "apollo_mixed_search",
          person: match,
          email_source: match.email ? "apollo_match" : "unknown",
          cost_credits,
          hunter_cost_usd,
        };
      }
    }
  }

  // 3. Hunter email-finder. Requires first+last+domain.
  if (first && last && input.domain) {
    const h = await hunterFinder({
      domain: input.domain,
      first_name: first,
      last_name: last,
    });
    hunter_cost_usd += 0.07;
    if (h.ok && h.email) {
      return {
        provider: "hunter_finder",
        person: {
          id: `hunter:${full}`,
          first_name: first || null,
          last_name: last || null,
          name: full || null,
          title,
          linkedin_headline: null,
          linkedin_url: linkedinUrl,
          seniority: null,
          department: null,
          email: h.email,
          email_status: "unverified",
          organization_id: null,
          organization_name: null,
          organization_domain: input.domain,
        },
        email_source: "hunter",
        cost_credits,
        hunter_cost_usd,
      };
    }
  }

  // 4. Phase 73 — 8-pattern email construction loop.
  //
  // Replaces Phase 72's single-recommended-pattern fallback. When all
  // upstream providers miss we iterate through Hunter's recommended
  // pattern (if confidence ≥ 0.85, deduped) plus the seven canonical
  // patterns, MV-verifying each one. STOP on the first MV=verified
  // result. If only risky/catch_all results come back, keep the best
  // one as a fallback (is_primary=false). If every attempt is invalid
  // (or errors), fall through to LLM web-search.
  //
  // Cost ceiling: 8 MV calls × ~$0.0008 = $0.0064/brand. Trivial.
  const hunterDomain = deps.hunterDomain ?? hunterDomainPattern;
  const runVerifyForLoop = deps.verifyEmail ?? verifyEmail;
  let recommendedPattern: string | null = null;
  let recommendedConfidence: number | null = null;
  let patternLoopRan = false;
  let loopBestKind: "valid" | "risky" | "invalid" | "none" = "none";
  let loopRiskyMeta: {
    pattern: string;
    constructed_email: string;
    mv_status: string;
    notes: string;
  } | null = null;
  if (first && last && input.domain) {
    // Pull Hunter's recommended pattern (best-effort; loop runs even
    // when Hunter has no recommendation — per spec §3e).
    try {
      const pat = await hunterDomain(input.domain);
      hunter_cost_usd += 0.04;
      recommendedPattern = pat.pattern ?? null;
      recommendedConfidence =
        typeof pat.pattern_confidence === "number" ? pat.pattern_confidence : null;
    } catch {
      /* loop runs anyway */
    }

    const loop = await runPatternLoop(
      {
        first_name: first,
        last_name: last,
        domain: input.domain,
        recommended_pattern: recommendedPattern,
        recommended_confidence: recommendedConfidence,
      },
      {
        verifyEmail: runVerifyForLoop,
        onAttempt: async (a: PatternAttempt) => {
          if (!deps.onHunterPattern) return;
          await safe(() =>
            deps.onHunterPattern!({
              pattern: a.pattern,
              pattern_confidence: recommendedConfidence,
              constructed_email: a.email || null,
              mv_status: a.mv_status,
              outcome:
                a.outcome === "verified"
                  ? "found"
                  : a.outcome === "risky" || a.outcome === "catch_all"
                    ? "found"
                    : "not_found",
              reason: `pattern_loop attempt ${a.pattern} → ${a.email || "(unconstructable)"}: MV=${a.mv_status ?? "error"}`,
            }),
          );
        },
      },
    );
    patternLoopRan = true;
    loopBestKind = loop.best_kind;

    // Summary event so audit trail records what the loop tried.
    if (deps.onHunterPattern) {
      await safe(() =>
        deps.onHunterPattern!({
          pattern: loop.best_pattern,
          pattern_confidence: recommendedConfidence,
          constructed_email: loop.best_email,
          mv_status: loop.best_status,
          outcome:
            loop.best_kind === "valid" || loop.best_kind === "risky"
              ? "found"
              : "not_found",
          reason: `pattern_loop_complete: tried ${loop.attempts.length} patterns; best=${loop.best_email ?? "none"}; best_status=${loop.best_status ?? "none"}`,
        }),
      );
    }

    if (loop.ok && loop.best_kind === "valid" && loop.best_email) {
      const notes = `Constructed via 8-pattern loop (${loop.best_pattern}); MV=verified`;
      return {
        provider: "hunter_pattern",
        person: {
          id: `hunter_pattern:${full}`,
          first_name: first || null,
          last_name: last || null,
          name: full || null,
          title,
          linkedin_headline: null,
          linkedin_url: linkedinUrl,
          seniority: null,
          department: null,
          email: loop.best_email,
          email_status: "verified",
          organization_id: null,
          organization_name: null,
          organization_domain: input.domain,
        },
        email_source: "hunter_pattern",
        cost_credits,
        hunter_cost_usd,
        hunter_pattern_meta: {
          pattern: loop.best_pattern ?? "",
          constructed_email: loop.best_email,
          mv_status: "verified",
          is_primary: true,
          notes,
        },
      };
    }
    if (loop.ok && loop.best_kind === "risky" && loop.best_email) {
      // Defer returning the risky row — give LLM web-search a shot
      // first. If web-search misses too, we return this risky fallback.
      loopRiskyMeta = {
        pattern: loop.best_pattern ?? "",
        constructed_email: loop.best_email,
        mv_status: loop.best_status ?? "risky",
        notes: `Constructed via 8-pattern loop (${loop.best_pattern}); MV=${loop.best_status ?? "risky"}`,
      };
    }
  }

  // 5. Phase 73 — LLM web-search last resort.
  //
  // Fires when Apollo + Hunter-finder + 8-pattern all miss for a
  // Gate-C-named candidate. Calls OpenAI Responses API with the
  // web_search tool. If a high-confidence published email is found,
  // MV-verify it and write either a verified-primary row or a risky
  // fallback row.
  if (first && last && full && input.brand_name) {
    const websearchFn = deps.llmWebSearch ?? llmWebSearchEmail;
    let websearchResult;
    try {
      websearchResult = await websearchFn({
        full_name: full,
        brand_name: input.brand_name,
      });
    } catch (e) {
      websearchResult = {
        email: null,
        source_url: null,
        confidence: "none" as const,
        error: e instanceof Error ? e.message : String(e),
        raw_text: null,
      };
    }
    if (websearchResult.email) {
      // Verify the LLM-claimed email.
      const v = await runVerifyForLoop(websearchResult.email).catch(() => null);
      const mvStatus = v?.status ?? "unknown";
      const isVerified = mvStatus === "verified";
      const isRisky = mvStatus === "risky" || mvStatus === "catch_all";
      if (deps.onLlmWebSearch) {
        await safe(() =>
          deps.onLlmWebSearch!({
            email: websearchResult.email,
            source_url: websearchResult.source_url,
            confidence: websearchResult.confidence,
            mv_status: mvStatus,
            outcome:
              isVerified || isRisky
                ? "found"
                : mvStatus === "invalid"
                  ? "not_found"
                  : "skipped",
            reason: `llm_websearch found ${websearchResult.email} (confidence=${websearchResult.confidence}); MV=${mvStatus}`,
          }),
        );
      }
      if (isVerified || isRisky) {
        const conf =
          websearchResult.confidence === "high" ||
          websearchResult.confidence === "medium" ||
          websearchResult.confidence === "low"
            ? websearchResult.confidence
            : "low";
        const notes = `Found via LLM web search; source: ${websearchResult.source_url ?? "(no URL)"}`;
        return {
          provider: "llm_websearch",
          person: {
            id: `llm_websearch:${full}`,
            first_name: first || null,
            last_name: last || null,
            name: full || null,
            title,
            linkedin_headline: null,
            linkedin_url: linkedinUrl,
            seniority: null,
            department: null,
            email: websearchResult.email,
            email_status: isVerified ? "verified" : "risky",
            organization_id: null,
            organization_name: null,
            organization_domain: input.domain,
          },
          email_source: "llm_websearch",
          cost_credits,
          hunter_cost_usd,
          llm_websearch_meta: {
            source_url: websearchResult.source_url,
            confidence: conf,
            mv_status: mvStatus,
            is_primary: isVerified,
            notes,
          },
        };
      }
      // MV=invalid → fall through.
    } else if (deps.onLlmWebSearch) {
      await safe(() =>
        deps.onLlmWebSearch!({
          email: null,
          source_url: null,
          confidence: websearchResult.confidence,
          mv_status: null,
          outcome: websearchResult.error ? "error" : "not_found",
          reason: websearchResult.error
            ? `llm_websearch error: ${websearchResult.error}`
            : `llm_websearch found no public email for ${full} at ${input.brand_name}`,
        }),
      );
    }
  }

  // 6. Fall back to best risky pattern hit if the loop produced one
  //    and web-search did not improve on it. Phase 73 §3b: "If MV
  //    returns only `risky` results, keep the best risky as fallback".
  if (loopRiskyMeta) {
    return {
      provider: "hunter_pattern",
      person: {
        id: `hunter_pattern:${full}`,
        first_name: first || null,
        last_name: last || null,
        name: full || null,
        title,
        linkedin_headline: null,
        linkedin_url: linkedinUrl,
        seniority: null,
        department: null,
        email: loopRiskyMeta.constructed_email,
        email_status: "risky",
        organization_id: null,
        organization_name: null,
        organization_domain: input.domain,
      },
      email_source: "hunter_pattern",
      cost_credits,
      hunter_cost_usd,
      hunter_pattern_meta: {
        pattern: loopRiskyMeta.pattern,
        constructed_email: loopRiskyMeta.constructed_email,
        mv_status: loopRiskyMeta.mv_status,
        is_primary: false,
        notes: loopRiskyMeta.notes,
      },
    };
  }

  // 7. Full miss — caller surfaces NEEDS_HUMAN_REVIEW with the spec copy.
  const missCopy = patternLoopRan
    ? `Gate C identified ${full || "(unnamed)"}${title ? ` (${title})` : ""}. Looked at Apollo, Hunter, 8 common patterns, and public web sources — no verifiable email found. [Manual research suggested.]`
    : `Gate C identified ${full || "(unnamed)"}${title ? ` (${title})` : ""}, but we couldn't find their email via Apollo or Hunter. [Manual research suggested.]`;
  void loopBestKind;
  return {
    provider: "needs_review",
    person: null,
    email_source: "unknown",
    cost_credits,
    hunter_cost_usd,
    reason: missCopy,
  };
}

async function safe(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    /* never block seed on event-log */
  }
}
