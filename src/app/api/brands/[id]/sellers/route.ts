/**
 * Phase 39 — GET the brand_sellers rows for the SellerClassificationModal.
 *
 * Returns rows ordered by share_pct desc with everything the modal needs
 * to render the table (name, share, ASINs, FBA, country, current
 * classification + attribution).
 */
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Confirm the brand belongs to the user before exposing seller data.
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

  const { data: sellers, error: sellersErr } = await supabase
    .from("brand_sellers")
    .select(
      "id, seller_name, seller_id, seller_country, share_pct, asins_won, is_fba, is_brand_controlled, classification_reason, classification, classified_by_user_id, classified_at",
    )
    .eq("brand_id", params.id)
    .order("share_pct", { ascending: false, nullsFirst: false });
  if (sellersErr) {
    return NextResponse.json({ error: sellersErr.message }, { status: 500 });
  }

  return NextResponse.json({ sellers: sellers ?? [] });
}
