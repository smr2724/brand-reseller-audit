/**
 * Phase 70 — Verified contacts for the OutreachPicker.
 *
 * Returns the brand's `brand_contacts` rows that have passed the
 * verifier cascade — `email_status='verified' AND email IS NOT NULL`
 * — along with recent outlook-draft creation events from
 * `brand_contact_discovery_events`. Read-only; the picker uses the
 * separate POST /api/outreach/send-to-outlook route to actually create
 * drafts.
 *
 * Phase 73.3: `email_status='verified'` is the single trust gate.
 * `email_verifier` and `email_source` are NOT filtered here — the
 * manual-add route (and any future cascaded ZeroBounce verdict) sets
 * `email_status='verified'` only after the same verifier cascade that
 * the enrichment pipeline uses, so all sources (apollo, hunter,
 * hunter_finder, hunter_pattern, llm_websearch, pattern_guess, manual)
 * and both verifiers (millionverifier, zerobounce) are equally trusted
 * once they reach the verified state. Filtering on a specific verifier
 * here would silently drop ZB-authoritative rows and manual entries
 * that cascaded to ZB.
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

  // Filter: verifier-cascade confirmed. `email_status='verified'` is
  // the single trust gate — write paths (enrich-contact, manual-add)
  // only stamp it after an authoritative `verified` verdict from the
  // MV→ZB cascade. Filtering on a specific `email_verifier` or
  // `email_source` here would silently exclude legitimate rows (e.g.
  // ZB-authoritative verdicts, manual entries that cascaded to ZB).
  const { data: contacts, error } = await admin
    .from("brand_contacts")
    .select(CONTACT_SELECT)
    .eq("brand_id", brand.id)
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
