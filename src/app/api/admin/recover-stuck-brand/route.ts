/**
 * Phase 29 — Manual stuck-brand recovery, gated by CRON_SECRET or
 * SUPABASE_SERVICE_ROLE_KEY (mirrors /api/admin/recover-stuck-report).
 *
 * POST /api/admin/recover-stuck-brand  body: { brand_id: string }
 * GET  /api/admin/recover-stuck-brand  → list current stuck brands
 *
 * Re-runs enrichBrandWithKeepa against the brand row in place. Used to
 * unblock specific stuck brands (e.g. H2O Therapy) without waiting for
 * the 5-min cron sweep.
 *
 * Safety belts (NEVER remove):
 *   runtime = nodejs
 *   dynamic = force-dynamic
 *   fetchCache = force-no-store
 *   revalidate = 0
 *   maxDuration = 800  (matches /api/admin/recover-stuck-report)
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import {
  findStuckBrands,
  recoverStuckBrand,
  type StuckBrand,
} from "@/lib/brand/recover-stuck-brands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 800;

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

export async function POST(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const brandId = String(body?.brand_id ?? "").trim();
  if (!brandId) {
    return NextResponse.json({ error: "brand_id required" }, { status: 400 });
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }
  const { data: row, error: rowErr } = await admin
    .from("brands")
    .select("id, user_id, name, created_at")
    .eq("id", brandId)
    .maybeSingle();
  if (rowErr || !row) {
    return NextResponse.json(
      { error: rowErr?.message ?? "brand not found" },
      { status: 404 },
    );
  }
  const result = await recoverStuckBrand(admin, row as StuckBrand);
  return NextResponse.json(result, {
    status: result.status === "recovered" ? 200 : 500,
  });
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
  const stuck = await findStuckBrands(admin, undefined, 25);
  return NextResponse.json({ stuck });
}
