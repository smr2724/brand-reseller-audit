import { createSupabaseServerClient } from "@/lib/supabase/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import SupplierArchiveButton from "./SupplierArchiveButton";
import ContactsSection from "./ContactsSection";

export const dynamic = "force-dynamic";

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

function prettyChannel(c?: string): string {
  switch (c) {
    case "manufacturer_b2b": return "Manufacturer (B2B only)";
    case "manufacturer_dtc": return "Manufacturer (also DTC)";
    case "distributor": return "Distributor";
    case "retailer": return "Retailer";
    case "marketplace": return "Marketplace";
    case "content_site": return "Content site";
    default: return "Unknown";
  }
}

export default async function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const supabase = createSupabaseServerClient();
  const { id } = await params;

  const { data: supplier } = await supabase
    .from("suppliers")
    .select("*")
    .eq("id", id)
    .single();

  if (!supplier) notFound();

  const { data: pairs } = await supabase
    .from("opportunity_suppliers")
    .select(`
      id, supplier_score, recommended_path, ranked_position,
      fit_summary, why_excited, why_skeptical, outreach_angle,
      opportunity_id,
      opportunities ( id, name, main_keyword, legion_score, recommended_path, monthly_search_volume, top_10_avg_reviews )
    `)
    .eq("supplier_id", id)
    .order("supplier_score", { ascending: false });

  const ev = supplier.evidence ?? {};
  const serpTitles: string[] = Array.isArray(ev.serp_titles) ? ev.serp_titles : [];
  const serpSnippets: string[] = Array.isArray(ev.serp_snippets) ? ev.serp_snippets : [];
  const bestPath = pairs?.[0]?.recommended_path ?? "—";
  const bestScore = pairs?.[0]?.supplier_score ?? 0;

  // CRM data — contacts saved for this supplier and any draft threads.
  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, full_name, title, email, email_status, linkedin_url, ai_priority_rank, ai_priority_reason, enriched_at")
    .eq("supplier_id", id)
    .is("archived_at", null)
    .order("ai_priority_rank", { ascending: true });

  const { data: threads } = await supabase
    .from("outreach_threads")
    .select("id, contact_id, opportunity_id, step, status, subject, outlook_web_link, sent_at, created_at")
    .eq("supplier_id", id)
    .order("created_at", { ascending: false });

  // Existing reports for this supplier (one per opportunity max).
  const { data: reports } = await supabase
    .from("reports")
    .select("id, token, opportunity_id, created_at, views")
    .eq("supplier_id", id)
    .order("created_at", { ascending: false });

  // Build a flat list of opportunity options for the dropdown.
  const opportunityOptions = (pairs ?? [])
    .map((p: any) => ({
      opportunity_id: p.opportunity_id,
      keyword: p.opportunities?.main_keyword ?? p.opportunities?.name ?? "opportunity",
      legion_score: p.opportunities?.legion_score ?? null,
      supplier_score: p.supplier_score,
    }))
    .sort((a, b) => (b.supplier_score ?? 0) - (a.supplier_score ?? 0));

  return (
    <div className="p-4 md:p-6 max-w-[1300px] mx-auto">
      <div className="mb-3">
        <Link href="/app/suppliers" className="text-xs text-[var(--text-muted)] hover:underline">← Back to suppliers</Link>
      </div>

      {/* Header */}
      <div className="card p-4 md:p-6 mb-4">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div className="flex-1 min-w-[240px]">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className={`pill ${PATH_COLOR[bestPath] ?? "pill-new"}`}>{PATH_LABEL[bestPath] ?? bestPath}</span>
              {supplier.sells_on_amazon
                ? <span className="pill pill-reject">On Amazon</span>
                : <span className="pill pill-deep">Not on Amazon</span>}
              <span className="pill pill-new">{prettyChannel(supplier.channel_type)}</span>
              {supplier.archived_at && (
                <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)]">
                  Archived
                </span>
              )}
            </div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">{supplier.company_name}</h1>
            <div className="text-sm text-[var(--text-muted)] mt-1">
              <a href={supplier.website} target="_blank" rel="noreferrer" className="hover:underline">{supplier.domain}</a>
            </div>
            {supplier.description && (
              <p className="text-sm leading-relaxed mt-3 max-w-2xl">{supplier.description}</p>
            )}
          </div>
          <div className="flex flex-col items-end gap-3">
            <div className="text-right">
              <div className="text-[11px] text-[var(--text-muted)] uppercase tracking-wide">Best score</div>
              <div className="text-4xl font-semibold tabular-nums" style={{ color: bestScore >= 70 ? "var(--accent)" : undefined }}>{bestScore}</div>
              <div className="text-xs text-[var(--text-muted)]">/ 100</div>
            </div>
            <SupplierArchiveButton id={supplier.id} archived={!!supplier.archived_at} />
          </div>
        </div>
      </div>

      {/* CRM: Contacts & Outreach */}
      <ContactsSection
        supplierId={id}
        supplierName={supplier.company_name}
        initialContacts={(contacts ?? []) as any}
        initialThreads={(threads ?? []) as any}
        opportunityOptions={opportunityOptions}
        initialReports={(reports ?? []) as any}
      />

      {/* Quick facts */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Fact label="HQ" value={[supplier.hq_city, supplier.hq_state, supplier.hq_country].filter(Boolean).join(", ") || "—"} sub={GEO_LABEL[supplier.geo_tier] ?? supplier.geo_tier} />
        <Fact label="Founded" value={supplier.founded_year ? String(supplier.founded_year) : "—"} />
        <Fact label="Employees" value={supplier.employee_estimate ?? "—"} />
        <Fact label="Opportunities matched" value={`${pairs?.length ?? 0}`} />
      </div>

      {/* Score breakdown */}
      <Section title="Score Breakdown">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <ScoreBlock label="Not on Amazon" value={supplier.not_on_amazon_score} weight="40%" />
          <ScoreBlock label="Turnkey" value={supplier.turnkey_score} weight="25%" />
          <ScoreBlock label="Geo" value={supplier.geo_score} weight="15%" />
          <ScoreBlock label="Quality" value={supplier.quality_score} weight="10%" />
          <ScoreBlock label="Reachability" value={supplier.reachability_score} weight="10%" />
        </div>
        {supplier.amazon_evidence && (
          <div className="text-xs text-[var(--text-muted)] mt-3 italic">Amazon check: {supplier.amazon_evidence}</div>
        )}
      </Section>

      {/* Contact */}
      <Section title="Contact">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <ContactRow label="Email" value={supplier.contact_email} href={supplier.contact_email ? `mailto:${supplier.contact_email}` : undefined} />
          <ContactRow label="Phone" value={supplier.contact_phone} href={supplier.contact_phone ? `tel:${supplier.contact_phone}` : undefined} />
          <ContactRow label="Form" value={supplier.contact_form_url ? "Contact form" : null} href={supplier.contact_form_url ?? undefined} />
        </div>
      </Section>

      {/* Product / industry tags */}
      {((supplier.product_lines?.length ?? 0) > 0 || (supplier.industries?.length ?? 0) > 0) && (
        <Section title="Product Lines & Industries">
          {(supplier.product_lines?.length ?? 0) > 0 && (
            <div className="mb-3">
              <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Product lines</div>
              <div className="flex flex-wrap gap-1.5">
                {supplier.product_lines.map((p: string) => (
                  <span key={p} className="pill pill-new">{p}</span>
                ))}
              </div>
            </div>
          )}
          {(supplier.industries?.length ?? 0) > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Industries</div>
              <div className="flex flex-wrap gap-1.5">
                {supplier.industries.map((p: string) => (
                  <span key={p} className="pill pill-new">{p}</span>
                ))}
              </div>
            </div>
          )}
        </Section>
      )}

      {/* Opportunity matches */}
      <Section title={`Opportunity Matches (${pairs?.length ?? 0})`}>
        <div className="space-y-3">
          {(pairs ?? []).map((p: any) => {
            const opp = p.opportunities;
            return (
              <div key={p.id} className="rounded-lg border border-[var(--border-soft)] p-3">
                <div className="flex items-start justify-between flex-wrap gap-2 mb-2">
                  <div className="flex-1 min-w-[200px]">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-xs font-mono text-[var(--text-muted)]">#{p.ranked_position}</span>
                      <span className={`pill ${PATH_COLOR[p.recommended_path] ?? "pill-new"}`}>{PATH_LABEL[p.recommended_path] ?? p.recommended_path}</span>
                    </div>
                    {opp ? (
                      <Link href={`/app/opportunities/${opp.id}`} className="font-semibold hover:underline">{opp.name}</Link>
                    ) : <span className="font-semibold">—</span>}
                    {opp && (
                      <div className="text-xs text-[var(--text-muted)] mt-0.5">
                        Legion {opp.legion_score} · {opp.main_keyword}
                      </div>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase text-[var(--text-muted)]">Fit score</div>
                    <div className="text-2xl font-semibold tabular-nums" style={{ color: p.supplier_score >= 70 ? "var(--accent)" : undefined }}>{p.supplier_score}</div>
                  </div>
                </div>
                {p.fit_summary && (
                  <p className="text-sm leading-relaxed mt-2">{p.fit_summary}</p>
                )}
                {(p.why_excited || p.why_skeptical) && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                    {p.why_excited && (
                      <div>
                        <div className="text-[11px] uppercase tracking-wide mb-1" style={{ color: "#86efac" }}>Why excited</div>
                        <p className="text-xs leading-relaxed">{p.why_excited}</p>
                      </div>
                    )}
                    {p.why_skeptical && (
                      <div>
                        <div className="text-[11px] uppercase tracking-wide mb-1" style={{ color: "#fca5a5" }}>Why skeptical</div>
                        <p className="text-xs leading-relaxed">{p.why_skeptical}</p>
                      </div>
                    )}
                  </div>
                )}
                {p.outreach_angle && (
                  <div className="mt-3 pt-2 border-t border-[var(--border-soft)]">
                    <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Outreach angle</div>
                    <p className="text-xs italic">{p.outreach_angle}</p>
                  </div>
                )}
              </div>
            );
          })}
          {!pairs?.length && <p className="text-sm text-[var(--text-muted)]">No opportunity matches recorded.</p>}
        </div>
      </Section>

      {/* SERP evidence */}
      {(serpTitles.length > 0 || serpSnippets.length > 0) && (
        <Section title="SERP Evidence">
          <div className="space-y-2 text-xs">
            {serpTitles.map((t, i) => (
              <div key={i} className="border-l-2 border-[var(--border-soft)] pl-3">
                <div className="font-medium">{t}</div>
                {serpSnippets[i] && <div className="text-[var(--text-muted)] mt-0.5 leading-relaxed">{serpSnippets[i]}</div>}
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-4 md:p-5 mb-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider mb-3">{title}</h2>
      {children}
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="card p-3">
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className="text-base font-medium mt-1">{value}</div>
      {sub && <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{sub}</div>}
    </div>
  );
}

function ScoreBlock({ label, value, weight }: { label: string; value: number | null; weight: string }) {
  const v = value ?? 0;
  return (
    <div className="rounded-lg border border-[var(--border-soft)] p-3">
      <div className="flex items-baseline justify-between">
        <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
        <div className="text-[10px] text-[var(--text-muted)]">{weight}</div>
      </div>
      <div className="text-xl font-semibold tabular-nums mt-1" style={{ color: v >= 70 ? "var(--accent)" : undefined }}>{v}</div>
      <div className="h-1 rounded-full bg-[var(--bg-3)] mt-2 overflow-hidden">
        <div className="h-full" style={{ width: `${Math.min(100, v)}%`, background: v >= 70 ? "var(--accent)" : "var(--text-muted)" }} />
      </div>
    </div>
  );
}

function ContactRow({ label, value, href }: { label: string; value: string | null | undefined; href?: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      {value
        ? (href
            ? <a href={href} target="_blank" rel="noreferrer" className="text-sm hover:underline break-all">{value}</a>
            : <div className="text-sm break-all">{value}</div>)
        : <div className="text-sm text-[var(--text-muted)]">—</div>}
    </div>
  );
}
