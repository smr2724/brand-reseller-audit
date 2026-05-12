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
 *   2. Call MillionVerifier on the email. Emit a paired
 *      `provider='millionverifier'` audit row regardless of outcome.
 *   3. HARD MV GATE — only `mv_status='verified'` passes. Anything
 *      else (`invalid`, `risky`, `unknown`, `catch_all`, …) returns
 *      422 with `{ok:false, error:'mv_rejected', mv_status, mv_score}`
 *      and writes NO row to brand_contacts. The operator picks a
 *      different email.
 *   4. On MV-valid: INSERT into brand_contacts with
 *      `email_source='manual'`, `email_status='verified'`,
 *      `enrichment_state='enriched'`, `email_verified_at=now()`. Handle
 *      Postgres 23505 from migration 0056's unique-name index by
 *      UPDATEing the existing row instead — manual entry wins over a
 *      prior empty contact (so re-rescuing a Maria-Ringo-style row
 *      doesn't duplicate it).
 *   5. Emit a paired `provider='manual'` audit event so the discovery
 *      trail shows the human-supplied email.
 *   6. Return `{ok:true, contact:{…}}` with the full row.
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
import { verifyEmail } from "@/lib/contacts/email-verify";
import { recordDiscoveryEvent } from "@/lib/contacts/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const CONTACT_SELECT =
  "id, full_name, first_name, last_name, title, linkedin_url, company_domain, email, email_status, email_source, email_verifier, email_verifier_score, email_verified_at, email_pattern_used, phone, phone_status, is_primary, ready_to_send, enrichment_state";

const EMAIL_SHAPE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

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

  // 1. MillionVerifier gate.
  let verify;
  try {
    verify = await verifyEmail(emailRaw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordDiscoveryEvent({
      brand_id: params.id,
      run_id: runId,
      provider: "millionverifier",
      outcome: "error",
      reason: `MillionVerifier (manual-add) error: ${msg}`,
      email_returned: emailRaw,
    });
    return NextResponse.json(
      { ok: false, error: "mv_unavailable", detail: msg },
      { status: 502 },
    );
  }

  const mvStatus = verify.status;
  const mvScore =
    typeof verify.score === "number" ? clampScore(verify.score) : null;
  const isVerified = mvStatus === "verified";

  await recordDiscoveryEvent({
    brand_id: params.id,
    run_id: runId,
    provider: "millionverifier",
    outcome: isVerified
      ? "found"
      : mvStatus === "invalid"
        ? "not_found"
        : "skipped",
    reason: `MillionVerifier (manual-add) verdict ${mvStatus} for ${emailRaw}${
      typeof verify.score === "number"
        ? ` (score ${verify.score.toFixed(2)})`
        : ""
    }.`,
    email_returned: emailRaw,
    status_returned: mvStatus,
    score_returned: mvScore,
    raw_payload: verify.raw ?? null,
  });

  // 2. HARD MV GATE — only `verified` passes. Anything else rejects
  //    with 422 and writes no row.
  if (!isVerified) {
    return NextResponse.json(
      {
        ok: false,
        error: "mv_rejected",
        mv_status: mvStatus,
        mv_score: mvScore ?? 0,
      },
      { status: 422 },
    );
  }

  // 3. INSERT into brand_contacts. Handle 23505 (unique-name race
  //    from migration 0056) by UPDATEing the existing row — manual
  //    entry wins over a prior empty/discovered contact.
  const nowIso = new Date().toISOString();
  const baseFields: Record<string, unknown> = {
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
    email_verifier: "millionverifier",
    email_verifier_score: typeof verify.score === "number" ? verify.score : null,
    email_verified_at: nowIso,
    enrichment_state: "enriched",
    is_primary: false,
    ready_to_send: true,
    updated_at: nowIso,
  };

  let contactRow: Record<string, unknown> | null = null;

  const { data: inserted, error: insErr } = await admin
    .from("brand_contacts")
    .insert(baseFields)
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
    // Manual entry should overwrite the existing empty row.
    const updateFields = { ...baseFields };
    delete (updateFields as Record<string, unknown>).brand_id;
    const { data: updated, error: updErr } = await admin
      .from("brand_contacts")
      .update(updateFields)
      .eq("brand_id", params.id)
      .ilike("full_name", fullName)
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

  // 4. Audit event for the manual write.
  await recordDiscoveryEvent({
    brand_id: params.id,
    run_id: runId,
    contact_id:
      typeof contactRow.id === "string" ? (contactRow.id as string) : null,
    provider: "manual",
    outcome: "found",
    reason: `Manual entry by operator: ${fullName} <${emailRaw}> (${title}).`,
    email_returned: emailRaw,
    status_returned: "verified",
  });

  return NextResponse.json({ ok: true, contact: contactRow, run_id: runId });
}
