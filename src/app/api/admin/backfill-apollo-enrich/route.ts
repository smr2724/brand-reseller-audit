/**
 * Phase 38.1 — Backfill route for Bug 2.
 *
 * For every owner_candidates row where `apollo_organization_id` is set
 * but `apollo_employee_count` is null (i.e. the row was inserted before
 * Phase 38.1 wired in the organizations/enrich follow-up), call
 * `organizations/enrich` (preferring `apollo_domain`, falling back to
 * `apollo_organization_id`) and write the resulting
 * `estimated_num_employees` into `apollo_employee_count`. Also merges
 * the enriched payload into `raw_payload.apollo` so future reads see
 * the full org details.
 *
 * Optional body:
 *   { candidate_ids: ["<uuid>", ...] } — backfill specific rows only.
 *   { brand_id: "<uuid>" } — limit to one brand.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` or service role key.
 *
 * Safety belts:
 *   runtime = nodejs
 *   dynamic = force-dynamic
 *   fetchCache = force-no-store
 *   revalidate = 0
 *   maxDuration = 300
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { createApolloClient } from "@/lib/owner-resolver/apollo-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 300;

function authorize(req: Request): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const cronHeader = req.headers.get("x-vercel-cron-signature");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    if (auth === `Bearer ${cronSecret}`) return true;
    if (cronHeader && cronHeader === cronSecret) return true;
  }
  const sr = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (sr && auth === `Bearer ${sr}`) return true;
  return false;
}

interface CandidateRow {
  id: string;
  brand_id: string;
  apollo_organization_id: string | null;
  apollo_domain: string | null;
  apollo_employee_count: number | null;
  apollo_estimated_employees: number | null;
  raw_payload: Record<string, unknown> | null;
}

export async function POST(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const candidateIds: string[] | null = Array.isArray(body?.candidate_ids)
    ? body.candidate_ids
        .filter((s: unknown) => typeof s === "string" && s.trim())
        .map((s: string) => s.trim())
    : null;
  const brandId =
    typeof body?.brand_id === "string" && body.brand_id.trim()
      ? body.brand_id.trim()
      : null;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  const apollo = createApolloClient({ searchBudget: 200 });
  if (!apollo) {
    return NextResponse.json(
      { error: "APOLLO_API_KEY not configured" },
      { status: 500 },
    );
  }

  let q = admin
    .from("owner_candidates")
    .select(
      "id, brand_id, apollo_organization_id, apollo_domain, apollo_employee_count, apollo_estimated_employees, raw_payload",
    )
    .not("apollo_organization_id", "is", null)
    .is("apollo_employee_count", null);
  if (candidateIds && candidateIds.length) {
    q = q.in("id", candidateIds);
  } else if (brandId) {
    q = q.eq("brand_id", brandId);
  }
  const { data: rows, error: rowsErr } = await q;
  if (rowsErr) {
    return NextResponse.json(
      { error: `owner_candidates select: ${rowsErr.message}` },
      { status: 500 },
    );
  }

  const candidates = (rows ?? []) as CandidateRow[];
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const results: Array<{
    id: string;
    domain: string | null;
    org_id: string | null;
    employee_count: number | null;
    ok: boolean;
    error?: string;
  }> = [];

  for (const c of candidates) {
    try {
      const enriched = await apollo.enrichOrganization({
        domain: c.apollo_domain ?? null,
        id: c.apollo_organization_id ?? null,
      });
      if (!enriched) {
        skipped += 1;
        results.push({
          id: c.id,
          domain: c.apollo_domain,
          org_id: c.apollo_organization_id,
          employee_count: null,
          ok: false,
          error: "enrich_no_match",
        });
        continue;
      }
      const newEmployeeCount = enriched.estimated_num_employees ?? null;
      const mergedPayload = mergeApolloPayload(c.raw_payload ?? null, enriched);
      const patch: Record<string, unknown> = {
        apollo_employee_count: newEmployeeCount,
        raw_payload: mergedPayload,
      };
      const { error: upErr } = await admin
        .from("owner_candidates")
        .update(patch)
        .eq("id", c.id);
      if (upErr) {
        failed += 1;
        results.push({
          id: c.id,
          domain: c.apollo_domain,
          org_id: c.apollo_organization_id,
          employee_count: null,
          ok: false,
          error: upErr.message,
        });
        continue;
      }
      updated += 1;
      results.push({
        id: c.id,
        domain: c.apollo_domain,
        org_id: c.apollo_organization_id,
        employee_count: newEmployeeCount,
        ok: true,
      });
    } catch (e: any) {
      failed += 1;
      results.push({
        id: c.id,
        domain: c.apollo_domain,
        org_id: c.apollo_organization_id,
        employee_count: null,
        ok: false,
        error: e?.message ?? String(e),
      });
    }
  }

  return NextResponse.json({
    candidates: candidates.length,
    updated,
    skipped,
    failed,
    results,
  });
}

function mergeApolloPayload(
  existing: Record<string, unknown> | null,
  enriched: object,
): Record<string, unknown> {
  const base = existing && typeof existing === "object" ? { ...existing } : {};
  const apollo =
    base.apollo && typeof base.apollo === "object"
      ? { ...(base.apollo as Record<string, unknown>) }
      : {};
  // Enriched fields win — search-side payload was sparse on purpose.
  Object.assign(apollo, enriched as Record<string, unknown>);
  base.apollo = apollo;
  return base;
}
