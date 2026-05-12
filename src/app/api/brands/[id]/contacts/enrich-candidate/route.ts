/**
 * Phase 73.1 — POST /api/brands/[id]/contacts/enrich-candidate
 *
 * Per-row "Enrich" for a named candidate that has no `brand_contacts`
 * row yet (e.g., a Gate-C-sourced decision-maker that the strategy
 * run produced but didn't fully resolve). The merged Decision-Makers
 * card used to show "not seeded" with no action; now each unenriched
 * row gets an Enrich button that POSTs here.
 *
 * Body:
 *   { name: string, title?: string|null, linkedin_url?: string|null }
 *
 * Behavior:
 *   1. Look up an existing brand_contacts row by case-insensitive
 *      full_name match (server-side ilike, scoped by brand_id).
 *   2. If a row exists with a non-null email AND state='enriched',
 *      return it as `state='already'`.
 *   3. If a row exists in `discovered` state, claim it and run the
 *      enrich chain.
 *   4. Phase 73.1 retry-from-terminal-but-empty: if a row exists in
 *      `enriched` (no email) or `error` state, reset to `enriching`
 *      and run the enrich chain again. This is the "Retry" path
 *      surfaced in the UI.
 *   5. Otherwise insert a new `discovered` row then run the chain.
 *      On 23505 unique-violation (race against a concurrent click),
 *      fall back to SELECT-by-name and proceed with the existing row.
 *
 * The chain is `enrichSingleContact` — Apollo → Hunter-finder →
 * 8-pattern → LLM web-search with MV gating at every step.
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

interface Body {
  name?: string;
  title?: string | null;
  linkedin_url?: string | null;
}

interface ExistingRow {
  id: string;
  full_name: string | null;
  email: string | null;
  enrichment_state: string | null;
}

function splitName(full: string): { first: string | null; last: string | null } {
  const t = full.trim();
  if (!t) return { first: null, last: null };
  const parts = t.split(/\s+/);
  if (parts.length === 1) return { first: parts[0]!, last: null };
  return {
    first: parts[0]!,
    last: parts.slice(1).join(" "),
  };
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

/**
 * Case-insensitive name match scoped by brand_id. Uses Postgres
 * `lower(full_name)=lower($1)` semantics via `.ilike` with no
 * wildcards — server-side, no full-table scan in JS.
 */
