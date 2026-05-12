/**
 * Phase 70 — Outreach picker draft route.
 *
 * Accepts `{ contactId, brandId }` and creates ONE Outlook draft for that
 * single contact via Microsoft Graph `POST /me/messages`. The route is
 * the source of truth for the email payload: it looks up the contact in
 * `brand_contacts` and the brand in `brands` and builds the verbatim
 * Steve template server-side. The client never supplies subject/body.
 *
 * Locked rules (Phase 70):
 *   - Microsoft Graph drafts ONLY (no SMTP, no /me/sendMail).
 *   - The template is fixed (Steve's exact copy). {First Name} falls back
 *     to "there" when null/empty; {Brand} pulls from `brands.name`.
 *   - On 401 from Graph → 401 with `outlook_reauth_required` so the UI
 *     prompts re-auth via the existing flow.
 *   - On 429 from Graph → retry once after 2s.
 *   - STEVE_CC behavior is unchanged — the legacy /api/outreach
 *     send-to-outlook never added a CC, so neither does this route.
 *
 * Backward-compat: the old shape `{ brand_id }` is still accepted and
 * routes to the brand's primary `brand_contacts` row when no `contactId`
 * is supplied. New callers should always pass `contactId`.
 */
import { NextResponse } from "next/server";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";
import { createDraft } from "@/lib/microsoft/graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  contactId?: string;
  contact_id?: string;
  brandId?: string;
  brand_id?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface BuildArgs {
  brandName: string;
  firstName: string | null;
}

/**
 * Phase 70 — Steve's verbatim outreach copy. Do NOT alter punctuation,
 * capitalization, or wording — including the typo "profiting" and the
 * trailing "?" on the second sentence. Steve wrote it this way.
 */
function buildEmail({ brandName, firstName }: BuildArgs): { subject: string; html: string; text: string } {
  const safeFirst =
    typeof firstName === "string" && firstName.trim().length > 0
      ? firstName.trim()
      : "there";
  const brand = brandName;

  const subject = `Quick question about ${brand}`;

  const html =
    `<p>${escapeHtml(safeFirst)}</p>` +
    `<p>${escapeHtml(brand)} is killing it on Amazon but you're not the one selling on most of the listings.</p>` +
    `<p>I made a quick report to show you exactly how much more you could profiting without any extra effort?</p>` +
    `<p>Are you the right person to send it to?</p>` +
    `<p>Steve Rolle</p>`;

  const text =
    `${safeFirst}\n\n` +
    `${brand} is killing it on Amazon but you're not the one selling on most of the listings.\n\n` +
    `I made a quick report to show you exactly how much more you could profiting without any extra effort?\n\n` +
    `Are you the right person to send it to?\n\n` +
    `Steve Rolle`;

  return { subject, html, text };
}

async function createDraftWith429Retry(input: Parameters<typeof createDraft>[0]) {
  const first = await createDraft(input);
  if (first.ok) return first;
  if (first.status === 429) {
    await new Promise((r) => setTimeout(r, 2000));
    return createDraft(input);
  }
  return first;
}

