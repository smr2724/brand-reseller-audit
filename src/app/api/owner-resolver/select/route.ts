/**
 * Phase 33 — POST /api/owner-resolver/select
 *
 * Persist the user's selection of one or more candidate owners for a
 * brand. Atomic via the `select_owner_candidates` SECURITY DEFINER RPC
 * (B2 / M1 / M2 / M9 — see migration 0030).
 *
 * Body:
 *   {
 *     brand_id: string,
 *     candidate_ids: string[],
 *     resolved_owner_type: 'manufacturer'|'brand_owner'|'licensee'|'distributor'|'dba'|'holding_co'|'unknown'
 *   }
 *
 * Returns: { ok: true, selected_count, primary }
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { authorizeOwnerResolverRequest } from "@/lib/owner-resolver/auth";

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

export async function POST(req: Request) {
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

  const auth = await authorizeOwnerResolverRequest(req, brand_id);
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

  const { data, error } = await admin.rpc("select_owner_candidates", {
    p_brand_id: brand_id,
    p_candidate_ids: candidate_ids,
    p_resolved_owner_type: resolved_owner_type,
    p_user_id: auth.kind === "user" ? auth.userId : null,
  });
  if (error) {
    const msg = error.message ?? "select RPC failed";
    const status = /not belong to|no resolution runs|invalid/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
  const rows = (data ?? []) as Array<{
    selected_count: number | null;
    primary_candidate_id: string | null;
    primary_candidate_name: string | null;
    primary_candidate_domain: string | null;
  }>;
  const row = rows[0];
  return NextResponse.json({
    ok: true,
    selected_count: row?.selected_count ?? candidate_ids.length,
    primary: row
      ? {
          id: row.primary_candidate_id,
          name: row.primary_candidate_name,
          domain: row.primary_candidate_domain,
        }
      : null,
  });
}
