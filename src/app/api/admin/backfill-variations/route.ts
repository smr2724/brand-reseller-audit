/**
 * Phase 31 — Backfill variation-aware attribution for an existing brand.
 *
 * Used to recompute parent_asin / variation_group_size / variation_weight
 * / attributed_monthly_units on brand_asins rows for already-enriched
 * brands, without forcing a full re-enrich (which would burn Keepa
 * tokens on the seller side too). Re-fetches just /product for the
 * brand's existing ASINs (1 call ÷ 5 ASINs/batch ≈ 5 tokens per ASIN
 * on a cold cache; warm cache hits free).
 *
 * POST /api/admin/backfill-variations   body: { brand_id: string }
 * Auth: CRON_SECRET or SUPABASE_SERVICE_ROLE_KEY bearer.
 *
 * Token-budget aware: skips when Keepa reports < 50 tokens left.
 *
 * Safety belts (NEVER remove): runtime=nodejs, dynamic=force-dynamic,
 * fetchCache=force-no-store, revalidate=0, maxDuration=300.
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import {
  getKeepaTokenStatus,
  getProductDetails,
  isKeepaConfigured,
} from "@/lib/keepa";
import { rankToMonthlyUnits } from "@/lib/enrichment/revenue-estimator";
import {
  attributeVariationSales,
  indexAttributionByAsin,
} from "@/lib/enrichment/variation-attribution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 300;

const MIN_TOKEN_BUDGET = 50;

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
  if (!isKeepaConfigured()) {
    return NextResponse.json(
      { error: "KEEPA_API_KEY not configured" },
      { status: 500 },
    );
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

  const { data: brand, error: brandErr } = await admin
    .from("brands")
    .select("id, name")
    .eq("id", brandId)
    .maybeSingle();
  if (brandErr || !brand) {
    return NextResponse.json(
      { error: brandErr?.message ?? "brand not found" },
      { status: 404 },
    );
  }

  const { data: asinRows, error: asinErr } = await admin
    .from("brand_asins")
    .select("asin")
    .eq("brand_id", brandId);
  if (asinErr) {
    return NextResponse.json({ error: asinErr.message }, { status: 500 });
  }
  const asins = (asinRows ?? []).map((r) => r.asin).filter(Boolean);
  if (asins.length === 0) {
    return NextResponse.json(
      { brand_id: brandId, status: "skipped", reason: "no_asins" },
      { status: 200 },
    );
  }

  // Token-budget guard. Refuse to start a large /product fetch if Keepa
  // is near-empty — the parent agent can retry later.
  try {
    const tokens = await getKeepaTokenStatus(true);
    if (tokens.tokens_left < MIN_TOKEN_BUDGET) {
      return NextResponse.json(
        {
          brand_id: brandId,
          status: "skipped",
          reason: "low_keepa_tokens",
          tokens_left: tokens.tokens_left,
        },
        { status: 200 },
      );
    }
  } catch (e) {
    // soft fail — proceed; getProductDetails has its own ensureTokens()
    console.warn("[admin/backfill-variations] token check failed:", e);
  }

  // Re-fetch /product. The 24h in-memory cache typically makes this free
  // when called shortly after the original enrichment; on a cold cache
  // it's ~5 tokens per ASIN (capped by getProductDetails' batching).
  let products;
  try {
    products = await getProductDetails(asins, 5);
  } catch (e) {
    return NextResponse.json(
      {
        error: "keepa /product failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 502 },
    );
  }

  // Compute attribution.
  const attributionInputs = products.map((p) => {
    const rank = p.sales_rank_avg365 ?? p.sales_rank_current ?? null;
    const categoryPath = p.category_tree?.map((c) => c.name).join(" > ") ?? null;
    const raw = rankToMonthlyUnits(rank, p.product_group ?? null, categoryPath);
    return {
      asin: p.asin,
      parent_asin: p.parent_asin ?? null,
      raw_monthly_units: raw,
      recent_review_count: p.review_count ?? null,
    };
  });
  const attribution = indexAttributionByAsin(
    attributeVariationSales(attributionInputs),
  );

  // Update each row idempotently. We don't touch the seller-classification
  // columns or buy_box_* fields — only the variation-attribution slice.
  let updated = 0;
  let failed = 0;
  for (const p of products) {
    const att = attribution.get(p.asin);
    if (!att) continue;
    const { error: upErr } = await admin
      .from("brand_asins")
      .update({
        parent_asin: att.parent_asin ?? null,
        variation_group_size: att.variation_group_size ?? 1,
        variation_weight: att.variation_weight ?? 1,
        recent_review_count: p.review_count ?? null,
        raw_monthly_units: att.raw_monthly_units ?? null,
        attributed_monthly_units: att.attributed_monthly_units ?? null,
      })
      .eq("brand_id", brandId)
      .eq("asin", p.asin);
    if (upErr) {
      failed += 1;
      console.warn(
        `[admin/backfill-variations] update failed for ${p.asin}:`,
        upErr.message,
      );
    } else {
      updated += 1;
    }
  }

  // Summary stats for the caller / parent agent.
  const groupSizes = new Map<string, number>();
  for (const r of attribution.values()) {
    if (r.variation_group_size >= 2 && r.parent_asin) {
      groupSizes.set(r.parent_asin, r.variation_group_size);
    }
  }

  return NextResponse.json(
    {
      brand_id: brandId,
      brand_name: (brand as { name?: string }).name ?? null,
      status: "ok",
      asins_total: asins.length,
      asins_fetched: products.length,
      asins_updated: updated,
      asins_failed: failed,
      variation_groups: groupSizes.size,
      variation_group_summary: Array.from(groupSizes.entries()).map(
        ([parent, size]) => ({ parent_asin: parent, size }),
      ),
    },
    { status: 200 },
  );
}

export async function GET(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const brandId = url.searchParams.get("brand_id");
  if (!brandId) {
    return NextResponse.json(
      { error: "brand_id query param required" },
      { status: 400 },
    );
  }
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }
  const { data, error } = await admin
    .from("brand_asins")
    .select(
      "asin, parent_asin, variation_group_size, variation_weight, recent_review_count, raw_monthly_units, attributed_monthly_units, buy_box_price",
    )
    .eq("brand_id", brandId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ brand_id: brandId, asins: data ?? [] });
}
