/**
 * Phase 73.2 — POST /api/brands/[id]/contacts/manual-add
 *
 * Manual contact entry from the merged Decision-Makers card. Used when
 * automated enrichment (Apollo + Hunter + 8-pattern + LLM web-search)
 * missed but the operator already knows the email — they found it on
 * the brand's About / Contact page, or it was given to them out of
 * band.
 *
 * Body: { first_name, last_name, title, email, linkedin_url? }
 *
 * Server flow:
 *   1. Validate email shape (server-side, mirroring the client check).
 *   2. Call `verifyEmail`. MV is always called first; on
 *      catch_all/unknown/error, the helper cascades to ZeroBounce
 *      automatically (see email-verify.ts). The returned VerifyResult
 *      carries BOTH providers' raw payloads and verdicts via the
 *      `mv_*` / `zb_*` fields so we can audit each one independently.
 *   3. Emit paired discovery events — one per verifier that actually
 *      ran. MV always runs (it's the primary), so an `mv_*` event is
 *      always emitted. A `zb_*` event is emitted ONLY when ZB also
 *      ran (its `zb_status` is set). Each event records its own
 *      provider's verdict and raw payload, matching the Phase 65
 *      attribution invariant in `enrich-contact.ts:711-789`.
 *   4. Provider-unavailable detection: if BOTH providers reported
 *      provider-level failures (network down, auth failure, HTTP
 *      5xx after retries), return 502 `mv_unavailable` — not 422.
 *      A 422 implies the address is bad; this branch means we don't
 *      yet know.
 *   5. HARD VALID GATE — only `verify.status === 'verified'` proceeds.
 *      Anything else returns 422 with
 *      `{ok:false, error:'mv_rejected', mv_status, mv_score, verifier}`
 *      and no row is written. The `mv_status` field name is kept for
 *      API back-compat; the value is the authoritative verifier's
 *      verdict (could be MV's `catch_all` or ZB's `do_not_mail`).
 *   6. On verified: INSERT into brand_contacts with
 *      `email_source='manual'`, `email_status='verified'`,
 *      `email_verifier=<authoritative verifier>`,
 *      `email_verified_at=now()`, `enrichment_state='enriched'`.
 *      Handle Postgres 23505 from migration 0056's unique-name index
 *      by UPDATEing the existing row instead — manual entry wins
 *      over a prior empty contact. Drop `is_primary` from the
 *      UPDATE field set so an existing primary is not demoted on
 *      collision (we only set is_primary on INSERT when no other
 *      primary exists).
 *   7. Emit a paired `provider='manual'` audit event so the discovery
 *      trail shows the human-supplied email.
 *   8. Return `{ok:true, contact:{…}}` with the full row.
 *
 * Authz: cookie session via Supabase server client + ownership check
 * on brands.user_id (same pattern as enrich-candidate).
 */
import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";
import { verifyEmail, type VerifyResult } from "@/lib/contacts/email-verify";
import { recordDiscoveryEvent } from "@/lib/contacts/events";
import { escapeIlike } from "@/lib/contacts/ilike";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const CONTACT_SELECT =
  "id, full_name, first_name, last_name, title, linkedin_url, company_domain, email, email_status, email_source, email_verifier, email_verifier_score, email_verified_at, email_pattern_used, phone, phone_status, is_primary, ready_to_send, enrichment_state";

// Phase 73.2 — RFC-5321-friendly local part. Permits apostrophes (so
// `j.o'connor@x.com` is accepted) and standard mail safe chars. Server
// also re-runs `verifyEmail`'s stricter syntax check internally, so a
// loose regex here can't sneak past MV.
const EMAIL_SHAPE = /^[A-Za-z0-9._%+\-'!#$&*/=?^_`{|}~]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

interface Body {
  first_name?: string;
  last_name?: string;
  title?: string;
  email?: string;
  linkedin_url?: string | null;
}

function extractDomain(input: string | null): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("/")[0];
  s = s.split("?")[0];
  if (!s.includes(".")) return null;
  return s;
}

