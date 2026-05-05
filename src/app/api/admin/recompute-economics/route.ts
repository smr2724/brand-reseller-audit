/**
 * Phase 38.1 — Backfill route for Bug 1.
 *
 * Loops every brand whose Keepa enrichment has landed
 * (`keepa_last_enriched_at IS NOT NULL`) and re-runs `persistBrandEconomics`.
 * After the new revenue source-of-truth wiring (Phase 38.1), this rewrites
 * `brands.trailing_12_months` and `brands.est_monthly_revenue` from the
 * report's canonical Keepa-monthly-sold + BSR-fallback summed-across-catalog
 * calculator, and refreshes the downstream `computeLegionEconomics` columns.
 *
 * Optional body:
 *   { brand_id: "<uuid>" } — recompute a single brand only.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` or service role key.
 *
 * Safety belts:
 *   runtime = nodejs
 *   dynamic = force-dynamic
 *   fetchCache = force-no-store
 *   revalidate = 0
 *   maxDuration = 300
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { persistBrandEconomics } from "@/lib/brand-detail/persist-economics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 300;

function authorize(req: Request): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const cronHeader = req.headers.get("x-vercel-cron-signature");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    if (auth === `Bearer ${cronSecret}`) return true;
    if (cronHeader && cronHeader === cronSecret) return true;
  }
  const sr = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (sr && auth === `Bearer ${sr}`) return true;
  return false;
}

interface BrandRow {
  id: string;
  name: string | null;
  trailing_12_months: number | null;
}

export async function POST(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const brandId =
    typeof body?.brand_id === "string" && body.brand_id.trim()
      ? body.brand_id.trim()
      : null;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  let q = admin
    .from("brands")
    .select("id, name, trailing_12_months")
    .not("keepa_last_enriched_at", "is", null);
  if (brandId) q = q.eq("id", brandId);
  const { data: brands, error: brandsErr } = await q;
  if (brandsErr) {
    return NextResponse.json(
      { error: `brands select: ${brandsErr.message}` },
      { status: 500 },
    );
  }

  const rows = ((brands ?? []) as BrandRow[]) ?? [];
  const results: Array<{
    brand_id: string;
    name: string | null;
    before: number | null;
    after: number | null;
    source: string | null;
    ok: boolean;
    reason?: string;
    error?: string;
  }> = [];
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const b of rows) {
    try {
      const r = await persistBrandEconomics(admin, b.id);
      if (r.ok) {
        updated += 1;
        results.push({
          brand_id: b.id,
          name: b.name,
          before: b.trailing_12_months ?? null,
          after: r.revenue ?? null,
          source: r.revenueSource ?? null,
          ok: true,
        });
      } else {
        if (r.reason === "not_ready" || r.reason === "no_revenue") {
          skipped += 1;
        } else {
          failed += 1;
        }
        results.push({
          brand_id: b.id,
          name: b.name,
          before: b.trailing_12_months ?? null,
          after: null,
          source: null,
          ok: false,
          reason: r.reason,
          error: r.error,
        });
      }
    } catch (e: any) {
      failed += 1;
      results.push({
        brand_id: b.id,
        name: b.name,
        before: b.trailing_12_months ?? null,
        after: null,
        source: null,
        ok: false,
        error: e?.message ?? String(e),
      });
    }
  }

  return NextResponse.json({
    candidates: rows.length,
    updated,
    skipped,
    failed,
    results,
  });
}
