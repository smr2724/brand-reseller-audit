import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const VALID_STATUS = new Set(["new", "qualified", "disqualified", "contacted", "client"]);

const SORTS: Record<string, { col: string; asc: boolean }> = {
  score_desc: { col: "brand_score", asc: false },
  dominant_pct_asc: { col: "dominant_seller_sales_pct", asc: true },
  revenue_desc: { col: "est_monthly_revenue", asc: false },
  name_asc: { col: "name", asc: true },
};

export async function GET(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "";
  const q = url.searchParams.get("q") ?? "";
  const sort = url.searchParams.get("sort") ?? "score_desc";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);

  let query = supabase.from("brands").select("*").eq("user_id", user.id);
  if (status && VALID_STATUS.has(status)) query = query.eq("status", status);
  if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);

  const sortDef = SORTS[sort] ?? SORTS.score_desc;
  query = query.order(sortDef.col, { ascending: sortDef.asc, nullsFirst: false }).limit(limit);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Stats strip — overall counts ignoring filters
  const { data: stats } = await supabase
    .from("brands")
    .select("status")
    .eq("user_id", user.id);

  const counts = { total: 0, new: 0, qualified: 0, disqualified: 0, contacted: 0, client: 0 };
  for (const r of stats ?? []) {
    counts.total++;
    const s = (r as { status: string }).status;
    if (s in counts) (counts as Record<string, number>)[s]++;
  }

  return NextResponse.json({ brands: data ?? [], counts });
}
