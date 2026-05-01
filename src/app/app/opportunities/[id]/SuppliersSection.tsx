import { createSupabaseServerClient } from "@/lib/supabase/server";
import Link from "next/link";
import FindSuppliersButton from "./FindSuppliersButton";

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
  T1_NV_adjacent: "Tier 1",
  T2_west_us: "Tier 2",
  T3_rest_us: "Tier 3",
  T4_mexico: "Tier 4",
  T5_intl: "Tier 5",
  unknown: "—",
};

function prettyChannel(c?: string | null): string {
  switch (c) {
    case "manufacturer_b2b": return "Manufacturer (B2B)";
    case "manufacturer_dtc": return "Manufacturer (DTC)";
    case "distributor": return "Distributor";
    case "retailer": return "Retailer";
    case "marketplace": return "Marketplace";
    case "content_site": return "Content";
    default: return "Unknown";
  }
}

export default async function SuppliersSection({ opportunityId }: { opportunityId: string }) {
  const supabase = createSupabaseServerClient();

  const [{ data: pairs }, { data: scan }, { data: activeJob }] = await Promise.all([
    supabase
      .from("opportunity_suppliers")
      .select(`
        id, supplier_score, recommended_path, ranked_position,
        fit_summary, why_excited, why_skeptical, outreach_angle,
        suppliers (
          id, company_name, website, domain,
          hq_city, hq_state, hq_country, geo_tier,
          sells_on_amazon, channel_type, contact_email, contact_phone, contact_form_url,
          archived_at
        )
      `)
      .eq("opportunity_id", opportunityId)
      .order("ranked_position", { ascending: true }),
    supabase
      .from("supplier_scans")
      .select("status, started_at, completed_at, candidates_found, candidates_qualified")
      .eq("opportunity_id", opportunityId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("jobs")
      .select("id, status")
      .eq("type", "supplier_scan")
      .eq("related_opportunity_id", opportunityId)
      .in("status", ["pending", "running"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  // Hide pairs whose supplier is archived
  const list = (pairs ?? []).filter((p: any) => p.suppliers && !p.suppliers.archived_at);
  const partners = list.filter((p: any) => p.recommended_path === "partner").length;
  const cleanCount = list.filter((p: any) => p.suppliers && !p.suppliers.sells_on_amazon).length;

  return (
    <div className="card p-4 md:p-5 mb-4">
      <div className="flex items-start justify-between flex-wrap gap-2 mb-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider">Suppliers</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            B2B / wholesale-only manufacturers ranked for path-of-least-resistance to a partnership.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <FindSuppliersButton
            opportunityId={opportunityId}
            hasSuppliers={(list?.length ?? 0) > 0}
            scanStatus={activeJob?.status ?? null}
            initialJobId={activeJob?.id ?? null}
          />
          {scan && (
            <div className="text-[10px] text-[var(--text-muted)] text-right">
              {scan.status === "complete"
                ? <>Last scanned {scan.completed_at ? new Date(scan.completed_at).toLocaleDateString() : ""} · {scan.candidates_qualified}/{scan.candidates_found} qualified</>
                : <>Scan {scan.status}</>}
            </div>
          )}
        </div>
      </div>

      {list.length > 0 && (
        <div className="grid grid-cols-3 gap-3 mb-4 text-center">
          <div className="rounded-md bg-[var(--bg-3)] py-2">
            <div className="text-xl font-semibold">{list.length}</div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Qualified</div>
          </div>
          <div className="rounded-md bg-[var(--bg-3)] py-2">
            <div className="text-xl font-semibold" style={{ color: cleanCount > 0 ? "var(--accent)" : undefined }}>{cleanCount}</div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Not on Amazon</div>
          </div>
          <div className="rounded-md bg-[var(--bg-3)] py-2">
            <div className="text-xl font-semibold" style={{ color: partners > 0 ? "var(--accent)" : undefined }}>{partners}</div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Partner candidates</div>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {list.map((p: any) => {
          const s = p.suppliers;
          if (!s) return null;
          return (
            <div key={p.id} className="rounded-lg border border-[var(--border-soft)] p-3">
              <div className="flex items-start justify-between flex-wrap gap-2">
                <div className="flex-1 min-w-[200px]">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-xs font-mono text-[var(--text-muted)]">#{p.ranked_position}</span>
                    <span className={`pill ${PATH_COLOR[p.recommended_path] ?? "pill-new"}`}>{PATH_LABEL[p.recommended_path] ?? p.recommended_path}</span>
                    {s.sells_on_amazon
                      ? <span className="pill pill-reject text-[10px]">On Amazon</span>
                      : <span className="pill pill-deep text-[10px]">Not on Amazon</span>}
                    <span className="text-[10px] text-[var(--text-muted)]">{prettyChannel(s.channel_type)}</span>
                  </div>
                  <Link href={`/app/suppliers/${s.id}`} className="font-semibold hover:underline">{s.company_name}</Link>
                  <div className="text-xs text-[var(--text-muted)] mt-0.5">
                    <a href={s.website} target="_blank" rel="noreferrer" className="hover:underline">{s.domain}</a>
                    <span className="mx-1.5">·</span>
                    {[s.hq_city, s.hq_state, s.hq_country].filter(Boolean).join(", ") || "—"}
                    <span className="mx-1.5">·</span>
                    {GEO_LABEL[s.geo_tier] ?? s.geo_tier}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase text-[var(--text-muted)]">Score</div>
                  <div className="text-2xl font-semibold tabular-nums" style={{ color: p.supplier_score >= 70 ? "var(--accent)" : undefined }}>{p.supplier_score}</div>
                </div>
              </div>

              {p.fit_summary && (
                <p className="text-sm leading-relaxed mt-2">{p.fit_summary}</p>
              )}

              <div className="flex flex-wrap gap-3 mt-2 text-[11px] text-[var(--text-muted)]">
                {s.contact_email && <a href={`mailto:${s.contact_email}`} className="hover:underline">{s.contact_email}</a>}
                {s.contact_phone && <a href={`tel:${s.contact_phone}`} className="hover:underline">{s.contact_phone}</a>}
                {s.contact_form_url && <a href={s.contact_form_url} target="_blank" rel="noreferrer" className="hover:underline">Contact form</a>}
              </div>
            </div>
          );
        })}

        {!list.length && (
          <div className="text-center py-8 text-sm text-[var(--text-muted)]">
            {scan?.status === "running"
              ? "Supplier scan in progress…"
              : "No suppliers found yet for this opportunity."}
          </div>
        )}
      </div>
    </div>
  );
}
