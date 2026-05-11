/**
 * Phase 61 — POST /api/brands/[id]/contacts/save-selected
 *
 * Marks the supplied contact IDs as user-reviewed and committed by
 * setting `ready_to_send = true`. This is the "Save selected" action
 * in the Contact Discovery UI; saved rows survive future re-discovery
 * (see `runContactDiscovery` sticky-merge logic).
 *
 * Body: { contactIds: string[] }
 * Response: { contacts: BrandContactRow[] }
 *
 * 404 (not 500) when the brand doesn't belong to the caller. 200 with
 * an empty `contacts` array when `contactIds` is empty.
 */
import { NextResponse } from "next/server";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
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
  const rawIds = Array.isArray(body?.contactIds) ? body.contactIds : [];
  const contactIds: string[] = rawIds
    .filter((v: unknown): v is string => typeof v === "string" && v.length > 0)
    .slice(0, 200);

  if (contactIds.length === 0) {
    return NextResponse.json({ contacts: [] });
  }

  const { data: updated, error } = await admin
    .from("brand_contacts")
    .update({
      ready_to_send: true,
      updated_at: new Date().toISOString(),
    })
    .eq("brand_id", params.id)
    .in("id", contactIds)
    .select(
      "id, full_name, title, email, email_status, email_source, is_primary, ready_to_send",
    );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ contacts: updated ?? [] });
}
