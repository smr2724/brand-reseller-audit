import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";
import { enrichBrandWithKeepa } from "@/lib/enrichment/keepa-brand";
import { enrichBrandWithDataForSeo } from "@/lib/enrichment/dataforseo";
import { normalizeName } from "@/lib/importer/merge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Keepa search + product details + DFS branded SERP can run 30-90s.
export const maxDuration = 300;

const Body = z.object({
  brand: z.string().trim().min(1).max(200),
  category: z.string().trim().max(120).optional(),
  // Phase 28 — optional user-confirmed TTM revenue captured at picker
  // time. Persisted on the brand row on first insert; ignored on reuse
  // (the user can edit later from the brand-detail page).
  confirmed_ttm_revenue_dollars: z
    .union([z.number(), z.null()])
    .optional()
    .refine((v) => v == null || (Number.isFinite(v) && v >= 0), {
      message: "confirmed_ttm_revenue_dollars must be a non-negative number",
    }),
  confirmed_ttm_source: z.string().trim().max(200).optional(),
});

export async function POST(req: Request) {
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
    return NextResponse.json({ error: "invalid input" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  const brandName = parsed.data.brand;
  const norm = normalizeName(brandName);

  // Reuse if the user already has this brand.
  const { data: existing } = await supabase
    .from("brands")
    .select("id")
    .eq("user_id", user.id)
    .eq("name_normalized", norm)
    .maybeSingle();

  // Phase 28 — picker-time confirmed TTM (optional). Only persisted on
  // first insert below; on reuse, the user edits from the brand-detail
  // page via PATCH /api/brands/:id/revenue.
  const confirmedTtm =
    typeof parsed.data.confirmed_ttm_revenue_dollars === "number" &&
    Number.isFinite(parsed.data.confirmed_ttm_revenue_dollars) &&
    parsed.data.confirmed_ttm_revenue_dollars > 0
      ? parsed.data.confirmed_ttm_revenue_dollars
      : null;
  const confirmedSource =
    confirmedTtm != null && parsed.data.confirmed_ttm_source
      ? parsed.data.confirmed_ttm_source
      : null;

  let brandId: string;
  if (existing?.id) {
    brandId = existing.id;
  } else {
    const insertRow: Record<string, unknown> = {
      user_id: user.id,
      name: brandName,
      name_normalized: norm,
      category: parsed.data.category ?? null,
      status: "new",
    };
    if (confirmedTtm != null) {
      insertRow.confirmed_ttm_revenue_dollars = confirmedTtm;
      insertRow.confirmed_ttm_source = confirmedSource;
      insertRow.confirmed_ttm_set_at = new Date().toISOString();
    }
    const { data: created, error: insErr } = await supabase
      .from("brands")
      .insert(insertRow)
      .select("id")
      .single();
    if (insErr || !created) {
      return NextResponse.json(
        { error: insErr?.message ?? "insert failed" },
        { status: 500 },
      );
    }
    brandId = created.id;
  }

  // Run enrichment synchronously — Phase 6.7 hotfix lesson: no
  // fire-and-forget. The client expects the brand to be enriched
  // before redirecting to the detail page.
  // Phase 30 — Picker-created brands start in `enrichment_state='pending'`
  // (column default). We flip to `enriching` for the duration, then to
  // `enriched` on success or `failed` on a Keepa error. The recovery cron
  // is keyed off this column too.
  await admin
    .from("brands")
    .update({ enrichment_state: "enriching", updated_at: new Date().toISOString() })
    .eq("id", brandId);

  let keepaError: string | null = null;
  let keepaAsinCount = 0;
  let dfsError: string | null = null;
  try {
    const summary = await enrichBrandWithKeepa(admin, {
      brand_id: brandId,
      brand_name: brandName,
      user_id: user.id,
    });
    if (summary.enrichment_error) keepaError = summary.enrichment_error;
    keepaAsinCount = summary.asin_count;
  } catch (e) {
    keepaError = e instanceof Error ? e.message : String(e);
  }

  await admin
    .from("brands")
    .update({
      enrichment_state: keepaError != null || keepaAsinCount === 0 ? "failed" : "enriched",
      updated_at: new Date().toISOString(),
    })
    .eq("id", brandId);

  try {
    const snap = await enrichBrandWithDataForSeo(admin, {
      brand_id: brandId,
      brand_name: brandName,
      user_id: user.id,
    });
    if (snap.enrichment_error) dfsError = snap.enrichment_error;
  } catch (e) {
    dfsError = e instanceof Error ? e.message : String(e);
  }

  // Phase 29 — H2O Therapy bug. When Keepa enrichment fails or returns
  // 0 ASINs, the previous code returned 200 with the error in the body
  // and the client redirected to a half-broken detail page. Redirect
  // there silently if the user opens it, but signal the failure to the
  // client (non-2xx so generic "Load failed" turns into a real message)
  // when there's nothing useful to show. The brand row still exists, so
  // the recover-stuck-brands cron can pick it up on the next sweep.
  const enrichmentFailed = keepaError != null || keepaAsinCount === 0;
  if (enrichmentFailed) {
    return NextResponse.json(
      {
        brand_id: brandId,
        keepa_error: keepaError,
        dataforseo_error: dfsError,
        asin_count: keepaAsinCount,
        error:
          keepaError ??
          "Keepa returned no ASINs for this brand. The brand was saved; the recovery sweep will retry within 5 minutes.",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    brand_id: brandId,
    keepa_error: keepaError,
    dataforseo_error: dfsError,
    asin_count: keepaAsinCount,
  });
}
