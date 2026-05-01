import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sortQueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

const ALLOWED_STATUS = new Set(["new", "qualified", "needs_research", "contacted"]);

export async function GET(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status") ?? "";
  const includeRecent = url.searchParams.get("include_recent") === "1";

  let query = supabase
    .from("brands")
    .select("*")
    .eq("user_id", user.id)
    .not("status", "in", '("disqualified","client")')
    .limit(500);

  if (statusParam && ALLOWED_STATUS.has(statusParam)) {
    query = query.eq("status", statusParam);
  }

  if (!includeRecent) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // Either never reviewed, or reviewed before the cutoff.
    query = query.or(`last_reviewed_at.is.null,last_reviewed_at.lt.${since}`);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const sorted = sortQueue(data ?? []).slice(0, 100);
  return NextResponse.json({ brands: sorted, total: sorted.length });
}
