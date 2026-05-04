/**
 * Hotfix (May 2026) — Backfill seller_name / seller_country on
 * brand_sellers rows whose seller_name is currently NULL or stored as
 * the raw seller_id (e.g. "A1BKR1TFBMOG3V").
 *
 * Flow:
 *   1. Auth via `Authorization: Bearer ${CRON_SECRET}` (or service role).
 *   2. Token-budget gate — bail with `{skipped, reason: "token_budget"}`
 *      when Keepa tokensLeft < 50.
 *   3. Fetch candidate rows (optionally filtered by `brand_id`).
 *   4. Resolve seller IDs in batches via Keepa /seller (1 token / id).
 *   5. UPDATE brand_sellers with the resolved name + country, then
 *      re-run the deterministic synchronous classifier so
 *      is_brand_controlled reflects the new name (it was meaningless
 *      against random seller IDs).
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
import { resolveSellerInfo, isAmazonSellerId } from "@/lib/keepa";
import { makeSellerCache } from "@/lib/enrichment/keepa-seller-cache";
import { classifySellerSync } from "@/lib/enrichment/seller-classification";
import {
  shouldSkipForTokenBudget,
  TOKEN_BUDGET_FLOOR,
} from "@/lib/brand/recover-stuck-brands";

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

interface CandidateRow {
  brand_id: string;
  seller_id: string | null;
  seller_name: string | null;
}

interface BrandRow {
  id: string;
  name: string | null;
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

  // Token-budget gate — same threshold as Phase 30 cron.
  const budget = await shouldSkipForTokenBudget(TOKEN_BUDGET_FLOOR);
  if (budget.skip) {
    return NextResponse.json({
      skipped: true,
      reason: "token_budget",
      tokens_left: budget.tokens_left,
    });
  }

  // Pull candidate rows. Without explicit OR-on-NULL we'd miss the
  // (now-fixed) freshly-enriched rows; combine `seller_name IS NULL`
  // with `seller_name = seller_id` for the legacy bug evidence.
  let q = admin
    .from("brand_sellers")
    .select("brand_id, seller_id, seller_name");
  if (brandId) q = q.eq("brand_id", brandId);
  const { data: rows, error: rowsErr } = await q;
  if (rowsErr) {
    return NextResponse.json(
      { error: `brand_sellers select: ${rowsErr.message}` },
      { status: 500 },
    );
  }

  const candidates = ((rows ?? []) as CandidateRow[]).filter((r) => {
    if (!r.seller_id || !isAmazonSellerId(r.seller_id)) return false;
    if (r.seller_name == null) return true;
    if (r.seller_name === r.seller_id) return true;
    if (isAmazonSellerId(r.seller_name)) return true;
    return false;
  });

  if (!candidates.length) {
    return NextResponse.json({
      updated: 0,
      skipped: 0,
      errors: [],
      tokens_left: budget.tokens_left,
      reason: "no_candidates",
    });
  }

  // Load brand names for the affected brand_ids — needed to re-run
  // the classifier after we have resolved seller names.
  const brandIds = Array.from(new Set(candidates.map((r) => r.brand_id)));
  const { data: brandRows, error: brandsErr } = await admin
    .from("brands")
    .select("id, name")
    .in("id", brandIds);
  if (brandsErr) {
    return NextResponse.json(
      { error: `brands select: ${brandsErr.message}` },
      { status: 500 },
    );
  }
  const brandNameById = new Map<string, string>();
  for (const b of (brandRows ?? []) as BrandRow[]) {
    if (b.name) brandNameById.set(b.id, b.name);
  }

  // Resolve every unique seller_id in one go (Keepa /seller batches up
  // to 100 per call). The Supabase-backed cache means we only burn
  // tokens for IDs we've never seen.
  const sellerIds = Array.from(new Set(candidates.map((r) => r.seller_id!).filter(Boolean)));
  const resolved = await resolveSellerInfo(sellerIds, makeSellerCache(admin));

  const errors: { brand_id: string; seller_id: string; error: string }[] = [];
  let updated = 0;
  let skipped = 0;

  for (const row of candidates) {
    const sid = row.seller_id;
    if (!sid) {
      skipped += 1;
      continue;
    }
    const info = resolved[sid];
    const newName = info?.name?.trim() || null;
    const newCountry = info?.country ?? null;

    // Re-classify with the resolved name (or null) so is_brand_controlled
    // reflects reality instead of the random-string seller_id.
    const brandName = brandNameById.get(row.brand_id) ?? "";
    const verdict = classifySellerSync({
      brand_name: brandName,
      seller_name: newName,
      seller_id: sid,
    });

    const patch: Record<string, unknown> = {
      seller_name: newName,
      classification_reason: verdict.reason.slice(0, 500),
      is_brand_controlled: verdict.is_brand_controlled,
    };
    if (newCountry) patch.seller_country = newCountry;

    const { error: upErr } = await admin
      .from("brand_sellers")
      .update(patch)
      .eq("brand_id", row.brand_id)
      .eq("seller_id", sid);
    if (upErr) {
      const msg = upErr.message ?? "";
      // Pre-migration env: classification columns missing. Retry with
      // just the name + country so the hotfix still lands.
      if (
        /column .* does not exist|is_brand_controlled|classification_reason/i.test(
          msg,
        )
      ) {
        const fallback: Record<string, unknown> = { seller_name: newName };
        if (newCountry) fallback.seller_country = newCountry;
        const { error: retryErr } = await admin
          .from("brand_sellers")
          .update(fallback)
          .eq("brand_id", row.brand_id)
          .eq("seller_id", sid);
        if (retryErr) {
          errors.push({ brand_id: row.brand_id, seller_id: sid, error: retryErr.message });
          continue;
        }
        updated += 1;
        continue;
      }
      errors.push({ brand_id: row.brand_id, seller_id: sid, error: msg });
      continue;
    }
    updated += 1;
  }

  return NextResponse.json({
    updated,
    skipped,
    errors,
    candidates: candidates.length,
    tokens_left: budget.tokens_left,
  });
}
