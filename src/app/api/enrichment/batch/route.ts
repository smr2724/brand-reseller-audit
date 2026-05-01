import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { enrichBrandWithKeepa } from "@/lib/enrichment/keepa-brand";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface BatchBody {
  brand_ids?: string[];
  dry_run?: boolean;
}

export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as BatchBody;
  const ids = Array.isArray(body.brand_ids) ? body.brand_ids.filter((s) => typeof s === "string") : [];
  if (!ids.length) return NextResponse.json({ error: "brand_ids required" }, { status: 400 });
  if (ids.length > 50) return NextResponse.json({ error: "max 50 brands per batch" }, { status: 400 });

  const { data: brands, error } = await supabase
    .from("brands")
    .select("id, name, disqualifier_tags")
    .in("id", ids)
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const found = brands ?? [];
  const estimatedTokens = found.length * 100;

  if (body.dry_run) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      brand_count: found.length,
      estimated_tokens: estimatedTokens,
      estimated_minutes: Math.ceil(estimatedTokens / 300),
      brands: found.map((b: any) => ({ id: b.id, name: b.name })),
    });
  }

  const results: Array<{ brand_id: string; ok: boolean; summary?: any; error?: string }> = [];
  for (const b of found) {
    try {
      const summary = await enrichBrandWithKeepa(supabase as any, {
        brand_id: b.id,
        brand_name: b.name,
        user_id: user.id,
        existing_disqualifier_tags: b.disqualifier_tags ?? [],
      });
      results.push({ brand_id: b.id, ok: true, summary });
    } catch (e: any) {
      results.push({ brand_id: b.id, ok: false, error: String(e?.message ?? e) });
    }
  }

  return NextResponse.json({
    ok: true,
    brand_count: found.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}
