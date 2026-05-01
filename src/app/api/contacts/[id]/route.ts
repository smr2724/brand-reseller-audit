import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const ALLOWED_FIELDS = new Set([
  "title",
  "first_name",
  "last_name",
  "full_name",
  "email",
  "phone",
  "linkedin_url",
  "seniority",
  "department",
  "is_primary",
  "disqualified",
  "disqualified_reason",
  "ai_priority_rank",
  "ai_priority_reason",
]);

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ contact: data });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const update: Record<string, unknown> = {};
  for (const k of Object.keys(body)) {
    if (ALLOWED_FIELDS.has(k)) update[k] = body[k];
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no editable fields provided" }, { status: 400 });
  }
  update.updated_at = new Date().toISOString();

  // If setting is_primary=true, demote any existing primary in same brand.
  if (update.is_primary === true) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("brand_id")
      .eq("id", params.id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (contact?.brand_id) {
      await supabase
        .from("contacts")
        .update({ is_primary: false })
        .eq("user_id", user.id)
        .eq("brand_id", contact.brand_id)
        .neq("id", params.id);
    }
  }

  const { data, error } = await supabase
    .from("contacts")
    .update(update)
    .eq("id", params.id)
    .eq("user_id", user.id)
    .select()
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ contact: data });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { error } = await supabase
    .from("contacts")
    .delete()
    .eq("id", params.id)
    .eq("user_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
