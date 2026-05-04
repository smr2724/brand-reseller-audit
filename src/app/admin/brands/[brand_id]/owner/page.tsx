/**
 * Phase 33 — Admin UI: brand owner candidate review.
 *
 * Server component that loads the latest resolution run and its candidates
 * directly from Supabase (admin client) and hands them to the client
 * component for selection. Auth: any authenticated user can view; mutating
 * actions go through the API routes which require CRON_SECRET / service-role.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import OwnerResolverClient, { type CandidateRow, type RunRow, type BrandRow } from "./OwnerResolverClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export default async function BrandOwnerResolverPage({
  params,
}: {
  params: { brand_id: string };
}) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return (
      <div className="p-6 max-w-[1100px] mx-auto">
        <h1 className="text-xl font-semibold">Brand Owner Resolver</h1>
        <p className="text-sm text-red-600 mt-2">
          Server is missing SUPABASE_SERVICE_ROLE_KEY. Configure it before using
          this page.
        </p>
      </div>
    );
  }

  const { data: brand } = await admin
    .from("brands")
    .select(
      "id, name, category, owner_resolution_state, owner_resolution_error, owner_resolved_at, resolved_owner_company_name, resolved_owner_domain, resolved_owner_type, owner_resolution_notes",
    )
    .eq("id", params.brand_id)
    .maybeSingle();
  if (!brand) notFound();

  const { count: asinCount } = await admin
    .from("brand_asins")
    .select("*", { count: "exact", head: true })
    .eq("brand_id", params.brand_id);

  const { data: runs } = await admin
    .from("owner_resolution_runs")
    .select(
      "id, brand_id, triggered_by, started_at, completed_at, status, error_message, uspto_query, uspto_results_count, web_search_queries, web_search_results_count, candidates_inserted",
    )
    .eq("brand_id", params.brand_id)
    .order("started_at", { ascending: false })
    .limit(1);
  const latestRun = (runs ?? [])[0] ?? null;

  let candidates: CandidateRow[] = [];
  if (latestRun) {
    const { data: cands } = await admin
      .from("owner_candidates")
      .select(
        "id, brand_id, resolution_run_id, candidate_company_name, candidate_domain, candidate_source, evidence_text, evidence_url, match_reason, trademark_serial_number, trademark_status, trademark_registration_date, trademark_owner_address, goods_services_text, heuristic_score, heuristic_label, is_selected_owner, needs_manual_review, selected_at, created_at",
      )
      .eq("resolution_run_id", (latestRun as { id: string }).id)
      .order("heuristic_score", { ascending: false })
      .order("created_at", { ascending: false });
    candidates = (cands ?? []) as CandidateRow[];
  }

  return (
    <div className="p-6 max-w-[1100px] mx-auto">
      <div className="mb-4">
        <Link
          href={`/app/brands/${params.brand_id}`}
          className="text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          ← Back to brand
        </Link>
      </div>
      <OwnerResolverClient
        brand={brand as BrandRow}
        asinCount={asinCount ?? 0}
        run={(latestRun ?? null) as RunRow | null}
        candidates={candidates}
      />
    </div>
  );
}
