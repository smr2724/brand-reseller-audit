/**
 * Phase 47 — POST /api/brands/[id]/contacts/[contactId]/verify-email
 *
 * Re-runs MillionVerifier (with ZeroBounce fallback) on a single email,
 * e.g. after a manual edit.
 */
import { NextResponse } from "next/server";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";
import { verifyEmail } from "@/lib/contacts/email-verify";

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
  const { data: contact } = await admin
    .from("brand_contacts")
    .select("id, email")
    .eq("id", params.contactId)
    .eq("brand_id", params.id)
    .maybeSingle<{ id: string; email: string | null }>();
  if (!contact) {
    return NextResponse.json({ error: "contact not found" }, { status: 404 });
  }
  if (!contact.email) {
    return NextResponse.json(
      { error: "contact has no email to verify" },
      { status: 400 },
    );
  }
  const result = await verifyEmail(contact.email);
  const nowIso = new Date().toISOString();
  await admin
    .from("brand_contacts")
    .update({
      email_status: result.status,
      email_verifier: result.verifier,
      email_verifier_score:
        typeof result.score === "number" ? result.score : null,
      email_verified_at: nowIso,
      ready_to_send: result.status === "verified",
      updated_at: nowIso,
    })
    .eq("id", contact.id);
  return NextResponse.json({ ok: true, verify: result });
}
