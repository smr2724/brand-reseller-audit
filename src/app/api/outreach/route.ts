import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const VALID_STATUSES = new Set(["draft", "copied", "sent", "replied", "bounced"]);

export async function GET(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const brandId = url.searchParams.get("brand_id");
  const contactId = url.searchParams.get("contact_id");
  const status = url.searchParams.get("status");
  const tone = url.searchParams.get("tone");

  let q = supabase
    .from("outreach_threads")
    .select(`
      id, brand_id, contact_id, supplier_id, status, subject, body, body_text, body_html,
      tone, generation_model, copied_at, sent_at, replied_at, last_action_at, created_at,
      brands ( id, name ),
      contacts ( id, full_name, first_name, last_name, title, email )
    `)
    .eq("user_id", user.id)
    .order("last_action_at", { ascending: false })
    .limit(500);

  if (brandId) q = q.eq("brand_id", brandId);
  if (contactId) q = q.eq("contact_id", contactId);
  if (status && VALID_STATUSES.has(status)) q = q.eq("status", status);
  if (tone) q = q.eq("tone", tone);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ threads: data ?? [] });
}
