/**
 * Phase 33 — POST /api/owner-resolver/select
 *
 * Persist the user's selection of one or more candidate owners for a
 * brand. The user can select multiple candidates (e.g. when multiple
 * brand-owned shell companies represent the same parent on Amazon).
 *
 * Body:
 *   {
 *     brand_id: string,
 *     candidate_ids: string[],
 *     resolved_owner_type: 'manufacturer'|'brand_owner'|'licensee'|'distributor'|'dba'|'holding_co'|'unknown'
 *   }
 *
 * On selection:
 *   - is_selected_owner=true on each picked candidate, false on others
 *     for that brand.
 *   - brands.owner_resolution_state='selected', owner_resolved_at=NOW()
 *   - brands.resolved_owner_type set to the supplied type
 *   - If exactly one candidate selected: copy its name/domain to brands
 *   - If multiple selected: copy the highest-scoring one to brands
 *
 * Returns: { ok: true, selected_count }
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { ResolvedOwnerType } from "@/lib/owner-resolver/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 300;

const Body = z.object({
  brand_id: z.string().trim().min(1),
  candidate_ids: z.array(z.string().trim().min(1)).min(1).max(20),
  resolved_owner_type: z.enum([
    "manufacturer",
    "brand_owner",
    "licensee",
    "distributor",
    "dba",
    "holding_co",
    "unknown",
  ]),
});

function authorize(req: Request): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true;
  const sr = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (sr && auth === `Bearer ${sr}`) return true;
  return false;
}

export async function POST(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let parsed;
  try {
    parsed = Body.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", details: parsed.error.format() },
      { status: 400 },
    );
  }
  const { brand_id, candidate_ids, resolved_owner_type } = parsed.data;
  const ownerType = resolved_owner_type as ResolvedOwnerType;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  // Load the picked candidates so we know their names/domains/scores.
  const { data: picked, error: pickErr } = await admin
    .from("owner_candidates")
    .select("id, brand_id, candidate_company_name, candidate_domain, heuristic_score")
    .in("id", candidate_ids)
    .eq("brand_id", brand_id);
  if (pickErr) {
    return NextResponse.json(
      { error: pickErr.message },
      { status: 500 },
    );
  }
  if (!picked || picked.length === 0) {
    return NextResponse.json(
      { error: "no matching candidates for that brand" },
      { status: 404 },
    );
  }

  const now = new Date().toISOString();

  // Clear is_selected_owner on all candidates for this brand first.
  await admin
    .from("owner_candidates")
    .update({ is_selected_owner: false, selected_at: null })
    .eq("brand_id", brand_id);

  // Mark the picked ones.
  await admin
    .from("owner_candidates")
    .update({ is_selected_owner: true, selected_at: now })
    .in("id", candidate_ids);

  // Decide which candidate to mirror onto the brand row.
  const sorted = [...(picked as Array<{ id: string; candidate_company_name: string; candidate_domain: string | null; heuristic_score: number | null }>)]
    .sort((a, b) => (b.heuristic_score ?? 0) - (a.heuristic_score ?? 0));
  const top = sorted[0]!;

  await admin
    .from("brands")
    .update({
      owner_resolution_state: "selected",
      owner_resolved_at: now,
      resolved_owner_type: ownerType,
      resolved_owner_company_name: top.candidate_company_name,
      resolved_owner_domain: top.candidate_domain,
      owner_resolution_error: null,
    })
    .eq("id", brand_id);

  return NextResponse.json({ ok: true, selected_count: picked.length });
}
