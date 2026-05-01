import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getKeepaTokenStatus, isKeepaConfigured } from "@/lib/keepa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!isKeepaConfigured()) {
    return NextResponse.json({ ok: false, configured: false, error: "KEEPA_API_KEY missing" });
  }

  try {
    const status = await getKeepaTokenStatus();
    return NextResponse.json({ ok: true, configured: true, ...status });
  } catch (e: any) {
    return NextResponse.json({ ok: false, configured: true, error: String(e?.message ?? e) }, { status: 502 });
  }
}
