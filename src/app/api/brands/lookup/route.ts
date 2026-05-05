import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";
import { lookupBrand } from "@/lib/brand-lookup";
import { normalizeName } from "@/lib/importer/merge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Phase 45 — GET ?name=<exact name> reconciles a brand by normalized
// name within the current user's scope. The Add-Brand-by-Name UI uses
// this after a transient create-from-lookup failure to discover that
// the brand row was actually inserted server-side before the error
// surfaced (Vercel function timeout, network blip, etc.).
export async function GET(req: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const name = (url.searchParams.get("name") ?? "").trim();
  if (name.length < 2 || name.length > 200) {
    return NextResponse.json({ error: "name required (2-200 chars)" }, { status: 400 });
  }
  const norm = normalizeName(name);
  const { data, error } = await supabase
    .from("brands")
    .select("id, name, enrichment_state, updated_at")
    .eq("user_id", user.id)
    .eq("name_normalized", norm)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ brand: null });
  return NextResponse.json({
    brand: {
      id: data.id as string,
      name: data.name as string,
      enrichment_state: (data.enrichment_state as string | null) ?? null,
      updated_at: (data.updated_at as string | null) ?? null,
    },
  });
}

const Body = z.object({
  query: z.string().trim().min(2).max(200),
  force: z.boolean().optional(),
});

export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
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

  try {
    const result = await lookupBrand(admin, parsed.data.query, {
      force: parsed.data.force ?? false,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/brands/lookup] failed", { msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
