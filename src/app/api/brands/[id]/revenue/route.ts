/**
 * Phase 28 — PATCH /api/brands/:id/revenue
 *
 * Sets or clears the user-confirmed TTM revenue override on a brand
 * row. When set, all downstream math (reseller_margin, delta_profit,
 * exit_lift, capture plan, DIY recoverable) compiles on top of the
 * confirmed value via `resolveBrandRevenue()`. Setting the value to
 * null reverts to the Keepa/price-only estimator.
 *
 * Body:
 *   {
 *     confirmed_ttm_revenue_dollars: number | null,
 *     confirmed_ttm_source?: string | null
 *   }
 *
 * No re-enrichment is triggered — the brand-detail Financial Model
 * panel will recompute from the cached Keepa state on next render.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { persistBrandEconomics } from "@/lib/brand-detail/persist-economics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  confirmed_ttm_revenue_dollars: z
    .union([z.number(), z.null()])
    .refine((v) => v === null || (Number.isFinite(v) && v >= 0), {
      message: "must be null or a non-negative number",
    }),
  confirmed_ttm_source: z.string().trim().max(200).nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
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
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid input" },
      { status: 400 },
    );
  }

  const value = parsed.data.confirmed_ttm_revenue_dollars;
  const sourceRaw = parsed.data.confirmed_ttm_source ?? null;
  const source =
    typeof sourceRaw === "string" && sourceRaw.length > 0 ? sourceRaw : null;

  const update: Record<string, unknown> = {
    confirmed_ttm_revenue_dollars: value,
    // Clear source + timestamp when the value is cleared. When the value
    // is set, persist whatever source label the user typed (or null).
    confirmed_ttm_source: value === null ? null : source,
    confirmed_ttm_set_at: value === null ? null : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("brands")
    .update(update)
    .eq("id", params.id)
    .eq("user_id", user.id)
    .select()
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Phase 38 — manual revenue override is one of the inputs that drives
  // the financial-model dollar columns. Recompute and persist so the
  // brand page renders the post-override values without a round-trip
  // through the report or Keepa enrichment.
  try {
    const persisted = await persistBrandEconomics(supabase as any, params.id);
    if (!persisted.ok) {
      console.warn(
        "[api/brands/revenue] persistBrandEconomics skipped/failed:",
        persisted.reason ?? "unknown",
        persisted.error ?? "",
      );
    }
  } catch (e) {
    console.warn("[api/brands/revenue] persistBrandEconomics threw:", e);
  }

  return NextResponse.json({ brand: data });
}
