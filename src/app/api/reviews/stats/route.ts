import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [{ data: brandRows }, { data: recentReviews }] = await Promise.all([
    supabase.from("brands").select("status, disqualifier_tags, last_reviewed_at").eq("user_id", user.id),
    supabase
      .from("brand_reviews")
      .select("decision, disqualifier_reason, created_at")
      .eq("user_id", user.id)
      .gte("created_at", sevenDaysAgo),
  ]);

  const counts = {
    total_brands: 0,
    new: 0,
    qualified: 0,
    disqualified: 0,
    needs_research: 0,
    contacted: 0,
    client: 0,
  } as Record<string, number>;

  let queueRemaining = 0;
  for (const b of brandRows ?? []) {
    counts.total_brands++;
    const s = (b as { status: string }).status;
    if (s in counts) counts[s]++;
    const lr = (b as { last_reviewed_at: string | null }).last_reviewed_at;
    const isReviewable = s !== "disqualified" && s !== "client";
    const isStale = !lr || lr < oneDayAgo;
    if (isReviewable && isStale) queueRemaining++;
  }

  const reviewed7d = recentReviews?.length ?? 0;
  const decisionsLast7d = { qualified: 0, disqualified: 0, needs_research: 0, skip: 0 } as Record<string, number>;
  const disqualifierBreakdown: Record<string, number> = {};
  for (const r of recentReviews ?? []) {
    const d = (r as { decision: string }).decision;
    if (d in decisionsLast7d) decisionsLast7d[d]++;
    if (d === "disqualified") {
      const reason = (r as { disqualifier_reason: string | null }).disqualifier_reason ?? "unspecified";
      disqualifierBreakdown[reason] = (disqualifierBreakdown[reason] ?? 0) + 1;
    }
  }

  return NextResponse.json({
    total_brands: counts.total_brands,
    by_status: counts,
    queue_remaining: queueRemaining,
    reviewed_last_7d: reviewed7d,
    decisions_last_7d: decisionsLast7d,
    disqualifier_breakdown: disqualifierBreakdown,
  });
}
