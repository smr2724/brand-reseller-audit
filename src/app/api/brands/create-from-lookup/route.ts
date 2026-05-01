import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";
import { enrichBrandWithKeepa } from "@/lib/enrichment/keepa-brand";
import { enrichBrandWithDataForSeo } from "@/lib/enrichment/dataforseo";
import { normalizeName } from "@/lib/importer/merge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Keepa search + product details + DFS branded SERP can run 30-90s.
export const maxDuration = 300;

const Body = z.object({
  brand: z.string().trim().min(1).max(200),
  category: z.string().trim().max(120).optional(),
});

export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let parsed;
  try {
    parsed = Body.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  const brandName = parsed.data.brand;
  const norm = normalizeName(brandName);

  // Reuse if the user already has this brand.
  const { data: existing } = await supabase
    .from("brands")
    .select("id")
    .eq("user_id", user.id)
    .eq("name_normalized", norm)
    .maybeSingle();

  let brandId: string;
  if (existing?.id) {
    brandId = existing.id;
  } else {
    const { data: created, error: insErr } = await supabase
      .from("brands")
      .insert({
        user_id: user.id,
        name: brandName,
        name_normalized: norm,
        category: parsed.data.category ?? null,
        status: "new",
      })
      .select("id")
      .single();
    if (insErr || !created) {
      return NextResponse.json(
        { error: insErr?.message ?? "insert failed" },
        { status: 500 },
      );
    }
    brandId = created.id;
  }

  // Run enrichment synchronously — Phase 6.7 hotfix lesson: no
  // fire-and-forget. The client expects the brand to be enriched
  // before redirecting to the detail page.
  let keepaError: string | null = null;
  let dfsError: string | null = null;
  try {
    const summary = await enrichBrandWithKeepa(admin, {
      brand_id: brandId,
      brand_name: brandName,
      user_id: user.id,
    });
    if (summary.enrichment_error) keepaError = summary.enrichment_error;
  } catch (e) {
    keepaError = e instanceof Error ? e.message : String(e);
  }

  try {
    const snap = await enrichBrandWithDataForSeo(admin, {
      brand_id: brandId,
      brand_name: brandName,
      user_id: user.id,
    });
    if (snap.enrichment_error) dfsError = snap.enrichment_error;
  } catch (e) {
    dfsError = e instanceof Error ? e.message : String(e);
  }

  return NextResponse.json({
    brand_id: brandId,
    keepa_error: keepaError,
    dataforseo_error: dfsError,
  });
}
