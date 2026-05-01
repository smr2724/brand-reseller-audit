import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseAdminClient } from "@/lib/supabase/server";
import { enrichBrandWithDataForSeo } from "@/lib/enrichment/dataforseo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: brand, error } = await supabase
    .from("brands")
    .select("id, name")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!brand) return NextResponse.json({ error: "not found" }, { status: 404 });

  // DataForSEO enrichment writes to dataforseo_cache (cross-user) and
  // brand_search_metrics (owner-scoped). Use the admin client when available
  // so the cache table stays writable from server code.
  const admin = createSupabaseAdminClient() ?? (supabase as any);

  try {
    const snapshot = await enrichBrandWithDataForSeo(admin, {
      brand_id: brand.id,
      brand_name: brand.name,
      user_id: user.id,
    });
    return NextResponse.json({ ok: true, snapshot });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
