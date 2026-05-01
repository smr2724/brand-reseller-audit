/**
 * Phase 6.5 — One-click "Send to Outlook Drafts" for the initial outreach.
 *
 * Validates that the thread belongs to the requesting user, renders the
 * canonical initial-outreach template (verbatim copy in
 * `lib/outreach/initial-template.ts`), creates a draft in the user's
 * Outlook via Microsoft Graph, and stamps the resulting draft id +
 * webLink onto the existing `outreach_threads` row.
 *
 * Never calls `/me/sendMail` — drafts only.
 */
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createDraft } from "@/lib/microsoft/graph";
import {
  renderInitialEmail,
  type InitialTemplateBrand,
  type InitialTemplateContact,
  type RevenueLookup,
} from "@/lib/outreach/initial-template";
import { getBrandEnrichmentBundle } from "@/lib/enrichment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // 1. Load the thread + ensure ownership.
  const { data: thread, error: threadErr } = await supabase
    .from("outreach_threads")
    .select("id, user_id, brand_id, contact_id, subject, body_text, body_html, status")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (threadErr) return NextResponse.json({ error: threadErr.message }, { status: 500 });
  if (!thread) return NextResponse.json({ error: "thread not found" }, { status: 404 });
  if (!thread.brand_id || !thread.contact_id) {
    return NextResponse.json(
      { error: "thread is missing brand_id or contact_id — cannot draft" },
      { status: 400 },
    );
  }

  // 2. Load the brand row + the contact row.
  const [{ data: brandRow, error: brandErr }, { data: contactRow, error: contactErr }] =
    await Promise.all([
      supabase
        .from("brands")
        .select("id, name, est_monthly_revenue, trailing_12_months, keepa_unique_seller_count, keepa_brand_controlled_pct")
        .eq("id", thread.brand_id)
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase
        .from("contacts")
        .select("id, full_name, first_name, email")
        .eq("id", thread.contact_id)
        .eq("user_id", user.id)
        .maybeSingle(),
    ]);
  if (brandErr) return NextResponse.json({ error: brandErr.message }, { status: 500 });
  if (contactErr) return NextResponse.json({ error: contactErr.message }, { status: 500 });
  if (!brandRow) return NextResponse.json({ error: "brand not found" }, { status: 404 });
  if (!contactRow) return NextResponse.json({ error: "contact not found" }, { status: 404 });
  if (!contactRow.email) {
    return NextResponse.json(
      { error: "contact is missing an email address" },
      { status: 400 },
    );
  }

  // 3. Pull the enrichment bundle. Optional — render falls back gracefully.
  const bundle = await getBrandEnrichmentBundle(supabase, brandRow.id).catch(() => null);

  const brand: InitialTemplateBrand = {
    name: brandRow.name,
    keepa_unique_seller_count: brandRow.keepa_unique_seller_count ?? null,
    keepa_brand_controlled_pct: brandRow.keepa_brand_controlled_pct ?? null,
  };
  const contact: InitialTemplateContact = {
    full_name: contactRow.full_name ?? null,
    first_name: contactRow.first_name ?? null,
  };
  const revenue: RevenueLookup = {
    trailing_12_months: brandRow.trailing_12_months ?? null,
    est_monthly_revenue: brandRow.est_monthly_revenue ?? null,
  };
  const rendered = renderInitialEmail({ brand, contact, bundle, revenue });

  // 4. Create draft.
  const draft = await createDraft({
    userId: user.id,
    to: { address: contactRow.email, name: contactRow.full_name ?? undefined },
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
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

  // 5. Persist draft handle on the existing thread row.
  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("outreach_threads")
    .update({
      status: "drafted_in_outlook",
      subject: rendered.subject,
      body_text: rendered.text,
      body_html: rendered.html,
      body: rendered.text,
      outlook_message_id: draft.messageId,
      outlook_web_link: draft.webLink,
      drafted_in_outlook_at: nowIso,
      last_action_at: nowIso,
    })
    .eq("id", thread.id)
    .eq("user_id", user.id);
  if (updErr) {
    return NextResponse.json(
      { error: `draft created in Outlook but failed to update thread: ${updErr.message}`, message_id: draft.messageId, web_link: draft.webLink },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    message_id: draft.messageId,
    web_link: draft.webLink,
  });
}
