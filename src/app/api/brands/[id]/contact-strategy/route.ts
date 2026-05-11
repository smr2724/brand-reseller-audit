/**
 * Phase 69 — Contact Strategy API.
 *
 *   GET  /api/brands/[id]/contact-strategy
 *     → returns the latest persisted contact_strategies row (if any)
 *
 *   POST /api/brands/[id]/contact-strategy
 *     → triggers buildContactStrategy(brand) and returns the new row id
 *
 * The orchestrator handles all error paths; route only enforces auth +
 * ownership.
 */
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { buildContactStrategy } from "@/lib/contacts/orchestrate-strategy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface BrandRow {
  id: string;
  name: string;
  resolved_owner_domain: string | null;
  trailing_12_months: number | null;
  confirmed_ttm_revenue_dollars: number | null;
  est_monthly_revenue: number | null;
  contact_strategy_id: string | null;
}

async function loadBrand(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  brandId: string,
  userId: string,
): Promise<BrandRow | null> {
  const { data } = await supabase
    .from("brands")
    .select(
      "id, name, resolved_owner_domain, trailing_12_months, confirmed_ttm_revenue_dollars, est_monthly_revenue, contact_strategy_id",
    )
    .eq("id", brandId)
    .eq("user_id", userId)
    .maybeSingle<BrandRow>();
  return data ?? null;
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const brand = await loadBrand(supabase, params.id, user.id);
  if (!brand) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: strategy } = await supabase
    .from("contact_strategies")
    .select("*")
    .eq("brand_id", params.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Phase 72 — surface qualification.updated_at alongside the strategy
  // row so the UI can flag a stale strategy (strategy.created_at <
  // qualification.updated_at → "Qualification updated — re-run contact
  // strategy" banner).
  const { data: qual } = await supabase
    .from("brand_qualifications")
    .select("updated_at")
    .eq("brand_id", params.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ updated_at: string | null }>();

  return NextResponse.json({
    strategy: strategy ?? null,
    qualification_updated_at: qual?.updated_at ?? null,
  });
}

export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const brand = await loadBrand(supabase, params.id, user.id);
  if (!brand) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const result = await buildContactStrategy({
    id: brand.id,
    name: brand.name,
    resolved_owner_domain: brand.resolved_owner_domain,
    trailing_12_months: brand.trailing_12_months,
    confirmed_ttm_revenue_dollars: brand.confirmed_ttm_revenue_dollars,
    est_monthly_revenue: brand.est_monthly_revenue,
  });

  return NextResponse.json(result);
}
