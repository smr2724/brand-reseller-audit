import { createSupabaseServerClient } from "@/lib/supabase/server";
import Link from "next/link";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ManufacturersPage() {
  const supabase = createSupabaseServerClient();

  const { data: mfrs } = await supabase
    .from("manufacturers")
    .select("*, opportunities(id, name, main_keyword, category, legion_score, recommended_path)")
    .order("created_at", { ascending: false })
    .limit(200);

  const statuses = ["identified", "researched", "contact_found", "outreach_sent", "replied", "call_booked", "not_interested", "deal_discussion", "dead"];

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto">
      <div className="mb-5 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Manufacturer Pipeline</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Track manufacturer discovery and outreach. Records are scoped per opportunity.</p>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="data-table min-w-[900px]">
            <thead>
              <tr>
                <th>Company</th>
                <th>Opportunity</th>
                <th>Website</th>
                <th>Product Line</th>
                <th className="numeric">Fit</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {(mfrs ?? []).map(m => (
                <tr key={m.id}>
                  <td className="font-medium">{m.company_name ?? "—"}</td>
                  <td>
                    {m.opportunities
                      ? <Link href={`/app/opportunities/${m.opportunities.id}`} className="hover:underline">{m.opportunities.name ?? m.opportunities.main_keyword}</Link>
                      : <span className="text-[var(--text-muted)]">—</span>}
                  </td>
                  <td>{m.website ? <a className="hover:underline text-[var(--text-muted)]" href={m.website} target="_blank" rel="noreferrer">{m.website.replace(/^https?:\/\//, "")}</a> : "—"}</td>
                  <td className="text-xs">{m.product_line ?? "—"}</td>
                  <td className="numeric">{m.fit_score ?? "—"}</td>
                  <td><span className="pill pill-new">{m.contact_status ?? "identified"}</span></td>
                  <td className="text-xs text-[var(--text-muted)]">{formatDate(m.created_at)}</td>
                </tr>
              ))}
              {!mfrs?.length && (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-[var(--text-muted)]">
                    No manufacturers tracked yet. Add them from an opportunity detail page (Phase 2).
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 text-xs text-[var(--text-muted)]">
        <div className="mb-1">Statuses: {statuses.join(" · ")}</div>
        <div>Phase 2 will add manufacturer discovery automation (Apollo, Thomasnet) + outreach email generation.</div>
      </div>
    </div>
  );
}
