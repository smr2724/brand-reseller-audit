/**
 * Phase 63 — POST /api/brands/[id]/contacts/[contactId]/enrich
 *
 * On-demand enrichment of a single discovered contact. Runs the same
 * Apollo unlock → MillionVerifier / Hunter finder / pattern_guess →
 * MillionVerifier chain that the orchestrator runs automatically on
 * the primary contact. Each successful Apollo unlock burns one Apollo
 * email credit.
 *
 * Auth: cookie session via Supabase server client + ownership check on
 * `brands.user_id` (same pattern as the discover route).
 *
 * Body: optional, ignored.
 *
 * Response: the updated contact row + the audit events written during
 * this run (run_id scoped to this single enrich).
 */
import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";
import { enrichSingleContact } from "@/lib/contacts/enrich-contact";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const CONTACT_SELECT =
  "id, full_name, title, linkedin_url, company_domain, email, email_status, email_source, email_verifier, email_verifier_score, email_verified_at, email_pattern_used, phone, phone_status, is_primary, ready_to_send, enrichment_state";

const EVENT_SELECT =
  "id, brand_id, contact_id, run_id, provider, outcome, reason, email_returned, status_returned, score_returned, http_status, raw_payload, created_at";

interface ContactRow {
  id: string;
  brand_id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  company_domain: string | null;
  apollo_person_id: string | null;
  company_name: string | null;
}

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
    .select("id, resolved_owner_domain")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle<{ id: string; resolved_owner_domain: string | null }>();
  if (!brand) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  const { data: contact } = await admin
    .from("brand_contacts")
    .select(
      "id, brand_id, full_name, first_name, last_name, company_domain, apollo_person_id, company_name",
    )
    .eq("id", params.contactId)
    .eq("brand_id", params.id)
    .maybeSingle<ContactRow>();
  if (!contact) {
    return NextResponse.json({ error: "contact not found" }, { status: 404 });
  }

  const domain =
    (contact.company_domain ?? "").toLowerCase().trim() ||
    extractDomain(brand.resolved_owner_domain);
  if (!domain) {
    return NextResponse.json(
      { error: "no domain on contact or brand — set company_domain or resolved_owner_domain" },
      { status: 400 },
    );
  }

  const runId = randomUUID();
  const enriched = await enrichSingleContact({
    brand_id: params.id,
    run_id: runId,
    contact_id: contact.id,
    domain,
    first_name: contact.first_name,
    last_name: contact.last_name,
    full_name: contact.full_name,
    organization_name: contact.company_name,
    apollo_person_id: contact.apollo_person_id,
  });

  const nowIso = new Date().toISOString();
  const { data: updated } = await admin
    .from("brand_contacts")
    .update({
      email: enriched.email,
      email_source: enriched.email ? enriched.email_source : null,
      email_pattern_used: enriched.email_pattern_used,
      email_status: enriched.email ? enriched.email_status : "not_found",
      email_verifier: enriched.email_verifier,
      email_verifier_score: enriched.email_verifier_score,
      email_verified_at: enriched.email_verified_at,
      last_name: enriched.last_name,
      full_name: enriched.full_name,
      raw_apollo_match: enriched.raw_apollo_match,
      raw_hunter: enriched.raw_hunter,
      ready_to_send: enriched.email_status === "verified",
      enrichment_state: "enriched",
      updated_at: nowIso,
    })
    .eq("id", contact.id)
    .eq("brand_id", params.id)
    .select(CONTACT_SELECT)
    .maybeSingle();

  const { data: events } = await admin
    .from("brand_contact_discovery_events")
    .select(EVENT_SELECT)
    .eq("brand_id", params.id)
    .eq("run_id", runId)
    .order("created_at", { ascending: true });

  return NextResponse.json({
    ok: true,
    contact: updated ?? null,
    events: events ?? [],
    run_id: runId,
  });
}

function extractDomain(input: string | null): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("/")[0];
  s = s.split("?")[0];
  if (!s.includes(".")) return null;
  return s;
}
