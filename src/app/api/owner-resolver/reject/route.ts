/**
 * Phase 33 review fix B3 — POST /api/owner-resolver/reject
 *
 * Implements the "None of these — manual research" path. Sets
 * `brands.owner_resolution_state='failed'`, clears any selected candidates
 * brand-wide, marks the latest run as failed, and appends a system note.
 *
 * Body: { brand_id: string, note?: string }
 *
 * Auth (M10 unified helper).
 *
 * Safety belts (NEVER remove):
 *   runtime = nodejs
 *   dynamic = force-dynamic
 *   fetchCache = force-no-store
 *   revalidate = 0
 *   maxDuration = 300
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
  note: z.string().max(2000).optional(),
});

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = Body.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input" }, { status: 400 });
  }
  const { brand_id, note } = parsed.data;

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

  const { error } = await admin.rpc("reject_owner_candidates", {
    p_brand_id: brand_id,
    p_user_id: auth.kind === "user" ? auth.userId : null,
    p_note: note ?? null,
  });
  if (error) {
    return NextResponse.json(
      { error: error.message ?? "reject RPC failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, state: "failed" });
}
