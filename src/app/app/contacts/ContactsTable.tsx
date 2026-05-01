"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

interface Contact {
  id: string;
  brand_id: string | null;
  full_name: string;
  title: string | null;
  email: string | null;
  email_status: string | null;
  linkedin_url: string | null;
  seniority: string | null;
  department: string | null;
  is_primary: boolean;
  disqualified: boolean;
  source: string;
  created_at: string;
}

interface Brand {
  id: string;
  name: string;
}

const SENIORITIES = ["", "c_suite", "vp", "head", "director", "manager", "owner", "founder", "partner"];

export default function ContactsTable() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [brandId, setBrandId] = useState("");
  const [seniority, setSeniority] = useState("");
  const [includeDQ, setIncludeDQ] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (brandId) params.set("brand_id", brandId);
      if (seniority) params.set("seniority", seniority);
      if (includeDQ) params.set("include_disqualified", "1");
      const r = await fetch(`/api/contacts?${params.toString()}`, { cache: "no-store" });
      const d = await r.json();
      setContacts(d.contacts ?? []);
    } finally {
      setLoading(false);
    }
  }, [brandId, seniority, includeDQ]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetch("/api/brands?limit=500", { cache: "no-store" })
      .then(r => r.ok ? r.json() : { brands: [] })
      .then(d => setBrands(d.brands ?? []))
      .catch(() => {});
  }, []);

  const brandsById = useMemo(() => {
    const m = new Map<string, string>();
    brands.forEach(b => m.set(b.id, b.name));
    return m;
  }, [brands]);

  const filtered = useMemo(() => {
    if (!search.trim()) return contacts;
    const q = search.toLowerCase();
    return contacts.filter(c =>
      c.full_name.toLowerCase().includes(q) ||
      (c.title ?? "").toLowerCase().includes(q) ||
      (c.email ?? "").toLowerCase().includes(q)
    );
  }, [contacts, search]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)] gap-4">
      <aside className="card p-4 h-fit">
        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-3">Filters</div>
        <div className="flex flex-col gap-2">
          <label className="text-[11px] text-[var(--text-muted)]">Search
            <input className="input mt-1" value={search} onChange={e => setSearch(e.target.value)} placeholder="name / title / email…" />
          </label>
          <label className="text-[11px] text-[var(--text-muted)]">Brand
            <select className="select mt-1" value={brandId} onChange={e => setBrandId(e.target.value)}>
              <option value="">all brands</option>
              {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-[var(--text-muted)]">Seniority
            <select className="select mt-1" value={seniority} onChange={e => setSeniority(e.target.value)}>
              {SENIORITIES.map(s => <option key={s} value={s}>{s || "any"}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-[var(--text-muted)] flex items-center gap-2 mt-1">
            <input type="checkbox" checked={includeDQ} onChange={e => setIncludeDQ(e.target.checked)} />
            Include disqualified
          </label>
        </div>
      </aside>

      <section>
        <div className="card overflow-hidden">
          {loading ? (
            <div className="p-4 text-sm text-[var(--text-muted)]">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-sm text-[var(--text-muted)]">No contacts.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase text-[var(--text-muted)] border-b border-[var(--border-soft)]">
                <tr>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Title</th>
                  <th className="text-left px-3 py-2">Brand</th>
                  <th className="text-left px-3 py-2">Email</th>
                  <th className="text-left px-3 py-2 w-24">Seniority</th>
                  <th className="text-left px-3 py-2 w-16"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => (
                  <tr
                    key={c.id}
                    className={`border-t border-[var(--border-soft)] hover:bg-[var(--bg-2)] ${c.disqualified ? "opacity-50" : ""}`}
                  >
                    <td className="px-3 py-2">
                      <div className="font-medium">
                        {c.is_primary && <span className="text-[var(--accent)] mr-1">★</span>}
                        {c.full_name}
                      </div>
                      {c.linkedin_url && (
                        <a href={c.linkedin_url} target="_blank" rel="noreferrer" className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]">LinkedIn ↗</a>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[var(--text-muted)]">{c.title ?? "—"}</td>
                    <td className="px-3 py-2">
                      {c.brand_id ? (
                        <Link href={`/app/brands/${c.brand_id}`} className="hover:underline">
                          {brandsById.get(c.brand_id) ?? "(brand)"}
                        </Link>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {c.email ? (
                        <span className="font-mono text-xs">{c.email}</span>
                      ) : (
                        <span className="text-[11px] text-[var(--text-muted)] italic">hidden</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-[var(--text-muted)]">{c.seniority ?? "—"}</td>
                    <td className="px-3 py-2">
                      {c.disqualified && <span className="text-[#f87171] text-[11px]">DQ</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