export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = (await req.json().catch(() => ({}))) as Body;
  const brandId = payload.brandId ?? payload.brand_id;
  const contactId = payload.contactId ?? payload.contact_id ?? null;
  if (!brandId) {
    return NextResponse.json({ error: "brandId required" }, { status: 400 });
  }

  // 1. Load brand + verify ownership.
  const { data: brandRow, error: brandErr } = await supabase
    .from("brands")
    .select("id, name")
    .eq("id", brandId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (brandErr) return NextResponse.json({ error: brandErr.message }, { status: 500 });
  if (!brandRow) return NextResponse.json({ error: "brand not found" }, { status: 404 });

  // 2. Resolve the brand_contacts row. Phase 70 callers send contactId
  // explicitly; the legacy shape (no contactId) falls back to the brand's
  // primary contact for backward compat.
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }
  const contactSelect =
    "id, brand_id, first_name, last_name, full_name, email, email_status, is_primary";
  let contactRow: {
    id: string;
    brand_id: string;
    first_name: string | null;
    last_name: string | null;
    full_name: string | null;
    email: string | null;
    email_status: string | null;
    is_primary: boolean | null;
  } | null = null;

  if (contactId) {
    const { data, error } = await admin
      .from("brand_contacts")
      .select(contactSelect)
      .eq("id", contactId)
      .eq("brand_id", brandRow.id)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    contactRow = data ?? null;
    if (!contactRow) {
      return NextResponse.json({ error: "contact not found" }, { status: 404 });
    }
  } else {
    const { data, error } = await admin
      .from("brand_contacts")
      .select(contactSelect)
      .eq("brand_id", brandRow.id)
      .eq("is_primary", true)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    contactRow = data ?? null;
    if (!contactRow) {
      return NextResponse.json(
        { error: "no_primary_contact", message: "No primary contact for this brand." },
        { status: 400 },
      );
    }
  }

  if (!contactRow.email) {
    return NextResponse.json(
      { error: "contact_missing_email", message: "Contact has no email address." },
      { status: 400 },
    );
  }

  // Phase 73.1 — server-side re-validation of email_status. The
  // OutreachPicker (Phase 70) already filters by email_status='verified',
  // but we never trust the client: a stale tab, custom POST, or skew
  // between picker and DB could let an unverified contact through. Reject
  // anything not in the MillionVerifier-confirmed 'verified' bucket with
  // 422 before constructing the Graph draft.
  if (contactRow.email_status !== "verified") {
    return NextResponse.json(
      {
        error: "contact_not_verified",
        message: `Contact email_status='${contactRow.email_status ?? "null"}' — only MillionVerifier-verified contacts can be drafted to Outlook.`,
        email_status: contactRow.email_status,
      },
      { status: 422 },
    );
  }

  // 3. Build the email server-side. Never trust client-supplied subject/body.
  const { subject, html, text } = buildEmail({
    brandName: brandRow.name,
    firstName: contactRow.first_name,
  });

  // 4. Create the Outlook draft. 429 retries once after 2s.
  const draft = await createDraftWith429Retry({
    userId: user.id,
    to: {
      address: contactRow.email,
      name: contactRow.full_name ?? undefined,
    },
    subject,
    html,
    text,
  });

  if (!draft.ok) {
    if (draft.reauthRequired) {
      return NextResponse.json(
        {
          error: "outlook_reauth_required",
          message: draft.error,
          auth_url: "/api/auth/microsoft/start",
        },
        { status: 401 },
      );
    }
    return NextResponse.json({ error: draft.error }, { status: 502 });
  }

  // 5. Telemetry — log to brand_contact_discovery_events. Non-fatal.
  const nowIso = new Date().toISOString();
  try {
    await admin.from("brand_contact_discovery_events").insert({
      brand_id: brandRow.id,
      run_id: `outlook_draft_${nowIso}`,
      contact_id: contactRow.id,
      provider: "orchestrator",
      outcome: "found",
      reason: "outlook_draft_created",
      email_returned: contactRow.email,
      raw_payload: {
        event_type: "outlook_draft_created",
        contact_id: contactRow.id,
        brand_id: brandRow.id,
        outlook_message_id: draft.messageId,
        outlook_web_link: draft.webLink,
      },
    });
  } catch (e) {
    console.log(JSON.stringify({
      event_type: "outlook_draft_created",
      contact_id: contactRow.id,
      brand_id: brandRow.id,
      outlook_message_id: draft.messageId,
      outlook_web_link: draft.webLink,
      log_fallback_reason: e instanceof Error ? e.message : String(e),
    }));
  }

  return NextResponse.json({
    ok: true,
    message_id: draft.messageId,
    web_link: draft.webLink,
    subject,
    contact: {
      id: contactRow.id,
      name: contactRow.full_name ?? null,
      email: contactRow.email,
      first_name: contactRow.first_name,
      last_name: contactRow.last_name,
    },
  });
}
