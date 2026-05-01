import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const VALID_STATUSES = new Set(["draft", "copied", "sent", "replied", "bounced"]);
const ALLOWED_PATCH = new Set(["status", "subject", "body_text", "body_html", "tone"]);

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("outreach_threads")
    .select(`
      *,
      brands ( id, name, est_monthly_revenue, dominant_seller_sales_pct ),
      contacts ( id, full_name, first_name, last_name, title, email )
    `)
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ thread: data });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const update: Record<string, unknown> = {};
  for (const k of Object.keys(body)) {
    if (ALLOWED_PATCH.has(k)) update[k] = body[k];
  }
  if (update.status !== undefined && !VALID_STATUSES.has(update.status as string)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }
  // Mirror body_text → body for backwards compatibility with the 0007 column.
  if (update.body_text !== undefined) update.body = update.body_text;
  if (update.status === "copied") update.copied_at = new Date().toISOString();
  if (update.status === "sent") update.sent_at = new Date().toISOString();
  if (update.status === "replied") update.replied_at = new Date().toISOString();

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no editable fields provided" }, { status: 400 });
  }
  update.last_action_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("outreach_threads")
    .update(update)
    .eq("id", params.id)
    .eq("user_id", user.id)
    .select()
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ thread: data });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { error } = await supabase
    .from("outreach_threads")
    .delete()
    .eq("id", params.id)
    .eq("user_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
