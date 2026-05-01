import { createSupabaseServerClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { LegionScore, StatusPill, PathPill, ScoreBar } from "@/components/ScorePills";
import { formatNumber, formatMoney, formatDate, formatDateTime } from "@/lib/utils";
import DecisionButtons from "./DecisionButtons";
import NotesPanel from "./NotesPanel";
import ProductsTable from "./ProductsTable";
import RefreshButton from "./RefreshButton";
import SuppliersSection from "./SuppliersSection";
import ArchiveButton from "./ArchiveButton";

export const dynamic = "force-dynamic";

export default async function OpportunityPage({ params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: opp } = await supabase.from("opportunities").select("*").eq("id", params.id).single();
  if (!opp) notFound();

  const { data: keywords } = await supabase
    .from("keywords").select("*").eq("opportunity_id", params.id)
    .order("search_volume", { ascending: false, nullsFirst: false }).limit(100);

  const { data: oppProducts } = await supabase
    .from("opportunity_products")
    .select("*, products(*)")
    .eq("opportunity_id", params.id)
    .order("position", { ascending: true });

  const { data: notes } = await supabase.from("notes").select("*").eq("opportunity_id", params.id)
    .order("created_at", { ascending: false });

  const products = (oppProducts ?? []).map((op: any) => ({
    ...op.products, position: op.position, weakness_notes: op.weakness_notes,
    listing_quality_score: op.listing_quality_score, is_sponsored_serp: op.sponsored_position != null,
  }));

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto">
      <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
        <Link href="/app/dashboard" className="text-xs text-[var(--text-muted)] hover:underline">← Back to dashboard</Link>
        <div className="text-xs text-[var(--text-muted)]">Last scanned {formatDateTime(opp.last_scanned_at ?? opp.created_at)}</div>
      </div>

      {/* Header */}
      <div className="card p-4 md:p-6 mb-4">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div className="flex-1 min-w-[240px]">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <StatusPill value={opp.status} />
              <PathPill value={opp.recommended_path} />
              <span className="text-xs text-[var(--text-muted)]">{opp.category ?? "Other"}</span>
              {opp.archived_at && (
                <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)]">
                  Archived
                </span>
              )}
            </div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">{opp.name ?? opp.main_keyword}</h1>
            <div className="text-sm text-[var(--text-muted)] mt-1">Main keyword: <span className="text-[var(--text)]">{opp.main_keyword}</span></div>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-[var(--text-muted)] uppercase tracking-wide">Legion Score</div>
            <LegionScore value={opp.legion_score} size="xl" />
            <div className="text-xs text-[var(--text-muted)] mt-1">/ 100</div>
          </div>
        </div>

        {/* Score bars */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-5">
          <ScoreBar label="Demand" value={Number(opp.demand_score ?? 0)} max={20} />
          <ScoreBar label="Competition Weakness" value={Number(opp.competition_weakness_score ?? 0)} max={20} />
          <ScoreBar label="Product Advantage" value={Number(opp.product_advantage_score ?? 0)} max={20} />
          <ScoreBar label="Visual Demo" value={Number(opp.visual_demo_score ?? 0)} max={15} />
          <ScoreBar label="Economics" value={Number(opp.economics_score ?? 0)} max={15} />
          <ScoreBar label="Partner Avail." value={Number(opp.partner_score ?? 0)} max={10} />
        </div>

        {/* Action buttons */}
        <div className="mt-5 pt-4 border-t border-[var(--border-soft)] flex flex-wrap gap-2 items-center">
          <DecisionButtons id={opp.id} status={opp.status} />
          <div className="flex-1" />
          <ArchiveButton id={opp.id} archived={!!opp.archived_at} />
          <RefreshButton id={opp.id} />
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <Kpi label="Monthly Vol" value={formatNumber(opp.monthly_search_volume)} />
        <Kpi label="Cluster Vol" value={formatNumber(opp.total_cluster_search_volume)} />
        <Kpi label="Top10 Avg Rev" value={formatNumber(opp.top_10_avg_reviews)} />
        <Kpi label="Top10 Avg Rate" value={opp.top_10_avg_rating != null ? Number(opp.top_10_avg_rating).toFixed(2) : "—"} />
        <Kpi label="Avg Price" value={formatMoney(opp.avg_price)} />
      </div>

      {/* Executive summary */}
      <Section title="Executive Summary">
        <p className="text-sm leading-relaxed whitespace-pre-line">{opp.summary ?? "No summary yet."}</p>
      </Section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <Section title="Why This Might Be a Legion-Like Opportunity" tone="green">
          <p className="text-sm leading-relaxed whitespace-pre-line">{opp.why_excited ?? "—"}</p>
        </Section>
        <Section title="Why This Might Be a Trap" tone="red">
          <p className="text-sm leading-relaxed whitespace-pre-line">{opp.why_skeptical ?? "—"}</p>
        </Section>
      </div>

      <Section title="Demand Analysis">
        <div className="text-sm text-[var(--text-muted)] mb-2">
          Cluster total {formatNumber(opp.total_cluster_search_volume)} · {(keywords?.length ?? 0)} keywords in cluster
        </div>
        <div className="overflow-x-auto -mx-3 md:mx-0">
          <table className="data-table min-w-[500px]">
            <thead>
              <tr><th>Keyword</th><th>Intent</th><th className="numeric">Monthly Volume</th></tr>
            </thead>
            <tbody>
              {(keywords ?? []).slice(0, 30).map(k => (
                <tr key={k.id}>
                  <td>{k.keyword}</td>
                  <td><span className="text-xs text-[var(--text-muted)]">{k.intent_type ?? "—"}</span></td>
                  <td className="numeric">{formatNumber(k.search_volume)}</td>
                </tr>
              ))}
              {!keywords?.length && <tr><td colSpan={3} className="text-center py-5 text-[var(--text-muted)]">No keyword data.</td></tr>}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Competition Analysis — Top ASINs">
        <ProductsTable products={products} />
      </Section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <Section title="Product Advantage Hypothesis">
          <p className="text-sm leading-relaxed whitespace-pre-line">{opp.product_advantage_hypothesis ?? "—"}</p>
        </Section>
        <Section title="Visual Demo / Content Potential">
          <p className="text-sm leading-relaxed whitespace-pre-line">{opp.visual_demo_notes ?? "—"}</p>
        </Section>
        <Section title="Economics Notes">
          <p className="text-sm leading-relaxed whitespace-pre-line">{opp.economics_notes ?? "—"}</p>
        </Section>
        <Section title="Manufacturer / Partner Hypothesis">
          <p className="text-sm leading-relaxed whitespace-pre-line">{opp.partner_notes ?? "—"}</p>
        </Section>
      </div>

      <SuppliersSection opportunityId={opp.id} />

      <Section title="Steve Notes">
        <NotesPanel opportunityId={opp.id} initialNotes={notes ?? []} />
      </Section>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: any }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-[11px] text-[var(--text-muted)] uppercase tracking-wide">{label}</div>
      <div className="text-lg md:text-xl font-semibold mt-1 font-variant-tabular">{value}</div>
    </div>
  );
}

function Section({ title, children, tone }: { title: string; children: React.ReactNode; tone?: "green" | "red" }) {
  const titleColor = tone === "green" ? "#86efac" : tone === "red" ? "#fca5a5" : "var(--text)";
  return (
    <div className="card p-4 md:p-5 mb-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider mb-3" style={{ color: titleColor }}>{title}</h2>
      {children}
    </div>
  );
}
