/**
 * Phase 73 — POST /api/brands/[id]/contacts/enrich
 *
 * Bulk-enrich up to N candidates for a brand. Fixes the 405 the
 * "Enrich top 3" button on the merged Decision-Makers card surfaced
 * (the client was POSTing to this path, but no route existed at this
 * level — only the per-contact route at /contacts/[contactId]/enrich).
 *
 * Body (optional):
 *   { contactIds?: string[] }   — explicit list to enrich
 *   {}                          — enrich up to the first 3
 *                                 enrichment_state='discovered' contacts
 *
 * Returns 200 with per-contact status. Rows that are already
 * enriched / in-progress are skipped with `state='already'` so the
 * UI can render a stable "Already enriched" pill on each row.
 *
 * Implementation reuses `enrichSingleContact`, the same lib the
 * per-contact route uses — see the long comment in
 * `[contactId]/enrich/route.ts` for the idempotency contract. Each
 * row claims `discovered → enriching` atomically before burning an
 * Apollo credit; the try/finally pattern guarantees no row stays at
 * `enriching` after the request returns.
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

const CLAIM_SELECT =
  "id, brand_id, full_name, first_name, last_name, company_domain, apollo_person_id, company_name, enrichment_state";

const DEFAULT_MAX = 3;

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

interface PerResult {
  contact_id: string;
  state: "enriched" | "error" | "already" | "not_found" | "no_domain";
  contact?: Record<string, unknown> | null;
  error?: string;
  /** Phase 73 — extra LLM cost (web-search) on this row, when the
   *  last-resort step fired. 0 / undefined otherwise. */
  llm_cost_usd?: number;
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

  // Parse body — body is optional. An empty/invalid body falls back to
  // "enrich top 3 discovered rows".
  let requestedIds: string[] | null = null;
  try {
    const raw = await req.json();
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const ids = (raw as { contactIds?: unknown }).contactIds;
      if (Array.isArray(ids)) {
        requestedIds = ids.filter((x): x is string => typeof x === "string");
      }
    }
  } catch {
    /* no body or non-JSON body — fine, fall through to top-3 default */
  }

  let targetIds: string[];
  if (requestedIds && requestedIds.length > 0) {
    targetIds = requestedIds.slice(0, 10); // hard cap to avoid runaway
  } else {
    const { data: pending } = await admin
      .from("brand_contacts")
      .select("id")
      .eq("brand_id", params.id)
      .eq("enrichment_state", "discovered")
      .order("is_primary", { ascending: false })
      .limit(DEFAULT_MAX);
    targetIds = (pending ?? []).map((r) => r.id);
  }

  // Phase 73 NIT 6 — bulk enrich runs in parallel (spec §1a).
  // Each call does its own atomic discovered → enriching claim, so
  // there's no race between siblings. Promise.allSettled keeps a
  // single failure from short-circuiting the rest.
  const settled = await Promise.allSettled(
    targetIds.map((cid) =>
      enrichOne(admin, params.id, cid, brand.name, brand.resolved_owner_domain),
    ),
  );
  const results: PerResult[] = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          contact_id: targetIds[i],
          state: "error",
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        },
  );

  const llm_cost_usd = results.reduce(
    (acc, r) => acc + (typeof r.llm_cost_usd === "number" ? r.llm_cost_usd : 0),
    0,
  );

  return NextResponse.json({
    ok: true,
    enriched: results.filter((r) => r.state === "enriched").length,
    skipped: results.filter((r) => r.state === "already").length,
    errors: results.filter((r) => r.state === "error").length,
    llm_cost_usd,
    results,
  });
}

async function enrichOne(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  brandId: string,
  contactId: string,
  brandName: string | null,
  brandDomain: string | null,
): Promise<PerResult> {
  if (!admin) {
    return { contact_id: contactId, state: "error", error: "no_admin_client" };
  }
  // Claim: discovered → enriching.
  const { data: claimed, error: claimErr } = await admin
    .from("brand_contacts")
    .update({
      enrichment_state: "enriching",
      updated_at: new Date().toISOString(),
    })
    .eq("id", contactId)
    .eq("brand_id", brandId)
    .eq("enrichment_state", "discovered")
    .select(CLAIM_SELECT)
    .maybeSingle<ClaimedRow>();
  if (!claimed) {
    const { data: current } = await admin
      .from("brand_contacts")
      .select("enrichment_state")
      .eq("id", contactId)
      .eq("brand_id", brandId)
      .maybeSingle<{ enrichment_state: string }>();
    if (!current) {
      return { contact_id: contactId, state: "not_found" };
    }
    return { contact_id: contactId, state: "already" };
  }
  if (claimErr) {
    return {
      contact_id: contactId,
      state: "error",
      error: (claimErr as { message?: string }).message ?? String(claimErr),
    };
  }

  const domain =
    (claimed.company_domain ?? "").toLowerCase().trim() ||
    extractDomain(brandDomain);
  if (!domain) {
    await admin
      .from("brand_contacts")
      .update({
        enrichment_state: "error",
        updated_at: new Date().toISOString(),
      })
      .eq("id", claimed.id)
      .eq("brand_id", brandId);
    return { contact_id: contactId, state: "no_domain" };
  }

  const runId = randomUUID();
  try {
    const enriched = await enrichSingleContact({
      brand_id: brandId,
      run_id: runId,
      contact_id: claimed.id,
      domain,
      first_name: claimed.first_name,
      last_name: claimed.last_name,
      full_name: claimed.full_name,
      organization_name: claimed.company_name,
      apollo_person_id: claimed.apollo_person_id,
      brand_name: brandName,
    });
    // Phase 73 — persist `notes` when the LLM web-search step
    // resolved this row, so the audit copy ("Found via LLM web
    // search; source: …") sticks on the brand_contacts row.
    const baseUpdate: Record<string, unknown> = {
      email: enriched.email,
      email_source: enriched.email ? enriched.email_source : null,
      email_pattern_used: enriched.email_pattern_used,
      email_status: enriched.email ? enriched.email_status : "not_found",
      email_verifier: enriched.email_verifier,
      email_verifier_score: enriched.email_verifier_score,
      email_verified_at: enriched.email_verified_at,
      last_name: enriched.last_name,
      full_name: enriched.full_name,
    };
    if (enriched.notes) {
      baseUpdate.notes = enriched.notes;
    }
    const { data: updated, error: updateErr } = await admin
      .from("brand_contacts")
      .update({
        ...baseUpdate,
        raw_apollo_match: enriched.raw_apollo_match,
        raw_hunter: enriched.raw_hunter,
        ready_to_send: enriched.email_status === "verified",
        enrichment_state: "enriched",
        updated_at: new Date().toISOString(),
      })
      .eq("id", claimed.id)
      .eq("brand_id", brandId)
      .select(CONTACT_SELECT)
      .maybeSingle();
    if (updateErr) {
      throw new Error(
        `brand_contacts update failed: ${updateErr.message ?? String(updateErr)}`,
      );
    }
    return {
      contact_id: contactId,
      state: "enriched",
      contact: updated ?? null,
      llm_cost_usd: enriched.llm_cost_usd ?? 0,
    };
  } catch (err) {
    await admin
      .from("brand_contacts")
      .update({
        enrichment_state: "error",
        updated_at: new Date().toISOString(),
      })
      .eq("id", claimed.id)
      .eq("brand_id", brandId);
    return {
      contact_id: contactId,
      state: "error",
      error: err instanceof Error ? err.message : String(err),
    };
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
