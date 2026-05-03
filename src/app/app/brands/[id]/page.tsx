import { createSupabaseServerClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import BrandDetailClient from "./BrandDetailClient";
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
      <BrandDetailClient
        brand={brand}
        asins={asins ?? []}
        dfsMetrics={dfs ?? null}
        financials={financials}
      />
    </div>
  );
}
