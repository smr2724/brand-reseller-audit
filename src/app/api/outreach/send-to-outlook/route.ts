/**
 * Phase 6.6 — One-click "Send to Outlook" for the initial brand outreach.
 *
 * Collapses the previous Generate → Save → Send chain into a single POST.
 * Renders the verbatim Steve template via `lib/outreach/initial-template.ts`
 * (no LLM, no tone picker), creates a draft in the user's Outlook via
 * Microsoft Graph, and upserts the brand's initial-outreach thread row
 * with status='drafted_in_outlook'.
 *
 * Drafts only — never calls `/me/sendMail`.
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

interface Body {
  brand_id?: string;
}

export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = (await req.json().catch(() => ({}))) as Body;
  const brandId = payload.brand_id;
  if (!brandId) {
    return NextResponse.json({ error: "brand_id required" }, { status: 400 });
  }

  // 1. Load brand row + ensure ownership.
  const { data: brandRow, error: brandErr } = await supabase
    .from("brands")
    .select("id, name, est_monthly_revenue, trailing_12_months, keepa_unique_seller_count, keepa_brand_controlled_pct")
    .eq("id", brandId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (brandErr) return NextResponse.json({ error: brandErr.message }, { status: 500 });
  if (!brandRow) return NextResponse.json({ error: "brand not found" }, { status: 404 });

  // 2. Find the primary contact for the brand.
  const { data: contactRow, error: contactErr } = await supabase
    .from("contacts")
    .select("id, full_name, first_name, email, supplier_id, title")
    .eq("user_id", user.id)
    .eq("brand_id", brandRow.id)
    .eq("is_primary", true)
    .maybeSingle();
  if (contactErr) return NextResponse.json({ error: contactErr.message }, { status: 500 });
  if (!contactRow) {
    return NextResponse.json(
      { error: "no_primary_contact", message: "Set a primary contact for this brand first." },
      { status: 400 },
    );
  }
  if (!contactRow.email) {
    return NextResponse.json(
      { error: "no_primary_contact", message: "Primary contact is missing an email address." },
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

  // 4. Create the Outlook draft.
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

  // 5. Upsert the initial-outreach thread row for this brand+contact.
  // No `kind` column on outreach_threads; we identify the initial-outreach
  // thread as the row for this brand+contact whose tone is NOT
  // 'report_followup' (the only other tone tag set by the one-click flow).
  const nowIso = new Date().toISOString();

  const { data: existing, error: existingErr } = await supabase
    .from("outreach_threads")
    .select("id, tone")
    .eq("user_id", user.id)
    .eq("brand_id", brandRow.id)
    .eq("contact_id", contactRow.id)
    .or("tone.is.null,tone.neq.report_followup")
    .order("last_action_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingErr) {
    return NextResponse.json(
      { error: `draft created in Outlook but failed to look up thread: ${existingErr.message}`, message_id: draft.messageId, web_link: draft.webLink },
      { status: 500 },
    );
  }

  const draftedFields = {
    user_id: user.id,
    brand_id: brandRow.id,
    contact_id: contactRow.id,
    supplier_id: contactRow.supplier_id ?? null,
    status: "drafted_in_outlook" as const,
    subject: rendered.subject,
    body: rendered.text,
    body_text: rendered.text,
    body_html: rendered.html,
    outlook_message_id: draft.messageId,
    outlook_web_link: draft.webLink,
    drafted_in_outlook_at: nowIso,
    last_action_at: nowIso,
  };

  if (existing?.id) {
    const { error: updErr } = await supabase
      .from("outreach_threads")
      .update(draftedFields)
      .eq("id", existing.id)
      .eq("user_id", user.id);
    if (updErr) {
      return NextResponse.json(
        { error: `draft created in Outlook but failed to update thread: ${updErr.message}`, message_id: draft.messageId, web_link: draft.webLink },
        { status: 500 },
      );
    }
  } else {
    const { error: insErr } = await supabase
      .from("outreach_threads")
      .insert(draftedFields);
    if (insErr) {
      return NextResponse.json(
        { error: `draft created in Outlook but failed to record thread: ${insErr.message}`, message_id: draft.messageId, web_link: draft.webLink },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({
    ok: true,
    message_id: draft.messageId,
    web_link: draft.webLink,
    subject: rendered.subject,
    contact: {
      name: contactRow.full_name ?? null,
      email: contactRow.email,
    },
  });
}
