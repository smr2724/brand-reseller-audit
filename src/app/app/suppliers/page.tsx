import { createSupabaseServerClient } from "@/lib/supabase/server";
import Link from "next/link";
import SuppliersFilters from "./SuppliersFilters";

export const dynamic = "force-dynamic";

interface SearchParams {
  q?: string;
  geo?: string;
  path?: string;
  amazon?: string;
  channel?: string;
  min?: string;
  archived?: string;
}

const PATH_LABEL: Record<string, string> = {
  partner: "Partner",
  private_label: "Private label",
  wholesale_resell: "Wholesale resell",
  skip: "Skip",
};
const PATH_COLOR: Record<string, string> = {
  partner: "pill-deep",
  private_label: "pill-review",
  wholesale_resell: "pill-watch",
  skip: "pill-reject",
};
const GEO_LABEL: Record<string, string> = {
  T1_NV_adjacent: "Tier 1 · NV/UT/AZ/CA/ID/OR",
  T2_west_us: "Tier 2 · Western US",
  T3_rest_us: "Tier 3 · Rest of US",
  T4_mexico: "Tier 4 · Mexico",
  T5_intl: "Tier 5 · International",
  unknown: "Unknown",
};

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const supabase = createSupabaseServerClient();
  const sp = await searchParams;
  const showArchived = sp.archived === "1";

  // Pull suppliers with their best opportunity_supplier pairing for ranking
  let query = supabase
    .from("suppliers")
    .select(`
      id, company_name, website, domain, hq_city, hq_state, hq_country,
      geo_tier, geo_score, sells_on_amazon, amazon_evidence, channel_type,
      is_manufacturer, turnkey_score, quality_score, reachability_score,
      product_lines, industries, description, founded_year, employee_estimate,
      created_at, archived_at,
      opportunity_suppliers (
        id, supplier_score, recommended_path, ranked_position, fit_summary,
        opportunity_id,
        opportunities ( id, name, legion_score, recommended_path, archived_at )
      )
    `)
    .order("created_at", { ascending: false })
    .limit(500);

  if (showArchived) {
    query = query.not("archived_at", "is", null);
  } else {
    query = query.is("archived_at", null);
  }

  if (sp.q) {
    query = query.or(`company_name.ilike.%${sp.q}%,domain.ilike.%${sp.q}%`);
  }
  if (sp.geo) query = query.eq("geo_tier", sp.geo);
  if (sp.amazon === "no") query = query.eq("sells_on_amazon", false);
  if (sp.amazon === "yes") query = query.eq("sells_on_amazon", true);
  if (sp.channel) query = query.eq("channel_type", sp.channel);

  const { data: suppliersRaw } = await query;

  // Archived count for the toggle badge
  const { count: archivedCount } = await supabase
    .from("suppliers")
    .select("id", { count: "exact", head: true })
    .not("archived_at", "is", null);

  const minScore = sp.min ? parseInt(sp.min, 10) : 0;
  const pathFilter = sp.path;

  // Compute "best score" across opportunities. Prefer pairs whose opportunity is active.
  const suppliers = (suppliersRaw ?? []).map((s: any) => {
    const pairs = s.opportunity_suppliers ?? [];
    const activePairs = pairs.filter((p: any) => p.opportunities && !p.opportunities.archived_at);
    const ranked = (activePairs.length ? activePairs : pairs).slice().sort(
      (a: any, b: any) => (b.supplier_score ?? 0) - (a.supplier_score ?? 0)
    );
    const bestPair = ranked[0] ?? null;
    return {
      ...s,
      best_score: bestPair?.supplier_score ?? 0,
      best_path: bestPair?.recommended_path ?? "—",
      pair_count: pairs.length,
      active_pair_count: activePairs.length,
      active_pairs: activePairs,
      best_pair: bestPair,
    };
  })
    .filter((s: any) => s.best_score >= minScore)
    .filter((s: any) => !pathFilter || s.best_path === pathFilter)
    .sort((a: any, b: any) => b.best_score - a.best_score);

  // Top-line stats
  const total = suppliers.length;
  const cleanCount = suppliers.filter((s: any) => !s.sells_on_amazon).length;
  const partnerCount = suppliers.filter((s: any) => s.best_path === "partner").length;
  const tier1Count = suppliers.filter((s: any) => s.geo_tier === "T1_NV_adjacent").length;

  return (
    <div className="p-4 md:p-6 max-w-[1500px] mx-auto">
      <div className="mb-5 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight">
            {showArchived ? "Archived Suppliers" : "Suppliers"}
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            {showArchived
              ? "Viewing archived suppliers. Click Restore on a supplier to bring it back."
              : "Top-rated supplier per active opportunity. Higher score = better path-of-least-resistance fit (not on Amazon, manufacturer-grade, near Las Vegas)."}
          </p>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <StatCard label="Total suppliers" value={total} />
        <StatCard label="Not on Amazon" value={cleanCount} sub={`${total ? Math.round(cleanCount / total * 100) : 0}%`} />
        <StatCard label="Partner candidates" value={partnerCount} />
        <StatCard label="Tier 1 (NV / adjacent)" value={tier1Count} />
      </div>

      <SuppliersFilters initial={sp} archivedCount={archivedCount ?? 0} showArchived={showArchived} />

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="data-table min-w-[1100px]">
            <thead>
              <tr>
                <th className="numeric" style={{ width: 80 }}>Score</th>
                <th>Company</th>
                <th>Channel</th>
                <th>Geo</th>
                <th>On Amazon?</th>
                <th>Best path</th>
                <th>Top opportunity match</th>
                <th className="numeric">Active opps</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s: any) => {
                const opp = s.best_pair?.opportunities;
                const pathClass = PATH_COLOR[s.best_path] ?? "pill-new";
                return (
                  <tr key={s.id}>
                    <td className="numeric font-mono font-semibold" style={{ color: s.best_score >= 70 ? "var(--accent)" : undefined }}>
                      {s.best_score}
                    </td>
                    <td>
                      <Link href={`/app/suppliers/${s.id}`} className="font-medium hover:underline">{s.company_name}</Link>
                      <div className="text-xs text-[var(--text-muted)] mt-0.5">
                        <a href={s.website} target="_blank" rel="noreferrer" className="hover:underline">{s.domain}</a>
                      </div>
                    </td>
                    <td>
                      <span className="text-xs">{prettyChannel(s.channel_type)}</span>
                    </td>
                    <td>
                      <div className="text-xs">
                        {[s.hq_city, s.hq_state, s.hq_country].filter(Boolean).join(", ") || "—"}
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)]">{GEO_LABEL[s.geo_tier] ?? s.geo_tier}</div>
                    </td>
                    <td>
                      {s.sells_on_amazon
                        ? <span className="pill pill-reject">YES</span>
                        : <span className="pill pill-deep">No</span>}
                    </td>
                    <td>
                      <span className={`pill ${pathClass}`}>{PATH_LABEL[s.best_path] ?? s.best_path}</span>
                    </td>
                    <td>
                      {opp
                        ? <Link href={`/app/opportunities/${opp.id}`} className="hover:underline text-xs">{opp.name}</Link>
                        : <span className="text-[var(--text-muted)] text-xs">—</span>}
                    </td>
                    <td className="numeric text-xs">{s.active_pair_count}</td>
                  </tr>
                );
              })}
              {!suppliers.length && (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-[var(--text-muted)]">
                    No suppliers yet. Run a supplier scan from any opportunity detail page.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 text-xs text-[var(--text-muted)]">
        <div className="mb-1">
          <strong>Score formula</strong> — Not on Amazon (40%) · Turnkey/manufacturer (25%) · Geo proximity (15%) · Quality (10%) · Reachability (10%).
        </div>
        <div>
          <strong>Path recommendation</strong> — Partner (run e-commerce for equity) preferred over Private label (we buy + relabel) over Wholesale resell (avoid).
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="card p-3">
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}{sub && <span className="text-xs text-[var(--text-muted)] font-normal ml-2">{sub}</span>}</div>
    </div>
  );
}

function prettyChannel(c?: string): string {
  switch (c) {
    case "manufacturer_b2b": return "Manufacturer (B2B)";
    case "manufacturer_dtc": return "Manufacturer (DTC)";
    case "distributor": return "Distributor";
    case "retailer": return "Retailer";
    case "marketplace": return "Marketplace";
    case "content_site": return "Content site";
    default: return "Unknown";
  }
}
