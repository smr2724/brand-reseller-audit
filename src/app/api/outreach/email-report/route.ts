/**
 * Phase 6.5 — "Email the Report" follow-up draft.
 *
 * Creates a NEW outreach_threads row tagged `tone='report_followup'` with
 * a Microsoft Graph draft already populated (Short tease + 30-day signed
 * URL). The user sends from Outlook themselves — we never call
 * `/me/sendMail`.
 */
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createDraft } from "@/lib/microsoft/graph";
import { getReportLongLivedUrl } from "@/lib/report/storage";
import {
  renderReportEmail,
  type ReportTemplateBrand,
} from "@/lib/outreach/report-template";
import type { InitialTemplateContact } from "@/lib/outreach/initial-template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Microsoft Graph draft creation can be slow on cold paths; bump from
// the default 10s so we don't time out before the draft lands in Outlook.
export const maxDuration = 60;

interface Body {
  brand_id?: string;
  report_id?: string;
}

export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Body;
  const brandId = body.brand_id;
  const reportId = body.report_id;
  if (!brandId || !reportId) {
    return NextResponse.json({ error: "brand_id and report_id required" }, { status: 400 });
  }

  // 1. Validate brand + report ownership and that report is completed.
  const [{ data: brandRow, error: brandErr }, { data: report, error: repErr }] = await Promise.all([
    supabase
      .from("brands")
      .select("id, name, keepa_unique_seller_count, keepa_brand_controlled_pct")
      .eq("id", brandId)
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("reports")
      .select("id, brand_id, user_id, status, pdf_storage_path")
      .eq("id", reportId)
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);
  if (brandErr) return NextResponse.json({ error: brandErr.message }, { status: 500 });
  if (repErr) return NextResponse.json({ error: repErr.message }, { status: 500 });
  if (!brandRow) return NextResponse.json({ error: "brand not found" }, { status: 404 });
  if (!report) return NextResponse.json({ error: "report not found" }, { status: 404 });
  if (report.brand_id !== brandRow.id) {
    return NextResponse.json({ error: "report does not belong to brand" }, { status: 400 });
  }
  if (report.status !== "completed") {
    return NextResponse.json({ error: `report not ready (${report.status})` }, { status: 409 });
  }

  // 2. Find the primary contact.
  const { data: contactRow, error: contactErr } = await supabase
    .from("contacts")
    .select("id, full_name, first_name, email")
    .eq("user_id", user.id)
    .eq("brand_id", brandRow.id)
    .eq("is_primary", true)
    .maybeSingle();
  if (contactErr) return NextResponse.json({ error: contactErr.message }, { status: 500 });
  if (!contactRow) {
    return NextResponse.json(
      { error: "no_primary_contact", message: "Set a primary contact for this brand before emailing the report." },
      { status: 400 },
    );
  }
  if (!contactRow.email) {
    return NextResponse.json(
      { error: "primary contact is missing an email address" },
      { status: 400 },
    );
  }

  // 3. 30-day signed URL for the PDF.
  let reportUrl: string;
  try {
    reportUrl = await getReportLongLivedUrl(reportId, 30);
  } catch (e) {
    return NextResponse.json({ error: `report URL: ${(e as Error).message}` }, { status: 500 });
  }

  // 4. Render email + create draft.
  const brand: ReportTemplateBrand = {
    name: brandRow.name,
    keepa_unique_seller_count: brandRow.keepa_unique_seller_count ?? null,
    keepa_brand_controlled_pct: brandRow.keepa_brand_controlled_pct ?? null,
  };
  const contact: InitialTemplateContact = {
    full_name: contactRow.full_name ?? null,
    first_name: contactRow.first_name ?? null,
  };
  const rendered = renderReportEmail({ brand, contact, reportUrl });

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

  // 5. Insert a fresh outreach_threads row tagged report_followup.
  const nowIso = new Date().toISOString();
  const { data: inserted, error: insErr } = await supabase
    .from("outreach_threads")
    .insert({
      user_id: user.id,
      brand_id: brandRow.id,
      contact_id: contactRow.id,
      report_id: reportId,
      tone: "report_followup",
      status: "drafted_in_outlook",
      subject: rendered.subject,
      body: rendered.text,
      body_text: rendered.text,
      body_html: rendered.html,
      outlook_message_id: draft.messageId,
      outlook_web_link: draft.webLink,
      drafted_in_outlook_at: nowIso,
      last_action_at: nowIso,
    })
    .select("id")
    .maybeSingle();
  if (insErr) {
    return NextResponse.json(
      {
        error: `draft created in Outlook but failed to record thread: ${insErr.message}`,
        message_id: draft.messageId,
        web_link: draft.webLink,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    thread_id: inserted?.id ?? null,
    message_id: draft.messageId,
    web_link: draft.webLink,
  });
}
