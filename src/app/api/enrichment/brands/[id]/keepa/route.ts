import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { enrichBrandWithKeepa } from "@/lib/enrichment/keepa-brand";
import { maybeTriggerOwnerResolution } from "@/lib/owner-resolver/triggers";
import { persistBrandEconomics } from "@/lib/brand-detail/persist-economics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: brand, error } = await supabase
    .from("brands")
    .select("id, name, disqualifier_tags")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!brand) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Phase 30 — keep enrichment_state in sync with the manual "Re-run
  // Keepa" button so the recovery cron's filter (pending|failed) doesn't
  // pick this brand back up mid-run.
  await supabase
    .from("brands")
    .update({ enrichment_state: "enriching", updated_at: new Date().toISOString() })
    .eq("id", brand.id)
    .eq("user_id", user.id);

  try {
    const summary = await enrichBrandWithKeepa(supabase as any, {
      brand_id: brand.id,
      brand_name: brand.name,
      user_id: user.id,
      existing_disqualifier_tags: brand.disqualifier_tags ?? [],
    });
    const enrichedNow = !(summary.enrichment_error || summary.asin_count === 0);
    // Phase 37 — belt-and-suspenders: when the enrich call succeeded,
    // explicitly clear `enrichment_error` here in case the inner
    // `enrichBrandWithKeepa` write didn't reach this column (e.g. a
    // partial-success path). The enrichment card's banner reads from
    // this column on RSC refresh, so a stale value would re-paint the
    // "string did not match the expected pattern" message even though
    // the call succeeded.
    await supabase
      .from("brands")
      .update({
        enrichment_state: enrichedNow ? "enriched" : "failed",
        ...(enrichedNow ? { enrichment_error: null } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", brand.id)
      .eq("user_id", user.id);
    if (enrichedNow) {
      // Phase 38 — persist computeLegionEconomics output to the brand
      // row so the brand page (and any downstream consumer) reads
      // numbers from the database instead of re-deriving them every
      // render. Best-effort: a write failure does not fail the
      // enrichment response.
      try {
        const persisted = await persistBrandEconomics(supabase as any, brand.id);
        if (!persisted.ok) {
          console.warn(
            "[api/enrichment/keepa] persistBrandEconomics skipped/failed:",
            persisted.reason ?? "unknown",
            persisted.error ?? "",
          );
        }
      } catch (e) {
        console.warn("[api/enrichment/keepa] persistBrandEconomics threw:", e);
      }
      maybeTriggerOwnerResolution(brand.id);
    }
    return NextResponse.json({ ok: true, summary });
  } catch (e: any) {
    await supabase
      .from("brands")
      .update({ enrichment_state: "failed", updated_at: new Date().toISOString() })
      .eq("id", brand.id)
      .eq("user_id", user.id);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
