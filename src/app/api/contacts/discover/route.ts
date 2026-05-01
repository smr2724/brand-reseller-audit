import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { discoverContactsForBrand } from "@/lib/outreach/discover";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const brandId: string | undefined = body.brand_id;
  if (!brandId) return NextResponse.json({ error: "brand_id required" }, { status: 400 });

  const { data: brand, error: brandErr } = await supabase
    .from("brands")
    .select("id, name, name_normalized, website, disqualifier_tags")
    .eq("id", brandId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (brandErr) return NextResponse.json({ error: brandErr.message }, { status: 500 });
  if (!brand) return NextResponse.json({ error: "brand not found" }, { status: 404 });

  if (!process.env.APOLLO_API_KEY) {
    return NextResponse.json({ error: "APOLLO_API_KEY not configured" }, { status: 503 });
  }

  const result = await discoverContactsForBrand(supabase as any, {
    userId: user.id,
    brand: brand as any,
  });

  if (!result.ok) {
    return NextResponse.json(result, { status: result.error?.includes("Apollo 4") ? 502 : 500 });
  }
  return NextResponse.json(result);
}