function clampScore(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

/**
 * Emit one discovery event per verifier that ran during this call.
 * Mirrors the Phase 65 dual-emit pattern in `enrich-contact.ts:711-789`
 * so callers downstream of `verifyEmail` produce a consistent audit
 * trail (one row per provider that billed us, with that provider's
 * own verdict — never one provider's verdict logged under another's
 * `provider` column).
 *
 * Returns a flag indicating whether ZB ran, so the caller can decide
 * whether to short-circuit to `mv_unavailable` when both errored.
 */
async function emitVerifierEvents(args: {
  brand_id: string;
  run_id: string;
  contact_id: string | null;
  email: string;
  verify: VerifyResult;
}): Promise<{ mv_error: boolean; zb_ran: boolean; zb_error: boolean }> {
  const { brand_id, run_id, contact_id, email, verify } = args;
  const isMvAuthoritative = verify.verifier === "millionverifier";
  const isZbAuthoritative = verify.verifier === "zerobounce";

  // MV always runs (it's the primary). We may know its verdict either
  // from `verify.status` (when MV is authoritative) or from
  // `verify.mv_status` (when ZB cascaded and is authoritative).
  const mvStatus = isMvAuthoritative
    ? verify.status
    : (verify.mv_status ?? null);
  const mvError = isMvAuthoritative ? verify.error : verify.mv_error;
  const mvRaw = isMvAuthoritative ? verify.raw : (verify.mv_raw ?? null);
  const mvScore =
    isMvAuthoritative && typeof verify.score === "number"
      ? clampScore(verify.score)
      : null;

  let mvOutcome: "found" | "error" | "skipped" = "skipped";
  let mvReason: string;
  if (mvError) {
    mvOutcome = "error";
    mvReason = `MillionVerifier (manual-add) error: ${mvError}.`;
  } else if (mvStatus) {
    // MV ran and returned a verdict — `found` is the Phase 65
    // convention for "ran and produced any verdict", reserving
    // `skipped` for "did not call".
    mvOutcome = "found";
    mvReason = `MillionVerifier (manual-add) verdict ${mvStatus} for ${email}${
      mvScore !== null ? ` (score ${mvScore.toFixed(2)})` : ""
    }.`;
  } else {
    mvOutcome = "skipped";
    mvReason = `MillionVerifier (manual-add): not called.`;
  }
  await recordDiscoveryEvent({
    brand_id,
    run_id,
    contact_id,
    provider: "millionverifier",
    outcome: mvOutcome,
    reason: mvReason,
    email_returned: email,
    status_returned: mvError ? null : mvStatus,
    score_returned: mvScore,
    raw_payload: mvRaw,
  });

  // ZB only runs when MV deferred (catch_all/unknown/error/no-key).
  const zbRan =
    isZbAuthoritative ||
    verify.zb_status !== undefined ||
    verify.zb_error !== undefined;
  const zbStatus = isZbAuthoritative ? verify.status : (verify.zb_status ?? null);
  const zbError = isZbAuthoritative ? verify.error : verify.zb_error;
  const zbRaw = isZbAuthoritative ? verify.raw : (verify.zb_raw ?? null);
  const zbScore =
    isZbAuthoritative && typeof verify.score === "number"
      ? clampScore(verify.score)
      : null;

  if (zbRan) {
    let zbOutcome: "found" | "error" | "skipped" = "skipped";
    let zbReason: string;
    if (zbError) {
      zbOutcome = "error";
      zbReason = `ZeroBounce (manual-add) error: ${zbError}.`;
    } else if (zbStatus) {
      zbOutcome = "found";
      zbReason = `ZeroBounce (manual-add) verdict ${zbStatus} for ${email}${
        zbScore !== null ? ` (score ${zbScore.toFixed(2)})` : ""
      }.`;
    } else {
      zbOutcome = "skipped";
      zbReason = `ZeroBounce (manual-add): not called.`;
    }
    await recordDiscoveryEvent({
      brand_id,
      run_id,
      contact_id,
      provider: "zerobounce",
      outcome: zbOutcome,
      reason: zbReason,
      email_returned: email,
      status_returned: zbError ? null : zbStatus,
      score_returned: zbScore,
      raw_payload: zbRaw,
    });
  }

  return {
    mv_error: !!mvError,
    zb_ran: zbRan,
    zb_error: !!zbError,
  };
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data: brand } = await supabase
    .from("brands")
    .select("id, name, resolved_owner_domain")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle<{
      id: string;
      name: string;
      resolved_owner_domain: string | null;
    }>();
  if (!brand) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const firstName =
    typeof body.first_name === "string" ? body.first_name.trim() : "";
  const lastName =
    typeof body.last_name === "string" ? body.last_name.trim() : "";
  const title =
    typeof body.title === "string" ? body.title.trim() : "";
  const emailRaw =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const linkedinUrl =
    typeof body.linkedin_url === "string" && body.linkedin_url.trim().length > 0
      ? body.linkedin_url.trim()
      : null;

  if (!firstName) {
    return NextResponse.json(
      { ok: false, error: "first_name required" },
      { status: 400 },
    );
  }
  if (!lastName) {
    return NextResponse.json(
      { ok: false, error: "last_name required" },
      { status: 400 },
    );
  }
  if (!title) {
    return NextResponse.json(
      { ok: false, error: "title required" },
      { status: 400 },
    );
  }
  if (!emailRaw || !EMAIL_SHAPE.test(emailRaw)) {
    return NextResponse.json(
      { ok: false, error: "email_invalid_shape" },
      { status: 400 },
    );
  }

  const fullName = `${firstName} ${lastName}`.trim();
  const runId = randomUUID();
  const domain = extractDomain(brand.resolved_owner_domain);

  // 1. Run the verifier cascade.
  //
  // `verifyEmail` swallows network/HTTP errors internally and returns
  // a structured VerifyResult with `error` populated. It does not
  // throw on normal failure paths. The outer try/catch here covers
  // only truly exceptional throws (e.g., a malformed admin client
  // reference). We do NOT translate `verify.error` into a 5xx;
  // unavailable-detection happens below by inspecting `mv_error` and
  // `zb_error` together.
  let verify: VerifyResult;
  try {
    verify = await verifyEmail(emailRaw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordDiscoveryEvent({
      brand_id: params.id,
      run_id: runId,
      provider: "millionverifier",
      outcome: "error",
      reason: `verifyEmail (manual-add) threw: ${msg}`,
      email_returned: emailRaw,
    });
    return NextResponse.json(
      { ok: false, error: "mv_unavailable", detail: msg },
      { status: 502 },
    );
  }

  // 2. Emit one event per verifier that ran. Returned flags tell us
  //    if BOTH providers errored (→ 502) and what was authoritative.
  const verifierFlags = await emitVerifierEvents({
    brand_id: params.id,
    run_id: runId,
    contact_id: null,
    email: emailRaw,
    verify,
  });

  // 3. Provider-unavailable detection. The verifier helper sets
  //    `error` on each provider when it could not produce a verdict
  //    (HTTP 5xx after retries, network down, auth failure, malformed
  //    response). When MV errored AND either ZB errored OR ZB didn't
  //    run at all (no key), we genuinely don't know the address —
  //    return 502 so Steve sees "verifier unavailable" instead of
  //    being told the email is bad.
  if (verifierFlags.mv_error && (!verifierFlags.zb_ran || verifierFlags.zb_error)) {
    const mvMsg = verify.mv_error ?? verify.error ?? "MV unavailable";
    const zbMsg = verify.zb_error ?? "ZB not configured or also errored";
    return NextResponse.json(
      {
        ok: false,
        error: "mv_unavailable",
        detail: `MV: ${mvMsg}; ZB: ${zbMsg}`,
      },
      { status: 502 },
    );
  }

  const authoritativeVerifier = verify.verifier;
  const finalStatus = verify.status;
  const finalScore =
    typeof verify.score === "number" ? clampScore(verify.score) : null;
  const isVerified = finalStatus === "verified";

  // 4. HARD GATE — only `verified` writes. Anything else (catch_all,
  //    risky, unknown, invalid, do_not_mail) returns 422 with the
  //    authoritative verdict + verifier identity so the client can
  //    show an honest inline error.
  if (!isVerified) {
    return NextResponse.json(
      {
        ok: false,
        error: "mv_rejected",
        // mv_status name kept for API back-compat — the value is the
        // authoritative verifier's verdict, which may have come from
        // either MV or ZB after the cascade.
        mv_status: finalStatus,
        mv_score: finalScore ?? 0,
        verifier: authoritativeVerifier,
      },
      { status: 422 },
    );
  }

  // 5. INSERT into brand_contacts. Determine is_primary BEFORE the
  //    write so the manual entry takes the primary slot iff no other
  //    primary exists. We never demote an existing primary on
  //    collision — the UPDATE field set in the 23505 branch omits
  //    `is_primary` so the existing row's flag is preserved.
  const { data: existingPrimary } = await admin
    .from("brand_contacts")
    .select("id")
    .eq("brand_id", params.id)
    .eq("is_primary", true)
    .not("email", "is", null)
    .limit(1)
    .maybeSingle<{ id: string }>();
  const wantPrimary = !existingPrimary;

  const nowIso = new Date().toISOString();
  const insertFields: Record<string, unknown> = {
    brand_id: params.id,
    full_name: fullName,
    first_name: firstName,
    last_name: lastName,
    title,
    linkedin_url: linkedinUrl,
    company_domain: domain,
    email: emailRaw,
    email_source: "manual",
    email_status: "verified",
    email_verifier: authoritativeVerifier,
    email_verifier_score: finalScore,
    email_verified_at: nowIso,
    enrichment_state: "enriched",
    is_primary: wantPrimary,
    ready_to_send: true,
    updated_at: nowIso,
  };

  // UPDATE field set for the 23505 path — DROP `is_primary` so the
  // existing row's primary flag is not demoted on name collision.
  // Manual entry overrides email + verifier metadata but should not
  // touch the row's is_primary stickiness.
  const updateFields: Record<string, unknown> = { ...insertFields };
  delete updateFields.brand_id;
  delete updateFields.is_primary;

  let contactRow: Record<string, unknown> | null = null;

  const { data: inserted, error: insErr } = await admin
    .from("brand_contacts")
    .insert(insertFields)
    .select(CONTACT_SELECT)
    .maybeSingle();

  if (insErr) {
    const code = (insErr as { code?: string }).code ?? "";
    if (code !== "23505") {
      return NextResponse.json(
        {
          ok: false,
          error: "insert_failed",
          detail: (insErr as { message?: string }).message ?? String(insErr),
        },
        { status: 500 },
      );
    }
    // 23505 — a row already exists for (brand_id, lower(full_name)).
    // ILIKE the existing row by name with escaped wildcards so a
    // name containing `_` or `%` doesn't multi-match (which would
    // make `.maybeSingle()` return null and 500 us out after we've
    // already spent the verifier credit).
    const { data: updated, error: updErr } = await admin
      .from("brand_contacts")
      .update(updateFields)
      .eq("brand_id", params.id)
      .ilike("full_name", escapeIlike(fullName))
      .select(CONTACT_SELECT)
      .maybeSingle();
    if (updErr || !updated) {
      return NextResponse.json(
        {
          ok: false,
          error: "manual_update_failed",
          detail:
            updErr?.message ?? (updated == null ? "no row matched" : "unknown"),
        },
        { status: 500 },
      );
    }
    contactRow = updated as Record<string, unknown>;
  } else if (inserted) {
    contactRow = inserted as Record<string, unknown>;
  }

  if (!contactRow) {
    return NextResponse.json(
      { ok: false, error: "insert_failed", detail: "no row returned" },
      { status: 500 },
    );
  }

  // 6. Audit event for the manual write.
  await recordDiscoveryEvent({
    brand_id: params.id,
    run_id: runId,
    contact_id:
      typeof contactRow.id === "string" ? (contactRow.id as string) : null,
    provider: "manual",
    outcome: "found",
    reason: `Manual entry by operator ${user.id}: ${fullName} <${emailRaw}> (${title}).`,
    email_returned: emailRaw,
    status_returned: "verified",
    raw_payload: {
      operator_user_id: user.id,
      authoritative_verifier: authoritativeVerifier,
    },
  });

  return NextResponse.json({ ok: true, contact: contactRow, run_id: runId });
}
