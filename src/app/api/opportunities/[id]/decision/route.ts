import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const VALID = new Set(["reject", "watchlist", "review", "deep_dive", "find_manufacturers", "outreach_ready", "active_deal", "new"]);

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const decision = String(body?.decision ?? "").toLowerCase();
  if (!VALID.has(decision)) return NextResponse.json({ error: "invalid decision" }, { status: 400 });

  const { error } = await supabase
    .from("opportunities")
    .update({ status: decision })
    .eq("id", params.id)
    .eq("user_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.from("decisions").insert({
    user_id: user.id,
    opportunity_id: params.id,
    decision,
    reason: body?.reason ?? null,
  });

  return NextResponse.json({ ok: true });
}
