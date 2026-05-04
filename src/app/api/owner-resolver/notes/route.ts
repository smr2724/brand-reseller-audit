/**
 * Phase 33 — POST /api/owner-resolver/notes
 *
 * Save free-text manual notes the user wrote on the candidate review
 * page. Stored on `brands.owner_resolution_notes`.
 *
 * Auth (M10 unified helper).
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
  notes: z.string().max(8000),
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

  const auth = await authorizeOwnerResolverRequest(req, parsed.data.brand_id);
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

  const { error } = await admin
    .from("brands")
    .update({ owner_resolution_notes: parsed.data.notes })
    .eq("id", parsed.data.brand_id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
