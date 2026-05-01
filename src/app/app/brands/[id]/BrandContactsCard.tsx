"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Contact {
  id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email: string | null;
  email_status: string | null;
  linkedin_url: string | null;
  seniority: string | null;
  department: string | null;
  is_primary: boolean;
  disqualified: boolean;
  disqualified_reason: string | null;
}

export default function BrandContactsCard({
  brandId,
  onPrimaryContact,
}: {
  brandId: string;
  onPrimaryContact?: (c: Contact | null) => void;
}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/contacts?brand_id=${brandId}&include_disqualified=1`, { cache: "no-store" });
      const data = await res.json();
      const list: Contact[] = data.contacts ?? [];
      setContacts(list);
      const primary = list.find(c => c.is_primary && !c.disqualified) ?? null;
      onPrimaryContact?.(primary);
    } finally {
      setLoading(false);
    }
  }, [brandId, onPrimaryContact]);

  useEffect(() => { load(); }, [load]);

  async function discover() {
    setDiscovering(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/contacts/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_id: brandId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(`Discover failed: ${data.error ?? data.status ?? "unknown"}`);
      } else if (data.status === "no_match") {
        setMsg(`No Apollo match for domain ${data.domain_used ?? "(unknown)"}. Brand tagged "no_contact_path".`);
      } else {
        setMsg(`Found ${data.contacts_found} contacts (domain: ${data.domain_used}, ${data.domain_confidence}-confidence).`);
      }
      await load();
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDiscovering(false);
      setTimeout(() => setMsg(null), 6000);
    }
  }

  async function patch(id: string, payload: Record<string, unknown>) {
    const res = await fetch(`/api/contacts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setMsg(`Update failed: ${d.error ?? "unknown"}`);
      setTimeout(() => setMsg(null), 4000);
      return;
    }
    await load();
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Decision-makers</div>
        <button
          className="btn btn-ghost text-xs"
          onClick={discover}
          disabled={discovering}
        >
          {discovering ? "Searching…" : contacts.length === 0 ? "Find decision-makers" : "Re-run discovery"}
        </button>
      </div>

      {msg && <div className="text-xs mb-3 text-[var(--text-muted)]">{msg}</div>}

      {loading ? (
        <div className="text-sm text-[var(--text-muted)]">Loading…</div>
      ) : contacts.length === 0 ? (
        <div className="text-sm text-[var(--text-muted)]">
          No contacts yet. Click <span className="text-[var(--text)]">Find decision-makers</span> to run Apollo discovery.
        </div>
      ) : (
        <div className="overflow-x-auto -mx-4">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase text-[var(--text-muted)]">
              <tr>
                <th className="text-left px-4 py-2">Name</th>
                <th className="text-left px-4 py-2">Title</th>
                <th className="text-left px-4 py-2">Email</th>
                <th className="text-left px-4 py-2">Seniority</th>
                <th className="text-left px-4 py-2 w-20">Flags</th>
                <th className="text-right px-4 py-2 w-32">Actions</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map(c => (
                <tr
                  key={c.id}
                  className={`border-t border-[var(--border-soft)] ${c.disqualified ? "opacity-50" : ""}`}
                >
                  <td className="px-4 py-2">
                    <div className="font-medium">{c.full_name}</div>
                    {c.linkedin_url && (
                      <a
                        href={c.linkedin_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
                      >
                        LinkedIn ↗
                      </a>
                    )}
                  </td>
                  <td className="px-4 py-2 text-[var(--text-muted)]">{c.title ?? "—"}</td>
                  <td className="px-4 py-2">
                    {c.email ? (
                      <span className="font-mono text-xs">{c.email}</span>
                    ) : (
                      <span className="text-[11px] text-[var(--text-muted)] italic">Email hidden by Apollo</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-[11px] text-[var(--text-muted)]">{c.seniority ?? "—"}</td>
                  <td className="px-4 py-2">
                    {c.is_primary && (
                      <span title="Primary" className="text-[var(--accent)]">★</span>
                    )}
                    {c.disqualified && (
                      <span title="Disqualified" className="ml-1 line-through text-[#f87171]">DQ</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      {!c.is_primary && !c.disqualified && (
                        <button
                          className="btn btn-ghost text-[11px] px-2 py-1"
                          onClick={() => patch(c.id, { is_primary: true })}
                        >
                          Set primary
                        </button>
                      )}
                      <button
                        className="btn btn-ghost text-[11px] px-2 py-1"
                        onClick={() => patch(c.id, {
                          disqualified: !c.disqualified,
                          disqualified_reason: c.disqualified ? null : "manually disqualified",
                        })}
                      >
                        {c.disqualified ? "Restore" : "Disqualify"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="text-[11px] text-[var(--text-muted)] mt-3">
        See all contacts in <Link href="/app/contacts" className="underline hover:text-[var(--text)]">/app/contacts</Link>.
      </div>
    </div>
  );
}
