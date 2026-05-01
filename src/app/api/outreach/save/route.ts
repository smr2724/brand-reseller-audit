import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { TONES } from "@/lib/outreach/draft";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const brand_id: string | undefined = body.brand_id;
  const contact_id: string | undefined = body.contact_id;
  const subject: string | undefined = body.subject;
  const body_text: string | undefined = body.body_text;
  const body_html: string | undefined = body.body_html;
  const tone: string | undefined = TONES.includes(body.tone) ? body.tone : undefined;
  const generation_model: string | undefined = body.generation_model;

  if (!brand_id || !contact_id || !subject || !body_text) {
    return NextResponse.json({ error: "brand_id, contact_id, subject, body_text required" }, { status: 400 });
  }

  // Verify ownership of brand/contact.
  const [{ data: brand }, { data: contact }] = await Promise.all([
    supabase.from("brands").select("id").eq("id", brand_id).eq("user_id", user.id).maybeSingle(),
    supabase.from("contacts").select("id, supplier_id").eq("id", contact_id).eq("user_id", user.id).maybeSingle(),
  ]);
  if (!brand) return NextResponse.json({ error: "brand not found" }, { status: 404 });
  if (!contact) return NextResponse.json({ error: "contact not found" }, { status: 404 });

  const insert: Record<string, unknown> = {
    user_id: user.id,
    brand_id,
    contact_id,
    supplier_id: contact.supplier_id ?? null,
    subject,
    body: body_text,
    body_text,
    body_html: body_html ?? null,
    tone,
    generation_model: generation_model ?? null,
    status: "draft",
    last_action_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("outreach_threads")
    .insert(insert)
    .select()
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ thread: data });
}
