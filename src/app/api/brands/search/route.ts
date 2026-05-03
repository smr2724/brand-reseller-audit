import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { searchBrands } from "@/lib/brand-search/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Variant fan-out + DataForSEO SERP can take ~20-30s.
export const maxDuration = 60;

const Body = z.object({
  query: z.string().trim().min(2).max(200),
  mode: z.enum(["tight", "loose"]).optional(),
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

  try {
    const result = await searchBrands(parsed.data.query, parsed.data.mode ?? "tight");
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/brands/search] failed", { msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
