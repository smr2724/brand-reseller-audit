/**
 * Phase 33 — POST /api/owner-resolver/trigger
 *
 * Manually run or rerun the brand owner resolver for a single brand.
 *
 * Auth (M10 unified helper): CRON_SECRET / x-vercel-cron-signature /
 * service-role bearer, OR a Supabase user session whose user_id matches
 * the target brand's user_id.
 *
 * Body: { brand_id: string }
 * Returns: { run_id, candidates_count, top_score, state }
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
import { resolveBrandOwner } from "@/lib/owner-resolver/resolve";
import { authorizeOwnerResolverRequest } from "@/lib/owner-resolver/auth";
import type { OwnerResolutionTrigger } from "@/lib/owner-resolver/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 300;

export async function POST(req: Request) {
  let body: { brand_id?: unknown } = {};
  try {
    body = (await req.json()) as { brand_id?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const brandId = typeof body.brand_id === "string" ? body.brand_id.trim() : "";
  if (!brandId) {
    return NextResponse.json({ error: "brand_id required" }, { status: 400 });
  }

  const auth = await authorizeOwnerResolverRequest(req, brandId);
  if (auth.kind === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  const { data: brand, error } = await admin
    .from("brands")
    .select("id, owner_resolution_state")
    .eq("id", brandId)
    .maybeSingle();
  if (error || !brand) {
    return NextResponse.json(
      { error: error?.message ?? "brand not found" },
      { status: 404 },
    );
  }

  const state = String(
    (brand as { owner_resolution_state?: string }).owner_resolution_state ??
      "pending",
  );
  const triggered_by: OwnerResolutionTrigger = state === "selected" ? "rerun" : "manual";

  try {
    const result = await resolveBrandOwner(admin, brandId, { triggered_by });
    return NextResponse.json(result, {
      status: result.ok ? 200 : 500,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
