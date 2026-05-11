/**
 * Phase 47 → Phase 61 — /api/brands/[id]/contacts/discover
 *
 * POST: triggers Module 2. Only allowed when qualification is `complete`
 *       AND (`icp_verdict IN ('qualified','needs_review')` OR
 *       `manual_override=true`).
 *
 * GET (added in Phase 61): returns the current saved state without
 *      running discovery. Used by the Contact Discovery UI on page load
 *      so the card no longer renders empty when rows already exist in
 *      the DB. Returns `{ state, contacts, domain_pattern, is_catch_all,
 *      events }` — `events` is the per-run audit trail.
 */
import { NextResponse } from "next/server";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";
import { runContactDiscovery } from "@/lib/contacts/orchestrate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const CONTACT_SELECT =
  "id, full_name, title, linkedin_url, company_domain, email, email_status, email_source, email_verifier, email_verifier_score, email_verified_at, email_pattern_used, phone, phone_status, is_primary, ready_to_send";

const EVENT_SELECT =
  "id, brand_id, contact_id, run_id, provider, outcome, reason, email_returned, status_returned, score_returned, http_status, raw_payload, created_at";

function resolveDomainFromContacts(
  contacts: Array<{ company_domain: string | null }>,
): string | null {
  const c = contacts.find((x) => !!x.company_domain);
  return c?.company_domain ? c.company_domain.toLowerCase() : null;
}

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
    .select("id, contacts_state, resolved_owner_domain")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle<{
      id: string;
      contacts_state: string | null;
      resolved_owner_domain: string | null;
    }>();
  if (!brand) return NextResponse.json({ error: "not found" }, { status: 404 });

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  const { data: contacts } = await admin
    .from("brand_contacts")
    .select(CONTACT_SELECT)
    .eq("brand_id", params.id)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });

  const contactsList = contacts ?? [];

  const domainForCache =
    resolveDomainFromContacts(contactsList) ||
    (brand.resolved_owner_domain
      ? brand.resolved_owner_domain.toLowerCase()
      : null);

  let domain_pattern: string | null = null;
  let is_catch_all: boolean | null = null;
  if (domainForCache) {
    const { data: cache } = await admin
      .from("contact_domain_cache")
      .select("email_pattern, is_catch_all")
      .eq("domain", domainForCache)
      .maybeSingle();
    domain_pattern = cache?.email_pattern ?? null;
    is_catch_all = cache?.is_catch_all ?? null;
  }

  // Events: ordered ascending so the UI reads chronologically (Apollo
  // Search → Match → Hunter Domain → Hunter Finder → Pattern Guess →
  // MV → ZB). The UI groups by `run_id` and displays the latest run
  // first, older runs collapsed.
  const { data: events } = await admin
    .from("brand_contact_discovery_events")
    .select(EVENT_SELECT)
    .eq("brand_id", params.id)
    .order("created_at", { ascending: true });

  return NextResponse.json({
    state: brand.contacts_state ?? "pending",
    contacts: contactsList,
    domain_pattern,
    is_catch_all,
    events: events ?? [],
  });
}

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
    .select("id, qualification_state, resolved_owner_domain")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle<{
      id: string;
      qualification_state: string | null;
      resolved_owner_domain: string | null;
    }>();
  if (!brand) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const force = body?.force === true;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }
  const { data: qual } = await admin
    .from("brand_qualifications")
    .select("icp_verdict, manual_override, state")
    .eq("brand_id", params.id)
    .maybeSingle<{
      icp_verdict: string;
      manual_override: boolean;
      state: string;
    }>();

  if (!qual) {
    return NextResponse.json(
      { error: "qualification has not run yet" },
      { status: 400 },
    );
  }
  if (qual.state !== "complete") {
    return NextResponse.json(
      { error: `qualification state is ${qual.state}` },
      { status: 400 },
    );
  }
  const allowed =
    qual.icp_verdict === "qualified" ||
    qual.icp_verdict === "needs_review" ||
    qual.manual_override === true;
  if (!allowed && !force) {
    return NextResponse.json(
      {
        error:
          "verdict is disqualified — set manual_override or pass force:true to discover anyway",
      },
      { status: 400 },
    );
  }

  const result = await runContactDiscovery(params.id);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error ?? "discovery failed", state: result.state },
      { status: 500 },
    );
  }
  const { data: contacts } = await admin
    .from("brand_contacts")
    .select(CONTACT_SELECT)
    .eq("brand_id", params.id)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });

  const contactsList = contacts ?? [];
  const domainForCache =
    resolveDomainFromContacts(contactsList) ||
    (brand.resolved_owner_domain
      ? brand.resolved_owner_domain.toLowerCase()
      : null);

  let domain_pattern: string | null = null;
  let is_catch_all: boolean | null = null;
  if (domainForCache) {
    const { data: cache } = await admin
      .from("contact_domain_cache")
      .select("email_pattern, is_catch_all")
      .eq("domain", domainForCache)
      .maybeSingle();
    domain_pattern = cache?.email_pattern ?? null;
    is_catch_all = cache?.is_catch_all ?? null;
  }

  const { data: events } = await admin
    .from("brand_contact_discovery_events")
    .select(EVENT_SELECT)
    .eq("brand_id", params.id)
    .order("created_at", { ascending: true });

  return NextResponse.json({
    state: result.state,
    contacts: contactsList,
    domain_pattern,
    is_catch_all,
    events: events ?? [],
    run_id: result.run_id ?? null,
  });
}
