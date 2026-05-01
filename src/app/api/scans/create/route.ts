import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runScan } from "@/lib/scan";

export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const seed = String(body?.seed_keyword ?? "").trim();
  const depth = String(body?.depth ?? "standard") as "quick" | "standard" | "deep";
  if (!seed) return NextResponse.json({ error: "seed_keyword required" }, { status: 400 });

  const { data: scan, error } = await supabase
    .from("scans")
    .insert({
      user_id: user.id,
      seed_keyword: seed,
      marketplace: "amazon_us",
      scan_depth: depth,
      status: "running",
      raw_input: body,
    })
    .select()
    .single();
  if (error || !scan) return NextResponse.json({ error: error?.message ?? "failed to create scan" }, { status: 500 });

  try {
    const result = await runScan({
      scanId: scan.id,
      userId: user.id,
      seedKeyword: seed,
      depth,
      supabase,
    });
    return NextResponse.json({ ok: true, scan_id: scan.id, ...result });
  } catch (e: any) {
    await supabase.from("scans").update({
      status: "error",
      error_message: String(e?.message ?? e),
      completed_at: new Date().toISOString(),
    }).eq("id", scan.id);
    return NextResponse.json({ error: String(e?.message ?? e), scan_id: scan.id }, { status: 500 });
  }
}
