/**
 * Phase 34.6 — POST /api/brands/[id]/owner-resolver/reset
 *
 * Resets the owner resolver for a single brand so the user can rerun it
 * after a stuck `running` / `awaiting_apollo_selection` / `enriching_apollo`
 * state. NOT a destructive bulk action — scoped to the owner resolver only:
 *
 *   - DELETE owner_candidates WHERE brand_id = $1
 *   - UPDATE owner_resolution_runs SET status='failed' (only non-terminal
 *     runs; terminal runs are preserved verbatim for audit history)
 *   - UPDATE brands SET resolved_owner_apollo_org_id = NULL,
 *                       owner_resolution_state = 'pending'
 *
 * Does NOT touch RCG fees, report status, or enrichment_state. Does NOT
 * delete `owner_resolution_runs` rows — we want full audit history.
 *
 * Auth: same user-session-or-bearer helper the other resolver routes use.
 *
 * Body: none.
 * Returns: { ok: true, candidates_cleared, runs_cancelled }.
 *
 * Safety belts (NEVER remove):
 *   runtime = nodejs
 *   dynamic = force-dynamic
 *   fetchCache = force-no-store
 *   revalidate = 0
 *   maxDuration = 60
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { authorizeOwnerResolverRequest } from "@/lib/owner-resolver/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 60;

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const brandId = params.id?.trim() ?? "";
  if (!brandId) {
    return NextResponse.json({ error: "brand id required" }, { status: 400 });
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

  // 1. Delete candidates for the brand. Returning the deleted rows gives
  // us an exact count (Supabase doesn't expose `rowcount` on DELETEs).
  const { data: deletedRows, error: delErr } = await admin
    .from("owner_candidates")
    .delete()
    .eq("brand_id", brandId)
    .select("id");
  if (delErr) {
    return NextResponse.json(
      { error: `failed to clear candidates: ${delErr.message}` },
      { status: 500 },
    );
  }
  const candidatesCleared = (deletedRows ?? []).length;

  // 2. Mark any non-terminal runs failed. Terminal runs (`failed` /
  // `succeeded`) are preserved as-is so audit history isn't rewritten.
  const nowIso = new Date().toISOString();
  // Two-step: (a) load the ids of non-terminal runs so we can fill
  // completed_at / error_message conditionally, (b) update them.
  const { data: nonTerminal, error: listErr } = await admin
    .from("owner_resolution_runs")
    .select("id, completed_at, error_message")
    .eq("brand_id", brandId)
    .not("status", "in", "(failed,succeeded)");
  if (listErr) {
    return NextResponse.json(
      { error: `failed to list runs: ${listErr.message}` },
      { status: 500 },
    );
  }
  const runsToCancel = (nonTerminal ?? []) as Array<{
    id: string;
    completed_at: string | null;
    error_message: string | null;
  }>;
  let runsCancelled = 0;
  for (const r of runsToCancel) {
    const { error: updErr } = await admin
      .from("owner_resolution_runs")
      .update({
        status: "failed",
        completed_at: r.completed_at ?? nowIso,
        error_message: r.error_message ?? "Reset by user",
      })
      .eq("id", r.id);
    if (updErr) {
      return NextResponse.json(
        { error: `failed to cancel run ${r.id}: ${updErr.message}` },
        { status: 500 },
      );
    }
    runsCancelled += 1;
  }

  // 3. Reset the brand row. Only the owner-resolver fields — RCG fees,
  // enrichment_state, report status are untouched.
  const { error: brandErr } = await admin
    .from("brands")
    .update({
      resolved_owner_apollo_org_id: null,
      owner_resolution_state: "pending",
    })
    .eq("id", brandId);
  if (brandErr) {
    return NextResponse.json(
      { error: `failed to reset brand: ${brandErr.message}` },
      { status: 500 },
    );
  }

  console.log(
    `[owner-resolver] reset brand=${brandId} candidates_cleared=${candidatesCleared} runs_cancelled=${runsCancelled} actor=${
      auth.kind === "user" ? auth.userId : "admin"
    }`,
  );

  return NextResponse.json({
    ok: true,
    candidates_cleared: candidatesCleared,
    runs_cancelled: runsCancelled,
  });
}
