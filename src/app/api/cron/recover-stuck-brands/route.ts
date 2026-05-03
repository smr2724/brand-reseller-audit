/**
 * Phase 29 — Stuck-brand recovery cron.
 *
 * Mirrors /api/cron/recover-stuck-reports (Phase 21). Runs every 5 minutes
 * (see vercel.json). For every brand row whose `keepa_last_enriched_at`
 * is still NULL more than 5 minutes after `created_at`, re-runs
 * enrichBrandWithKeepa against the brand id.
 *
 * Triggered by the H2O Therapy bug: /api/brands/create-from-lookup hit
 * its Vercel maxDuration before Keepa enrichment finished, leaving the
 * brand permanently stuck (0 ASINs, 0 sellers, 0 reports). Without this
 * sweep the user has to manually delete + retry.
 *
 * Safety belts (NEVER remove):
 *   runtime = nodejs
 *   dynamic = force-dynamic
 *   fetchCache = force-no-store
 *   revalidate = 0
 *   maxDuration = 300
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import {
  findStuckBrands,
  recoverStuckBrand,
} from "@/lib/brand/recover-stuck-brands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 300;

function authorize(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true; // dev: permit when not configured
  const auth = req.headers.get("authorization") ?? "";
  if (auth === `Bearer ${expected}`) return true;
  const cronHeader = req.headers.get("x-vercel-cron-signature");
  if (cronHeader && cronHeader === expected) return true;
  return false;
}

export async function GET(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  const stuck = await findStuckBrands(admin);
  console.log("[cron/recover-stuck-brands] candidates", {
    count: stuck.length,
    ids: stuck.map((s) => s.id),
  });

  if (stuck.length === 0) {
    return NextResponse.json({ processed: 0 });
  }

  const results: Array<{
    brand_id: string;
    status: string;
    asin_count?: number;
    error?: string;
  }> = [];
  for (const b of stuck) {
    const res = await recoverStuckBrand(admin, b);
    results.push(res);
  }

  return NextResponse.json({ processed: results.length, results });
}
