import { createSupabaseServerClient } from "@/lib/supabase/server";
import Link from "next/link";
import { formatNumber, formatMoney } from "@/lib/utils";
import BrandsToolbar from "./BrandsToolbar";

export const dynamic = "force-dynamic";

interface Search {
  status?: string;
  q?: string;
  sort?: string;
}

const SORTS: Record<string, { col: string; asc: boolean }> = {
  score_desc: { col: "brand_score", asc: false },
  dominant_pct_asc: { col: "dominant_seller_sales_pct", asc: true },
  revenue_desc: { col: "est_monthly_revenue", asc: false },
  name_asc: { col: "name", asc: true },
};

export default async function BrandsPage({ searchParams }: { searchParams: Search }) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  let query = supabase.from("brands").select("*").eq("user_id", user!.id);
  if (searchParams.status) query = query.eq("status", searchParams.status);
  if (searchParams.q) query = query.ilike("name", `%${searchParams.q}%`);
  const sortDef = SORTS[searchParams.sort ?? "score_desc"] ?? SORTS.score_desc;
  query = query.order(sortDef.col, { ascending: sortDef.asc, nullsFirst: false }).limit(500);

  const { data: brands } = await query;

  const { data: allForCounts } = await supabase
    .from("brands")
    .select("status")
    .eq("user_id", user!.id);

  const counts = { total: 0, new: 0, qualified: 0, disqualified: 0, contacted: 0, client: 0 };
  for (const r of allForCounts ?? []) {
    counts.total++;
    const s = (r as { status: string }).status;
    if (s in counts) (counts as Record<string, number>)[s]++;
  }

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-2xl font-semibold">Brands</h1>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-6">
        <StatCard label="Total" value={counts.total} />
        <StatCard label="New" value={counts.new} />
        <StatCard label="Qualified" value={counts.qualified} />
        <StatCard label="Disqualified" value={counts.disqualified} />
        <StatCard label="Contacted" value={counts.contacted} />
        <StatCard label="Client" value={counts.client} />
      </div>

      <BrandsToolbar
        defaults={{
          status: searchParams.status ?? "",
          q: searchParams.q ?? "",
          sort: searchParams.sort ?? "score_desc",
        }}
      />

      <div className="card overflow-hidden mt-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border)]">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Category</th>
              <th className="px-4 py-3 font-medium text-right">Brand Score</th>
              <th className="px-4 py-3 font-medium text-right">Est Mo Revenue</th>
              <th className="px-4 py-3 font-medium text-right">Dom Seller %</th>
              <th className="px-4 py-3 font-medium">Country</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Tags</th>
            </tr>
          </thead>
          <tbody>
            {(brands ?? []).map((b) => (
              <tr
                key={b.id}
                className="border-b border-[var(--border-soft)] hover:bg-[var(--bg-3)] transition-colors"
              >
                <td className="px-4 py-3">
                  <Link href={`/app/brands/${b.id}`} className="font-medium hover:text-[var(--accent)]">
                    {b.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-[var(--text-muted)]">{b.category ?? "—"}</td>
                <td className="px-4 py-3 text-right">{formatNumber(b.brand_score, { decimals: 1 })}</td>
                <td className="px-4 py-3 text-right">{formatMoney(b.est_monthly_revenue)}</td>
                <td className="px-4 py-3 text-right">{formatNumber(b.dominant_seller_sales_pct, { decimals: 1 })}</td>
                <td className="px-4 py-3 text-[var(--text-muted)]">{b.dominant_seller_country ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className="px-2 py-1 rounded text-xs bg-[var(--bg-3)] border border-[var(--border)]">
                    {b.status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {(b.disqualifier_tags ?? []).map((t: string) => (
                      <span
                        key={t}
                        className="px-1.5 py-0.5 rounded text-[10px] bg-[#2a1415] text-[#f87171] border border-[#4a1e21]"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
            {(!brands || brands.length === 0) && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-[var(--text-muted)]">
                  No brands yet. Upload a SmartScout export above to get started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="card-soft p-3">
      <div className="text-xs text-[var(--text-muted)]">{label}</div>
      <div className="text-xl font-semibold mt-1">{formatNumber(value)}</div>
    </div>
  );
}
