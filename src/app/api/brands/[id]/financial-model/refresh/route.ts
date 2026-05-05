/**
 * Phase 38 — POST /api/brands/:id/financial-model/refresh
 *
 * Manual refresh of the FINANCIAL MODEL section: re-runs
 * `computeLegionEconomics()` (via `persistBrandEconomics`) from the
 * current `brands` row inputs and writes the dollar columns back. No
 * external enrichment is triggered. The brand-detail UI calls this
 * when the user clicks the "Refresh" affordance on the section card.
 */
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { persistBrandEconomics } from "@/lib/brand-detail/persist-economics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
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

  // Confirm ownership before recomputing.
  const { data: brand, error: brandErr } = await supabase
    .from("brands")
    .select("id")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (brandErr) {
    return NextResponse.json({ error: brandErr.message }, { status: 500 });
  }
  if (!brand) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const result = await persistBrandEconomics(supabase as any, params.id);
  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        reason: result.reason ?? "unknown",
        error: result.error ?? null,
      },
      // not_ready (no Keepa enrichment yet) is a 409, everything else 500.
      { status: result.reason === "not_ready" ? 409 : 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
