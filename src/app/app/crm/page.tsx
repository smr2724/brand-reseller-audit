import { createSupabaseServerClient } from "@/lib/supabase/server";
import Link from "next/link";
import { ExternalLink, Mail, Link as LinkIcon, Users } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function CrmHubPage() {
  const supabase = createSupabaseServerClient();

  // All saved contacts (not archived) with their supplier and any outreach thread.
  const { data: contacts } = await supabase
    .from("contacts")
    .select(`
      id, supplier_id, full_name, title, email, email_status, linkedin_url,
      ai_priority_rank, ai_priority_reason, enriched_at, created_at,
      suppliers ( id, company_name, domain )
    `)
    .is("archived_at", null)
    .order("created_at", { ascending: false });

  const { data: threads } = await supabase
    .from("outreach_threads")
    .select("id, contact_id, supplier_id, status, subject, outlook_web_link, created_at, sent_at")
    .order("created_at", { ascending: false });

  // Group by supplier
  const bySupplier: Record<string, { supplier: any; contacts: any[] }> = {};
  for (const c of (contacts ?? []) as any[]) {
    const sid = c.supplier_id;
    if (!bySupplier[sid]) {
      bySupplier[sid] = { supplier: c.suppliers, contacts: [] };
    }
    bySupplier[sid].contacts.push(c);
  }
  const supplierGroups = Object.entries(bySupplier);

  // Quick KPIs
  const totalContacts = contacts?.length ?? 0;
  const totalThreads = threads?.length ?? 0;
  const sentCount = (threads ?? []).filter((t: any) => t.status === "sent").length;
  const draftCount = (threads ?? []).filter((t: any) => t.status === "draft").length;

  const threadByContact: Record<string, any> = {};
  for (const t of (threads ?? []) as any[]) {
    if (!threadByContact[t.contact_id]) threadByContact[t.contact_id] = t;
  }

  return (
    <div className="p-4 md:p-6 max-w-[1300px] mx-auto">
      <div className="mb-5 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight">CRM</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            Every contact you&apos;ve enriched, grouped by supplier. Open a supplier to find more or draft outreach.
          </p>
        </div>
        <Link href="/app/suppliers" className="btn">
          <Users size={14} /> All suppliers
        </Link>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Kpi label="Suppliers with contacts" value={supplierGroups.length} />
        <Kpi label="Saved contacts" value={totalContacts} />
        <Kpi label="Drafts" value={draftCount} tone="yellow" />
        <Kpi label="Sent" value={sentCount} tone="green" />
      </div>

      {supplierGroups.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="text-sm text-[var(--text-muted)]">
            No contacts saved yet. Open a supplier and click <strong className="text-[var(--text)]">Find contacts</strong> to get started.
          </div>
          <Link href="/app/suppliers" className="btn btn-primary mt-4 inline-flex">Browse suppliers</Link>
        </div>
      ) : (
        <div className="space-y-4">
          {supplierGroups.map(([sid, group]) => {
            const sup = group.supplier;
            const sortedContacts = [...group.contacts].sort(
              (a, b) => (a.ai_priority_rank ?? 99) - (b.ai_priority_rank ?? 99)
            );
            return (
              <div key={sid} className="card p-4">
                <div className="flex items-center justify-between flex-wrap gap-2 mb-3 pb-3 border-b border-[var(--border-soft)]">
                  <div>
                    <Link
                      href={`/app/suppliers/${sid}`}
                      className="font-semibold text-base hover:underline"
                    >
                      {sup?.company_name ?? "—"}
                    </Link>
                    {sup?.domain && (
                      <div className="text-xs text-[var(--text-muted)] mt-0.5">{sup.domain}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                    <span>{sortedContacts.length} contact{sortedContacts.length === 1 ? "" : "s"}</span>
                    <Link href={`/app/suppliers/${sid}`} className="btn btn-ghost text-xs">
                      <ExternalLink size={12} /> Open
                    </Link>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th style={{ width: 32 }}>#</th>
                        <th>Name</th>
                        <th>Title</th>
                        <th>Email</th>
                        <th>Status</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedContacts.map((c) => {
                        const thread = threadByContact[c.id];
                        return (
                          <tr key={c.id}>
                            <td>
                              {c.ai_priority_rank ? (
                                <span className="pill pill-deep" style={{ fontSize: 10 }}>
                                  #{c.ai_priority_rank}
                                </span>
                              ) : (
                                <span className="text-xs text-[var(--text-muted)]">—</span>
                              )}
                            </td>
                            <td>
                              <div className="font-medium text-sm">{c.full_name}</div>
                              {c.ai_priority_reason && (
                                <div className="text-[11px] text-[var(--text-muted)] italic mt-0.5 max-w-md">
                                  &ldquo;{c.ai_priority_reason}&rdquo;
                                </div>
                              )}
                            </td>
                            <td className="text-xs">{c.title ?? "—"}</td>
                            <td className="text-xs">
                              {c.email ? (
                                <a href={`mailto:${c.email}`} className="hover:underline break-all">
                                  {c.email}
                                </a>
                              ) : (
                                <span className="text-[var(--text-muted)]">—</span>
                              )}
                              {c.email_status && (
                                <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                                  {c.email_status}
                                </div>
                              )}
                            </td>
                            <td>
                              {thread ? (
                                <span className={`pill ${thread.status === "sent" ? "pill-launch" : "pill-watch"}`} style={{ fontSize: 10 }}>
                                  {thread.status}
                                </span>
                              ) : (
                                <span className="text-xs text-[var(--text-muted)]">—</span>
                              )}
                            </td>
                            <td>
                              <div className="flex items-center gap-2 text-xs">
                                {c.linkedin_url && (
                                  <a
                                    href={c.linkedin_url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 text-[var(--text-muted)] hover:underline"
                                  >
                                    <LinkIcon size={12} /> LI
                                  </a>
                                )}
                                {thread && thread.outlook_web_link && (
                                  <a
                                    href={thread.outlook_web_link}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 text-[var(--gold)] hover:underline"
                                  >
                                    <Mail size={12} /> Open draft
                                  </a>
                                )}
                                {thread && !thread.outlook_web_link && c.email && (
                                  <a
                                    href={`mailto:${c.email}?subject=${encodeURIComponent(thread.subject ?? "")}`}
                                    className="inline-flex items-center gap-1 text-[var(--gold)] hover:underline"
                                  >
                                    <Mail size={12} /> Open mailto
                                  </a>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: any; tone?: "green" | "yellow" | "orange" }) {
  const color =
    tone === "green" ? "#86efac" : tone === "yellow" ? "#fde047" : tone === "orange" ? "#fdba74" : "var(--text)";
  return (
    <div className="card px-4 py-3">
      <div className="text-[11px] text-[var(--text-muted)] uppercase tracking-wide">{label}</div>
      <div className="text-xl md:text-2xl font-semibold mt-1" style={{ color }}>{value}</div>
    </div>
  );
}
