/**
 * Phase 47 — PATCH /api/brands/[id]/contacts/[contactId]
 *
 * Edit a contact: mark primary, override email, add notes, mark
 * ready_to_send. The unique partial index on `brand_contacts(brand_id)
 * WHERE is_primary=true` enforces the "one primary per brand" rule, so
 * promoting a new primary requires demoting the previous one first.
 */
import { NextResponse } from "next/server";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(
  req: Request,
  { params }: { params: { id: string; contactId: string } },
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
    .select("id")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!brand) return NextResponse.json({ error: "not found" }, { status: 404 });

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }
  const body = await req.json().catch(() => ({}));
  const update: Record<string, unknown> = {};

  if (typeof body.email === "string") update.email = body.email.trim() || null;
  if (typeof body.notes === "string") update.notes = body.notes;
  if (typeof body.title === "string") update.title = body.title;
  if (typeof body.full_name === "string") update.full_name = body.full_name;
  if (typeof body.ready_to_send === "boolean")
    update.ready_to_send = body.ready_to_send;

  const wantsPrimary = body.is_primary === true;
  if (wantsPrimary) {
    // Demote current primary first to satisfy the partial unique index.
    await admin
      .from("brand_contacts")
      .update({ is_primary: false })
      .eq("brand_id", params.id)
      .neq("id", params.contactId);
    update.is_primary = true;
  } else if (body.is_primary === false) {
    update.is_primary = false;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: "no editable fields provided" },
      { status: 400 },
    );
  }
  update.updated_at = new Date().toISOString();
  const { data, error } = await admin
    .from("brand_contacts")
    .update(update)
    .eq("id", params.contactId)
    .eq("brand_id", params.id)
    .select(
      "id, full_name, title, email, email_status, email_source, is_primary, ready_to_send",
    )
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data)
    return NextResponse.json({ error: "contact not found" }, { status: 404 });
  return NextResponse.json({ contact: data });
}
