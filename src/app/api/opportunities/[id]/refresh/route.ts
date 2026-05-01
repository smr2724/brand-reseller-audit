import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runScan } from "@/lib/scan";

export const maxDuration = 60;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: opp } = await supabase
    .from("opportunities")
    .select("id, main_keyword")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();
  if (!opp) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Create new scan; the runScan will insert a NEW opportunity row — this is
  // intentional to preserve history. The UI will route to the newest scan.
  const { data: scan } = await supabase
    .from("scans")
    .insert({
      user_id: user.id, seed_keyword: opp.main_keyword, marketplace: "amazon_us",
      scan_depth: "standard", status: "running",
    })
    .select()
    .single();
  if (!scan) return NextResponse.json({ error: "failed to create scan" }, { status: 500 });

  try {
    const r = await runScan({
      scanId: scan.id, userId: user.id, seedKeyword: opp.main_keyword,
      depth: "standard", supabase,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
