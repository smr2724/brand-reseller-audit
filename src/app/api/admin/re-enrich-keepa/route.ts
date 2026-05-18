/**
 * Phase 84 — Manual Keepa re-enrichment for brands captured under the
 * Bug #5 buy-box-only path. After the fix lands and Vercel deploys, the
 * operator runs the SQL flagged-list and POSTs the affected brand_ids
 * here to have them re-walked with the new full-offers aggregation.
 *
 * POST /api/admin/re-enrich-keepa
 *   body: { brand_id: string } OR { brand_ids: string[] }
 *   header: Authorization: Bearer ${CRON_SECRET}
 *
 * Returns: { enriched: [{ brand_id, before_unique, after_unique, error? }] }
 *
 * Safety belts (NEVER remove — Phase 84 hard constraint mirrors the
 * other /api/admin/* routes):
 *   runtime = nodejs
 *   dynamic = force-dynamic
 *   fetchCache = force-no-store
 *   revalidate = 0
 *   maxDuration = 800
 *   CRON_SECRET mandatory (or SUPABASE_SERVICE_ROLE_KEY) on every call.
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { enrichBrandWithKeepa } from "@/lib/enrichment/keepa-brand";

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

interface BrandSnapshot {
  id: string;
  user_id: string;
  name: string;
  keepa_unique_seller_count: number | null;
  disqualifier_tags: string[] | null;
}

export async function POST(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const ids: string[] = (() => {
    if (Array.isArray(body?.brand_ids)) {
      return body.brand_ids.map((s: unknown) => String(s ?? "").trim()).filter(Boolean);
    }
    const single = String(body?.brand_id ?? "").trim();
    return single ? [single] : [];
  })();
  if (!ids.length) {
    return NextResponse.json(
      { error: "brand_id or brand_ids required" },
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

  const { data: rows, error: rowErr } = await admin
    .from("brands")
    .select("id, user_id, name, keepa_unique_seller_count, disqualifier_tags")
    .in("id", ids);
  if (rowErr) {
    return NextResponse.json({ error: rowErr.message }, { status: 500 });
  }
  const brands = (rows as BrandSnapshot[] | null) ?? [];
  if (!brands.length) {
    return NextResponse.json(
      { error: "no matching brands found", requested_ids: ids },
      { status: 404 },
    );
  }

  const enriched: Array<{
    brand_id: string;
    name: string;
    before_unique: number | null;
    after_unique: number | null;
    error?: string;
  }> = [];

  for (const b of brands) {
    const before = b.keepa_unique_seller_count;
    try {
      const summary = await enrichBrandWithKeepa(admin, {
        brand_id: b.id,
        brand_name: b.name,
        user_id: b.user_id,
        existing_disqualifier_tags: b.disqualifier_tags ?? [],
      });
      enriched.push({
        brand_id: b.id,
        name: b.name,
        before_unique: before,
        after_unique: summary.unique_seller_count,
      });
    } catch (e: any) {
      enriched.push({
        brand_id: b.id,
        name: b.name,
        before_unique: before,
        after_unique: null,
        error: String(e?.message ?? e).slice(0, 500),
      });
    }
  }

  return NextResponse.json({ enriched });
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
  // Phase 84 — flagged-list: brands with `keepa_avg_offers > 5` but
  // `keepa_unique_seller_count < (keepa_avg_offers * 0.6)` likely
  // suffered Bug #5 under-capture and need re-enrichment. Mirrors the
  // SQL snippet in the PR description.
  //
  // Phase 84 follow-up #5 — we cap the underlying SELECT at 200 rows so
  // a single GET can't pull thousands of brand rows. To make the
  // truncation visible to callers (instead of silent), we also issue a
  // HEAD-style count of the same `gt("keepa_avg_offers", 5)` filter and
  // return `total_count` + `truncated` alongside the flagged list. The
  // `truncated` flag refers to the pre-filter candidate pool, not the
  // post-filter `flagged` array.
  const SCAN_LIMIT = 200;
  const { data, error } = await admin
    .from("brands")
    .select("id, name, keepa_avg_offers, keepa_unique_seller_count")
    .gt("keepa_avg_offers", 5)
    .order("keepa_avg_offers", { ascending: false })
    .limit(SCAN_LIMIT);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const rows = (data ?? []) as Array<{
    id: string;
    name: string;
    keepa_avg_offers: number | null;
    keepa_unique_seller_count: number | null;
  }>;
  const flagged = rows.filter((r) => {
    const avg = r.keepa_avg_offers ?? 0;
    const uniq = r.keepa_unique_seller_count ?? 0;
    return avg > 5 && uniq < avg * 0.6;
  });

  // Best-effort total candidate count. Supabase returns `count` via the
  // `count: "exact"` option without re-fetching rows. If the count call
  // fails we still return the flagged list — `truncated` falls back to
  // `rows.length >= SCAN_LIMIT` which is a conservative-true.
  let totalCount: number | null = null;
  try {
    const { count, error: countErr } = await admin
      .from("brands")
      .select("id", { count: "exact", head: true })
      .gt("keepa_avg_offers", 5);
    if (!countErr && typeof count === "number") totalCount = count;
  } catch {
    // ignore — totalCount stays null
  }
  const truncated =
    typeof totalCount === "number"
      ? totalCount > SCAN_LIMIT
      : rows.length >= SCAN_LIMIT;

  return NextResponse.json({
    flagged,
    scan_limit: SCAN_LIMIT,
    scanned_count: rows.length,
    total_count: totalCount,
    truncated,
  });
}
