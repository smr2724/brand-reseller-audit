import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? "archive").toLowerCase();
  if (action !== "archive" && action !== "restore") {
    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }

  const archived_at = action === "archive" ? new Date().toISOString() : null;

  const { error } = await supabase
    .from("suppliers")
    .update({ archived_at })
    .eq("id", params.id)
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, archived_at });
}
