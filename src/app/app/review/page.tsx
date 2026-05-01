import { createSupabaseServerClient } from "@/lib/supabase/server";
import Link from "next/link";
import { LegionScore, PathPill, StatusPill } from "@/components/ScorePills";
import { formatNumber, formatMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ReviewQueuePage() {
  const supabase = createSupabaseServerClient();

  const base = () => supabase.from("opportunities").select("*").is("archived_at", null);

  // 1) Top 10 highest-scoring new (status = 'new' or 'review' or 'deep_dive' not yet decided)
  const { data: topNew } = await base()
    .in("status", ["new", "review", "deep_dive"])
    .order("legion_score", { ascending: false, nullsFirst: false })
    .limit(10);

  // 2) Top 10 needing manual score review (score between 55 and 79)
  const { data: manualReview } = await base()
    .gte("legion_score", 55).lte("legion_score", 79)
    .order("legion_score", { ascending: false })
    .limit(10);

  // 3) Top 10 "high demand but weak product advantage" traps
  const { data: traps } = await base()
    .gte("demand_score", 12).lte("product_advantage_score", 9)
    .order("demand_score", { ascending: false })
    .limit(10);

  // 4) Top 10 manufacturer-search-ready (partner path + high partner score)
  const { data: mfrReady } = await base()
    .eq("recommended_path", "partner")
    .gte("partner_score", 6)
    .order("legion_score", { ascending: false })
    .limit(10);

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto">
      <div className="mb-5">
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Review Queue</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">The app surfaces opportunities that need a decision. No research graveyards.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <QueueCard title="Top 10 High-Scoring New" subtitle="Not yet decided — make the call" rows={topNew ?? []} />
        <QueueCard title="Top 10 Needing Manual Review" subtitle="Score 55–79: borderline, judgment call" rows={manualReview ?? []} />
        <QueueCard title="Top 10 Demand-Trap Candidates" subtitle="High demand but weak product-advantage potential" rows={traps ?? []} tone="red" />
        <QueueCard title="Top 10 Manufacturer-Search-Ready" subtitle="Partner path + strong partner score" rows={mfrReady ?? []} tone="violet" />
      </div>
    </div>
  );
}

function QueueCard({ title, subtitle, rows, tone }: { title: string; subtitle: string; rows: any[]; tone?: "red" | "violet" }) {
  const color = tone === "red" ? "#fca5a5" : tone === "violet" ? "#c4b5fd" : "var(--text)";
  return (
    <div className="card p-4">
      <div className="mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color }}>{title}</h2>
        <div className="text-xs text-[var(--text-muted)] mt-0.5">{subtitle}</div>
      </div>
      <div className="space-y-1.5">
        {rows.map(o => (
          <Link key={o.id} href={`/app/opportunities/${o.id}`} className="card-soft p-2.5 flex items-center gap-3 hover:border-[var(--border)]">
            <div className="w-9 text-center"><LegionScore value={o.legion_score} size="sm" /></div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{o.name ?? o.main_keyword}</div>
              <div className="text-[11px] text-[var(--text-muted)] truncate">
                {formatNumber(o.monthly_search_volume)} mo · {formatNumber(o.top_10_avg_reviews)} rev · {formatMoney(o.avg_price)}
              </div>
            </div>
            <div className="flex flex-col gap-1 items-end">
              <StatusPill value={o.status} />
              <PathPill value={o.recommended_path} />
            </div>
          </Link>
        ))}
        {!rows.length && <div className="text-xs text-[var(--text-muted)] py-3 text-center">No items.</div>}
      </div>
    </div>
  );
}
