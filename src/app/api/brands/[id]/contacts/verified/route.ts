/**
 * Phase 70 — Verified contacts for the OutreachPicker.
 *
 * Returns the brand's `brand_contacts` rows that are MillionVerifier-
 * confirmed (email_verifier='millionverifier' AND email_status='verified'),
 * along with recent outlook-draft creation events from
 * `brand_contact_discovery_events`. Read-only; the picker uses the
 * separate POST /api/outreach/send-to-outlook route to actually create
 * drafts.
 */
import { NextResponse } from "next/server";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CONTACT_SELECT =
  "id, first_name, last_name, full_name, title, company_name, company_domain, email, email_status, email_verifier, email_verifier_score, is_primary, enrichment_state, created_at";

export async function GET(
  _req: Request,
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
    .select("id, name")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle<{ id: string; name: string }>();
  if (!brand) return NextResponse.json({ error: "not found" }, { status: 404 });

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  // Filter: MillionVerifier-confirmed only. The brand_contacts schema
  // does not have a literal `enrichment_state='valid'` value — its
  // enrichment_state lifecycle is discovered/enriching/enriched/error.
  // "MillionVerifier confirmed" maps to email_status='verified' with
  // email_verifier='millionverifier' (per Phase 65 verifier stamp).
  const { data: contacts, error } = await admin
    .from("brand_contacts")
    .select(CONTACT_SELECT)
    .eq("brand_id", brand.id)
    .eq("email_verifier", "millionverifier")
    .eq("email_status", "verified")
    .not("email", "is", null)
    .order("is_primary", { ascending: false })
    .order("email_verifier_score", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Pull recent outlook-draft events for this brand. We tagged the
  // event with provider='orchestrator' + reason='outlook_draft_created'
  // in the Phase 70 draft route.
  const { data: events } = await admin
    .from("brand_contact_discovery_events")
    .select("id, contact_id, reason, email_returned, raw_payload, created_at")
    .eq("brand_id", brand.id)
    .eq("provider", "orchestrator")
    .eq("reason", "outlook_draft_created")
    .order("created_at", { ascending: false })
    .limit(20);

  return NextResponse.json({
    brand: { id: brand.id, name: brand.name },
    contacts: contacts ?? [],
    drafts: events ?? [],
  });
}
