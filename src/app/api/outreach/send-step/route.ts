import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createOutlookDraft } from "@/lib/outlook";
import { fillTemplate, getTemplate, OutreachStep } from "@/lib/outreach-templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  contact_id: string;
  step: OutreachStep;
  product_category: string;
  opportunity_id?: string;
  report_url?: string;
}

export async function POST(req: NextRequest) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as Body;
  const { contact_id, step, product_category, opportunity_id, report_url } = body;

  if (!contact_id) return NextResponse.json({ error: "contact_id required" }, { status: 400 });
  if (!step || step < 1 || step > 5) return NextResponse.json({ error: "step must be 1-5" }, { status: 400 });
  if (!product_category) return NextResponse.json({ error: "product_category required" }, { status: 400 });
  if (step === 5 && !report_url) {
    return NextResponse.json({ error: "report_url required for step 5" }, { status: 400 });
  }

  // Load the contact + supplier
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, full_name, first_name, email, supplier_id, suppliers(id, company_name)")
    .eq("id", contact_id)
    .eq("user_id", user.id)
    .single();
  if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  if (!contact.email) return NextResponse.json({ error: "Contact has no email" }, { status: 400 });

  // Fill template
  const tmpl = getTemplate(step);
  const filled = fillTemplate(tmpl, {
    first_name: contact.first_name ?? contact.full_name?.split(" ")[0] ?? "there",
    product_category,
    report_url,
  });

  // Create Outlook draft — fail hard if it doesn't land in Drafts.
  // No mailto fallback: that opens macOS Mail.app on desktop instead of Outlook.
  const draft = await createOutlookDraft({
    userId: user.id,
    toEmail: contact.email,
    toName: contact.full_name,
    subject: filled.subject,
    body: filled.body,
  });

  if (!draft.ok || !draft.outlookDraftId) {
    return NextResponse.json(
      {
        error:
          draft.error ??
          "Could not create Outlook draft. Check OUTLOOK_ACCESS_TOKEN in Vercel.",
      },
      { status: 502 },
    );
  }

  // Record the thread row only after the draft is confirmed in Outlook.
  const { data: thread, error: insertError } = await supabase
    .from("outreach_threads")
    .insert({
      user_id: user.id,
      contact_id,
      supplier_id: contact.supplier_id,
      opportunity_id: opportunity_id ?? null,
      step,
      template_key: tmpl.key,
      status: "draft",
      subject: filled.subject,
      body: filled.body,
      outlook_draft_id: draft.outlookDraftId,
      outlook_web_link: draft.webLink ?? null,
      last_action_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({
    thread,
    web_link: draft.webLink ?? null,
  });
}
