import { createSupabaseServerClient, createSupabaseAdminClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import BrandDetailClient from "./BrandDetailClient";
import BrandOwnerSection, {
  type BrandOwnerBrand,
  type BrandOwnerCandidate,
  type BrandOwnerRun,
} from "./BrandOwnerSection";
import { computeBrandDetailFinancials } from "@/lib/brand-detail/financial-model";

export const dynamic = "force-dynamic";

export default async function BrandDetail({ params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: brand } = await supabase
    .from("brands")
    .select("*")
    .eq("id", params.id)
    .eq("user_id", user!.id)
    .maybeSingle();

  if (!brand) notFound();

  const { data: asins } = await supabase
    .from("brand_asins")
    .select("*")
    .eq("brand_id", brand.id)
    .order("offers_count", { ascending: false })
    .limit(50);

  const { data: dfs } = await supabase
    .from("brand_search_metrics")
    .select(
      "branded_search_volume, branded_trend_pct, top_keywords, competitor_brands, organic_traffic_value, captured_at",
    )
    .eq("brand_id", brand.id)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Phase 33.1 — load latest resolver run + candidates for the new
  // Brand Owner section at the top of this page. We use the admin client
  // because owner_resolution_runs / owner_candidates aren't exposed under
  // RLS for end users; brand ownership is already enforced above.
  const adminDb = createSupabaseAdminClient();
  let ownerRun: BrandOwnerRun | null = null;
  let ownerCandidates: BrandOwnerCandidate[] = [];
  if (adminDb) {
    const { data: runs } = await adminDb
      .from("owner_resolution_runs")
      .select(
        "id, brand_id, triggered_by, started_at, completed_at, status, error_message, uspto_query, uspto_results_count, web_search_queries, web_search_results_count, candidates_inserted",
      )
      .eq("brand_id", brand.id)
      .order("started_at", { ascending: false })
      .limit(1);
    ownerRun = ((runs ?? [])[0] ?? null) as BrandOwnerRun | null;
    if (ownerRun) {
      const { data: cands } = await adminDb
        .from("owner_candidates")
        .select(
          "id, brand_id, resolution_run_id, candidate_company_name, candidate_domain, candidate_source, evidence_text, evidence_url, match_reason, trademark_serial_number, trademark_status, trademark_registration_date, trademark_owner_address, goods_services_text, heuristic_score, heuristic_label, is_selected_owner, needs_manual_review, selected_at, created_at, apollo_organization_id, apollo_organization_name, apollo_domain, apollo_employee_count, apollo_total_contacts, apollo_hq_city, apollo_hq_country, apollo_industry, extractor_confidence, extractor_reasoning, evidence_urls, is_manual_apollo, derived_from_candidate_id, apollo_search_attempted_at",
        )
        .eq("resolution_run_id", ownerRun.id)
        .order("apollo_total_contacts", { ascending: false, nullsFirst: false })
        .order("extractor_confidence", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });
      ownerCandidates = (cands ?? []) as BrandOwnerCandidate[];
    }
  }

  const ownerBrand: BrandOwnerBrand = {
    id: brand.id,
    name: brand.name,
    owner_resolution_state: brand.owner_resolution_state ?? "pending",
    owner_resolution_error: brand.owner_resolution_error ?? null,
    owner_resolved_at: brand.owner_resolved_at ?? null,
    resolved_owner_company_name: brand.resolved_owner_company_name ?? null,
    resolved_owner_domain: brand.resolved_owner_domain ?? null,
    resolved_owner_type: brand.resolved_owner_type ?? null,
    owner_resolution_notes: brand.owner_resolution_notes ?? null,
  };

  // Phase 26 — auto-populate the FINANCIAL MODEL panel as soon as
  // Keepa enrichment lands. Single source: computeLegionEconomics.
  // Phase 27 — pass brand-controlled share so the panel reads the same
  // recoverable-slice numbers the report does (margin only on revenue
  // currently leaking to resellers).
  const financials = computeBrandDetailFinancials(
    {
      keepa_last_enriched_at: brand.keepa_last_enriched_at,
      trailing_12_months: brand.trailing_12_months,
      est_monthly_revenue: brand.est_monthly_revenue,
      brand_controlled_pct: brand.keepa_brand_controlled_pct,
      // Phase 28 — user-confirmed TTM overrides the estimator path.
      confirmed_ttm_revenue_dollars: brand.confirmed_ttm_revenue_dollars,
      confirmed_ttm_source: brand.confirmed_ttm_source,
    },
    (asins ?? []).map((a) => ({ buy_box_price: a.buy_box_price ?? null })),
  );

  return (
    <div className="p-6 max-w-[1100px] mx-auto">
      <div className="mb-4">
        <Link href="/app/brands" className="text-sm text-[var(--text-muted)] hover:text-[var(--text)]">
          ← All brands
        </Link>
      </div>
      <BrandOwnerSection
        brand={ownerBrand}
        run={ownerRun}
        candidates={ownerCandidates}
      />
      <BrandDetailClient
        brand={brand}
        asins={asins ?? []}
        dfsMetrics={dfs ?? null}
        financials={financials}
      />
    </div>
  );
}
