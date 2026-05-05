/**
 * Phase 29 — Manual stuck-brand recovery, gated by CRON_SECRET or
 * SUPABASE_SERVICE_ROLE_KEY (mirrors /api/admin/recover-stuck-report).
 * Phase 30 — Accepts brands in `enrichment_state IN ('pending','failed')`
 * by default. Re-running a `deferred` brand requires `force: true` in the
 * body so we don't accidentally undo a bulk-import opt-out.
 *
 * POST /api/admin/recover-stuck-brand  body: { brand_id: string, force?: boolean }
 * GET  /api/admin/recover-stuck-brand  → list current stuck brands (pending|failed)
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
  isEnrichingRecoverable,
  recoverStuckBrand,
  STUCK_ENRICHING_THRESHOLD_MIN,
  type StuckBrand,
} from "@/lib/brand/recover-stuck-brands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 800;

// Phase 45 — `enriching` is recoverable too, but only when the row's
// `updated_at` is older than `STUCK_ENRICHING_THRESHOLD_MIN`. We let it
// through this set and then check the timestamp below.
const ALLOWED_STATES = new Set(["pending", "failed", "deferred", "enriching"]);

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
  const force = body?.force === true;
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
    .select("id, user_id, name, created_at, updated_at, enrichment_state")
    .eq("id", brandId)
    .maybeSingle();
  if (rowErr || !row) {
    return NextResponse.json(
      { error: rowErr?.message ?? "brand not found" },
      { status: 404 },
    );
  }

  const state = String((row as { enrichment_state?: string }).enrichment_state ?? "pending");
  const updatedAt = (row as { updated_at?: string | null }).updated_at ?? null;
  if (!ALLOWED_STATES.has(state)) {
    return NextResponse.json(
      {
        error: `enrichment_state '${state}' is not recoverable`,
        enrichment_state: state,
      },
      { status: 409 },
    );
  }
  if (state === "deferred" && !force) {
    return NextResponse.json(
      {
        error:
          "brand is deferred — pass { force: true } to re-enrich a deferred brand",
        enrichment_state: state,
      },
      { status: 409 },
    );
  }
  // Phase 45 — `enriching` is only recoverable once `updated_at` is older
  // than the threshold. Otherwise we'd race a healthy in-progress run.
  // `force: true` overrides (rare — operator knows the lambda is dead).
  if (state === "enriching" && !force && !isEnrichingRecoverable(updatedAt)) {
    return NextResponse.json(
      {
        error: `brand is still actively enriching (updated_at within ${STUCK_ENRICHING_THRESHOLD_MIN} minutes) — pass { force: true } to override`,
        enrichment_state: state,
        updated_at: updatedAt,
      },
      { status: 409 },
    );
  }

  // Flip deferred → pending before enrichment so the lifecycle is
  // consistent (recoverStuckBrand will then move pending → enriching → enriched|failed).
  if (state === "deferred" && force) {
    await admin
      .from("brands")
      .update({ enrichment_state: "pending", updated_at: new Date().toISOString() })
      .eq("id", brandId);
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
