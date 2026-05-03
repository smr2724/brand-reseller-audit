/**
 * Phase 30 — User-triggered "Run scan" button on the brand-detail page.
 *
 * POST /api/brands/:id/enrich  body: { force?: boolean }
 *
 * Flips a `deferred` brand to `pending` (when `force: true`) and runs
 * Keepa enrichment synchronously, with the same token-budget gate the
 * recovery cron uses. Used by the yellow "Run scan" banner that appears
 * for every brand the user pulled in via SmartScout CSV but never
 * intended to auto-scan.
 *
 * Safety belts:
 *   runtime = nodejs
 *   dynamic = force-dynamic
 *   maxDuration = 300  (Keepa search + product details + DFS branded SERP
 *                       can run 30-90s; mirrors create-from-lookup)
 */
import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";
import {
  recoverStuckBrand,
  shouldSkipForTokenBudget,
  TOKEN_BUDGET_FLOOR,
  type StuckBrand,
} from "@/lib/brand/recover-stuck-brands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const force = body?.force === true;

  const { data: brand, error } = await supabase
    .from("brands")
    .select("id, user_id, name, created_at, enrichment_state")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!brand) return NextResponse.json({ error: "not found" }, { status: 404 });

  const state = String((brand as { enrichment_state?: string }).enrichment_state ?? "pending");
  if (state === "enriching" || state === "queued") {
    return NextResponse.json(
      { error: `brand already ${state}`, enrichment_state: state },
      { status: 409 },
    );
  }
  if (state === "deferred" && !force) {
    return NextResponse.json(
      {
        error: "brand is deferred — pass { force: true } to run a scan",
        enrichment_state: state,
      },
      { status: 409 },
    );
  }

  // Token budget gate before flipping state — if Keepa has nothing left,
  // leave the brand in its current state and tell the caller to retry.
  const budget = await shouldSkipForTokenBudget(TOKEN_BUDGET_FLOOR);
  if (budget.skip) {
    return NextResponse.json(
      {
        error: "Keepa token budget exhausted — try again in a few minutes",
        skipped: true,
        reason: "token_budget",
        tokens_left: budget.tokens_left,
      },
      { status: 503 },
    );
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  // Flip deferred|failed → pending so the lifecycle is consistent
  // (recoverStuckBrand will then transition pending → enriching → enriched|failed).
  if (state === "deferred" || state === "failed") {
    await admin
      .from("brands")
      .update({ enrichment_state: "pending", updated_at: new Date().toISOString() })
      .eq("id", brand.id);
  }

  const result = await recoverStuckBrand(admin, brand as StuckBrand);
  return NextResponse.json(result, {
    status: result.status === "recovered" ? 200 : 500,
  });
}