function escapeIlike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
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
    .select("id, name, resolved_owner_domain")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle<{
      id: string;
      name: string;
      resolved_owner_domain: string | null;
    }>();
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

  const body = (await req.json().catch(() => ({}))) as Body;
  const rawName = typeof body.name === "string" ? body.name.trim() : "";
  if (!rawName) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  const title =
    typeof body.title === "string" && body.title.trim().length > 0
      ? body.title.trim()
      : null;
  const linkedin_url =
    typeof body.linkedin_url === "string" && body.linkedin_url.trim().length > 0
      ? body.linkedin_url.trim()
      : null;

  const domain = extractDomain(brand.resolved_owner_domain);
  if (!domain) {
    return NextResponse.json(
      {
        error:
          "no domain on brand — set resolved_owner_domain before enriching",
      },
      { status: 400 },
    );
  }

  const split = splitName(rawName);
  const firstName = split.first;
  const lastName = split.last;

  // 1. Server-side case-insensitive lookup. The unique index
  // (brand_id, lower(full_name)) means there is at most one row.
  let existing = await findByName(admin, params.id, rawName);

  // 2. Already-enriched short-circuit: row exists with a non-null
  // email AND state='enriched'. We do NOT short-circuit on
  // state='enriched' + email IS NULL — that's the Phase 73.1
  // retry-from-empty path (see step 4).
  if (
    existing &&
    existing.email &&
    existing.enrichment_state === "enriched"
  ) {
    const { data: fresh } = await admin
      .from("brand_contacts")
      .select(CONTACT_SELECT)
      .eq("id", existing.id)
      .maybeSingle();
    return NextResponse.json({
      ok: true,
      state: "already",
      contact: fresh ?? null,
    });
  }

  let contactId: string;
  if (existing) {
    contactId = existing.id;
  } else {
    // 3. Seed a new discovered row. On 23505 unique-violation
    // (concurrent click on the same name beat us), fall through to
    // a SELECT and adopt the row that won the race.
    const { data: ins, error: insErr } = await admin
      .from("brand_contacts")
      .insert({
        brand_id: params.id,
        full_name: rawName,
        first_name: firstName,
        last_name: lastName,
        title,
        linkedin_url,
        company_domain: domain,
        is_primary: false,
        enrichment_state: "discovered",
        email_source: null,
        ready_to_send: false,
      })
      .select("id")
      .maybeSingle<{ id: string }>();
    if (insErr) {
      const code = (insErr as { code?: string }).code ?? "";
      if (code === "23505") {
        existing = await findByName(admin, params.id, rawName);
        if (!existing) {
          // 23505 fired but the SELECT can't see the winner — very
          // unlikely (replication lag in a tiny window). Surface a
          // generic 409 so the client can retry.
          return NextResponse.json(
            { error: "concurrent_seed_conflict_retry" },
            { status: 409 },
          );
        }
        contactId = existing.id;
        // If the winner is already enriched with an email, short
        // circuit the same way step 2 does.
        if (
          existing.email &&
          existing.enrichment_state === "enriched"
        ) {
          const { data: fresh } = await admin
            .from("brand_contacts")
            .select(CONTACT_SELECT)
            .eq("id", existing.id)
            .maybeSingle();
          return NextResponse.json({
            ok: true,
            state: "already",
            contact: fresh ?? null,
          });
        }
      } else {
        return NextResponse.json(
          { error: "seed_failed" },
          { status: 500 },
        );
      }
    } else if (!ins) {
      return NextResponse.json(
        { error: "seed_failed" },
        { status: 500 },
      );
    } else {
      contactId = ins.id;
    }
  }

  // 4. Claim. Two eligible source states:
  //    - 'discovered': normal first-attempt path
  //    - 'enriched' with empty email, or 'error': retry path. The
  //      previous chain completed (or threw); the row is terminal
  //      but the user wants another shot — possibly because Apollo
  //      credits got topped up, or the LLM web-search index has
  //      newer pages, or we just want to retry a transient error.
  //
  // Both transitions update to 'enriching' atomically so a
  // double-click never burns Apollo credits twice on the same row.
  const claimed = await claimForEnrichment(admin, params.id, contactId);
  if (!claimed) {
    const { data: current } = await admin
      .from("brand_contacts")
      .select(CONTACT_SELECT)
      .eq("id", contactId)
      .eq("brand_id", params.id)
      .maybeSingle();
    return NextResponse.json({
      ok: true,
      state: "already",
      contact: current ?? null,
    });
  }

  const runId = randomUUID();
  try {
    const enriched = await enrichSingleContact({
      brand_id: params.id,
      run_id: runId,
      contact_id: claimed.id,
      domain: (claimed.company_domain ?? "").toLowerCase().trim() || domain,
      first_name: claimed.first_name ?? firstName,
      last_name: claimed.last_name ?? lastName,
      full_name: claimed.full_name,
      organization_name: claimed.company_name,
      apollo_person_id: claimed.apollo_person_id,
      brand_name: brand.name,
    });

    const updateBase: Record<string, unknown> = {
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
    };
    if (enriched.notes) {
      updateBase.notes = enriched.notes;
    }
    const { data: updated, error: updateErr } = await admin
      .from("brand_contacts")
      .update(updateBase)
      .eq("id", claimed.id)
      .eq("brand_id", params.id)
      .select(CONTACT_SELECT)
      .maybeSingle();
    if (updateErr) {
      throw new Error(
        `brand_contacts update failed: ${updateErr.message ?? String(updateErr)}`,
      );
    }

    const { data: events } = await admin
      .from("brand_contact_discovery_events")
      .select(EVENT_SELECT)
      .eq("brand_id", params.id)
      .eq("run_id", runId)
      .order("created_at", { ascending: true });

    return NextResponse.json({
      ok: true,
      state: "enriched",
      contact: updated ?? null,
      events: events ?? [],
      run_id: runId,
      llm_cost_usd: enriched.llm_cost_usd ?? 0,
    });
  } catch (err) {
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

async function findByName(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  brandId: string,
  name: string,
): Promise<ExistingRow | null> {
  const { data } = await admin
    .from("brand_contacts")
    .select("id, full_name, email, enrichment_state")
    .eq("brand_id", brandId)
    .ilike("full_name", escapeIlike(name))
    .limit(1)
    .maybeSingle<ExistingRow>();
  return data ?? null;
}

/**
 * Atomic claim: `discovered → enriching` (first attempt), OR
 * `error → enriching` (retry after a failed run), OR
 * `enriched-with-empty-email → enriching` (retry after the chain
 * couldn't find anything the first time).
 *
 * Always touches at most one row; returns null if no row was
 * eligible (i.e. another caller already owns the enrich).
 */
async function claimForEnrichment(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  brandId: string,
  contactId: string,
) {
  // First try: discovered → enriching.
  const { data: discovered } = await admin
    .from("brand_contacts")
    .update({
      enrichment_state: "enriching",
      updated_at: new Date().toISOString(),
    })
    .eq("id", contactId)
    .eq("brand_id", brandId)
    .eq("enrichment_state", "discovered")
    .select(CLAIM_SELECT)
    .maybeSingle();
  if (discovered) return discovered as ClaimedRow;

  // Second try: error → enriching (retry after a failed run).
  const { data: errored } = await admin
    .from("brand_contacts")
    .update({
      enrichment_state: "enriching",
      updated_at: new Date().toISOString(),
    })
    .eq("id", contactId)
    .eq("brand_id", brandId)
    .eq("enrichment_state", "error")
    .select(CLAIM_SELECT)
    .maybeSingle();
  if (errored) return errored as ClaimedRow;

  // Third try: enriched + empty email → enriching (retry from a
  // terminal-but-empty state — e.g., the chain finished but every
  // step missed, and the user wants another shot).
  const { data: enrichedEmpty } = await admin
    .from("brand_contacts")
    .update({
      enrichment_state: "enriching",
      updated_at: new Date().toISOString(),
    })
    .eq("id", contactId)
    .eq("brand_id", brandId)
    .eq("enrichment_state", "enriched")
    .is("email", null)
    .select(CLAIM_SELECT)
    .maybeSingle();
  if (enrichedEmpty) return enrichedEmpty as ClaimedRow;

  return null;
}

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
