/**
 * Phase 34.2 — POST /api/owner-resolver/add-extractor-candidate
 *
 * Lets the user append a free-text candidate to the transparency
 * checkpoint. Inserts a row into `owner_candidates` with
 * `candidate_source = 'extractor_manual'`, attached to the brand's
 * latest resolution run. The user can then check it and submit it for
 * Apollo lookup like any other extractor candidate.
 *
 * Body: { brand_id: string, company_name: string, domain?: string }
 *
 * Auth: Supabase user session matching brands.user_id, or service-role.
 *
 * State gate: brand must be in `awaiting_apollo_selection` so we don't
 * inject manual extractor rows while Apollo is mid-flight or after the
 * pipeline already finished.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { authorizeOwnerResolverRequest } from "@/lib/owner-resolver/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 30;

const Body = z.object({
  brand_id: z.string().trim().min(1),
  company_name: z.string().trim().min(1).max(200),
  domain: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
});

function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  try {
    if (/^https?:\/\//.test(s)) {
      s = new URL(s).hostname;
    }
  } catch {
    // ignore
  }
  s = s.replace(/^www\./, "").replace(/\/+$/, "");
  return s.length > 0 ? s : null;
}

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = Body.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", details: parsed.error.format() },
      { status: 400 },
    );
  }
  const { brand_id, company_name, domain } = parsed.data;

  const auth = await authorizeOwnerResolverRequest(req, brand_id);
  if (auth.kind === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  const { data: brand } = await admin
    .from("brands")
    .select("id, owner_resolution_state")
    .eq("id", brand_id)
    .maybeSingle();
  if (!brand) {
    return NextResponse.json({ error: "brand not found" }, { status: 404 });
  }
  const state = String(
    (brand as { owner_resolution_state?: string }).owner_resolution_state ??
      "pending",
  );
  if (state !== "awaiting_apollo_selection") {
    return NextResponse.json(
      {
        error: `brand state is ${state} — manual extractor add only allowed in awaiting_apollo_selection`,
      },
      { status: 409 },
    );
  }

  const { data: runs } = await admin
    .from("owner_resolution_runs")
    .select("id")
    .eq("brand_id", brand_id)
    .order("started_at", { ascending: false })
    .limit(1);
  const latestRunId = ((runs ?? [])[0] as { id?: string } | undefined)?.id ?? null;
  if (!latestRunId) {
    return NextResponse.json(
      { error: "brand has no resolution runs" },
      { status: 400 },
    );
  }

  const normalizedDomain = domain ? normalizeDomain(domain) : null;

  const row = {
    brand_id,
    resolution_run_id: latestRunId,
    candidate_company_name: company_name,
    candidate_domain: normalizedDomain,
    candidate_source: "extractor_manual",
    evidence_text: "User-added extractor candidate",
    evidence_url: null,
    match_reason: "User-added at the Apollo selection checkpoint",
    trademark_serial_number: null,
    trademark_status: null,
    trademark_registration_date: null,
    trademark_owner_address: null,
    goods_services_text: null,
    heuristic_score: 0,
    heuristic_label: "unscored",
    needs_manual_review: false,
    raw_payload: { manual: true, source: "extractor_manual" },
    apollo_organization_id: null,
    apollo_organization_name: null,
    apollo_domain: null,
    apollo_employee_count: null,
    apollo_total_contacts: null,
    apollo_hq_city: null,
    apollo_hq_country: null,
    apollo_industry: null,
    extractor_confidence: null,
    extractor_reasoning: "Added by user at the Apollo selection checkpoint",
    evidence_urls: null,
  };

  const { data: ins, error: insErr } = await admin
    .from("owner_candidates")
    .insert(row)
    .select(
      "id, brand_id, resolution_run_id, candidate_company_name, candidate_domain, candidate_source, evidence_text, evidence_url, match_reason, trademark_serial_number, trademark_status, trademark_registration_date, trademark_owner_address, goods_services_text, heuristic_score, heuristic_label, is_selected_owner, needs_manual_review, selected_at, created_at, apollo_organization_id, apollo_organization_name, apollo_domain, apollo_employee_count, apollo_total_contacts, apollo_hq_city, apollo_hq_country, apollo_industry, extractor_confidence, extractor_reasoning, evidence_urls, is_manual_apollo, derived_from_candidate_id, apollo_search_attempted_at",
    )
    .single();
  if (insErr) {
    return NextResponse.json(
      { error: `insert failed: ${insErr.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, candidate: ins });
}
