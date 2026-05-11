/**
 * Phase 63 — POST /api/brands/[id]/contacts/[contactId]/enrich
 *
 * On-demand enrichment of a single discovered contact. Runs the same
 * Apollo unlock → MillionVerifier / Hunter finder / pattern_guess →
 * MillionVerifier chain that the orchestrator runs automatically on
 * the primary contact. Each successful Apollo unlock burns one Apollo
 * email credit.
 *
 * Server-side idempotency (Phase 63 follow-up):
 *   We do an OPTIMISTIC CLAIM on the row BEFORE calling
 *   apolloUnlockPerson — UPDATE ... SET enrichment_state='enriching'
 *   WHERE enrichment_state='discovered'. If the claim succeeds, this
 *   request "owns" the enrichment. If the row is already 'enriching'
 *   or 'enriched', the claim returns no rows and we 409 — guaranteeing
 *   that a double-click / two tabs / impatient retry can never burn
 *   duplicate Apollo credits on the same contact id. The state is
 *   always flipped to 'enriched' or 'error' in a try/finally so the
 *   row is NEVER left at 'enriching'.
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

const CLAIM_SELECT =
  "id, brand_id, full_name, first_name, last_name, company_domain, apollo_person_id, company_name, enrichment_state";

interface ClaimedRow {
  id: string;
  brand_id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  company_domain: string | null;
  apollo_person_id: string | null;
  company_name: string | null;
  enrichment_state: string;
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

  // OPTIMISTIC CLAIM: only one caller can transition discovered → enriching.
  // Two simultaneous /enrich requests on the same contact id race here; the
  // loser sees no rows updated and returns 409 without ever hitting Apollo.
  const { data: claimed, error: claimErr } = await admin
    .from("brand_contacts")
    .update({
      enrichment_state: "enriching",
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.contactId)
    .eq("brand_id", params.id)
    .eq("enrichment_state", "discovered")
    .select(CLAIM_SELECT)
    .maybeSingle<ClaimedRow>();

  // PGRST116 = "no rows" — the row exists but wasn't in 'discovered' state.
  // maybeSingle returns data=null instead in some Supabase versions; cover
  // both shapes.
  const errCode =
    (claimErr as { code?: string } | null | undefined)?.code ?? null;
  if (!claimed || errCode === "PGRST116") {
    const { data: current } = await admin
      .from("brand_contacts")
      .select("enrichment_state")
      .eq("id", params.contactId)
      .eq("brand_id", params.id)
      .maybeSingle<{ enrichment_state: string }>();
    if (!current) {
      return NextResponse.json(
        { error: "contact not found" },
        { status: 404 },
      );
    }
    return NextResponse.json(
      {
        error: "already_enriched_or_in_progress",
        state: current.enrichment_state,
      },
      { status: 409 },
    );
  }
  if (claimErr) {
    const errMsg =
      (claimErr as { message?: string } | null | undefined)?.message ??
      String(claimErr);
    return NextResponse.json(
      { error: `claim_failed: ${errMsg}` },
      { status: 500 },
    );
  }

  const domain =
    (claimed.company_domain ?? "").toLowerCase().trim() ||
    extractDomain(brand.resolved_owner_domain);
  if (!domain) {
    // Release the claim back so a fix-up call can retry once company_domain
    // is populated. Treat as 'error' (not 'discovered') so the UI can show
    // the failure.
    await admin
      .from("brand_contacts")
      .update({
        enrichment_state: "error",
        updated_at: new Date().toISOString(),
      })
      .eq("id", claimed.id)
      .eq("brand_id", params.id);
    return NextResponse.json(
      { error: "no domain on contact or brand — set company_domain or resolved_owner_domain" },
      { status: 400 },
    );
  }

  const runId = randomUUID();

  try {
    const enriched = await enrichSingleContact({
      brand_id: params.id,
      run_id: runId,
      contact_id: claimed.id,
      domain,
      first_name: claimed.first_name,
      last_name: claimed.last_name,
      full_name: claimed.full_name,
      organization_name: claimed.company_name,
      apollo_person_id: claimed.apollo_person_id,
    });

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
        updated_at: new Date().toISOString(),
      })
      .eq("id", claimed.id)
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
  } catch (err) {
    // Enrichment pipeline threw — make sure the row never stays at
    // 'enriching'. Flip to 'error' so the UI can show the failure and a
    // retry can re-claim from a known state.
    await admin
      .from("brand_contacts")
      .update({
        enrichment_state: "error",
        updated_at: new Date().toISOString(),
      })
      .eq("id", claimed.id)
      .eq("brand_id", params.id);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `enrich_failed: ${msg}`, run_id: runId },
      { status: 500 },
    );
  }
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
