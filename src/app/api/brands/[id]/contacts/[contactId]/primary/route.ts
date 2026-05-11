/**
 * Phase 61 — POST /api/brands/[id]/contacts/[contactId]/primary
 *
 * Promotes the specified contact to `is_primary = true` and demotes
 * every other contact of the same brand. Respects the unique partial
 * index `brand_contacts(brand_id) WHERE is_primary=true` by demoting
 * first, then promoting.
 *
 * The existing PATCH route also supports primary toggling; this
 * dedicated endpoint keeps the new UI's intent explicit and the client
 * simple.
 *
 * Response: { contact: { id, full_name, is_primary } }
 *
 * 404 (not 500) when the brand or contact doesn't belong to the caller.
 */
import { NextResponse } from "next/server";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: Request,
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

  // Verify the contact belongs to this brand. Returns 404, not 500,
  // when it doesn't (so the UI can surface a clean message).
  const { data: existing } = await admin
    .from("brand_contacts")
    .select("id")
    .eq("id", params.contactId)
    .eq("brand_id", params.id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: "contact not found" }, { status: 404 });
  }

  const updatedAt = new Date().toISOString();

  // Demote any current primary first to satisfy the partial unique index.
  await admin
    .from("brand_contacts")
    .update({ is_primary: false, updated_at: updatedAt })
    .eq("brand_id", params.id)
    .neq("id", params.contactId);

  const { data: promoted, error } = await admin
    .from("brand_contacts")
    .update({ is_primary: true, updated_at: updatedAt })
    .eq("id", params.contactId)
    .eq("brand_id", params.id)
    .select("id, full_name, is_primary")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!promoted) {
    return NextResponse.json({ error: "contact not found" }, { status: 404 });
  }
  return NextResponse.json({ contact: promoted });
}
