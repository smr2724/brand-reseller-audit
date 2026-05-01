"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

interface Thread {
  id: string;
  brand_id: string | null;
  contact_id: string | null;
  subject: string | null;
  body_text: string | null;
  body: string | null;
  tone: string | null;
  status: string;
  copied_at: string | null;
  sent_at: string | null;
  created_at: string;
  brands?: { id: string; name: string } | null;
  contacts?: { id: string; full_name: string; email: string | null; title: string | null } | null;
}

const STATUSES = ["", "draft", "copied", "sent", "replied", "bounced"];
const TONES = ["", "direct", "curious", "educational"];

export default function OutreachQueue() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<Thread | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (tone) params.set("tone", tone);
      const r = await fetch(`/api/outreach?${params.toString()}`, { cache: "no-store" });
      const d = await r.json();
      setThreads(d.threads ?? []);
    } finally {
      setLoading(false);
    }
  }, [status, tone]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!search.trim()) return threads;
    const q = search.toLowerCase();
    return threads.filter(t =>
      (t.subject ?? "").toLowerCase().includes(q) ||
      (t.brands?.name ?? "").toLowerCase().includes(q) ||
      (t.contacts?.full_name ?? "").toLowerCase().includes(q)
    );
  }, [threads, search]);

  function toggle(id: string) {
    setSelected(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copySelected() {
    const picked = filtered.filter(t => selected.has(t.id));
    if (picked.length === 0) {
      setMsg("Nothing selected.");
      setTimeout(() => setMsg(null), 3000);
      return;
    }
    const block = picked
      .map(t => `Subject: ${t.subject ?? ""}\nTo: ${t.contacts?.email ?? "(no email)"} (${t.contacts?.full_name ?? ""}, ${t.brands?.name ?? ""})\n\n${t.body_text ?? t.body ?? ""}`)
      .join("\n\n---\n\n");
    try {
      await navigator.clipboard.writeText(block);
      setMsg(`Copied ${picked.length} draft${picked.length === 1 ? "" : "s"} as a single block.`);
    } catch {
      setMsg("Could not access clipboard.");
    }
    // Mark them all copied
    await Promise.all(
      picked
        .filter(t => t.status === "draft")
        .map(t => fetch(`/api/outreach/${t.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "copied" }),
        }))
    );
    setSelected(new Set());
    await load();
    setTimeout(() => setMsg(null), 4000);
  }

  async function copyOne(t: Thread) {
    try {
      await navigator.clipboard.writeText(t.body_text ?? t.body ?? "");
      setMsg("Copied — paste into Outlook.");
    } catch {
      setMsg("Could not access clipboard.");
    }
    if (t.status === "draft") {
      await fetch(`/api/outreach/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "copied" }),
      });
      await load();
    }
    setTimeout(() => setMsg(null), 3000);
  }

  async function markSent(t: Thread) {
    await fetch(`/api/outreach/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "sent" }),
    });
    await load();
    setActive(null);
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)] gap-4">
      <aside className="card p-4 h-fit">
        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-3">Filters</div>
        <div className="flex flex-col gap-2">
          <label className="text-[11px] text-[var(--text-muted)]">Search
            <input className="input mt-1" value={search} onChange={e => setSearch(e.target.value)} placeholder="brand, contact, subject…" />
          </label>
          <label className="text-[11px] text-[var(--text-muted)]">Status
            <select className="select mt-1" value={status} onChange={e => setStatus(e.target.value)}>
              {STATUSES.map(s => <option key={s} value={s}>{s || "any"}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-[var(--text-muted)]">Tone
            <select className="select mt-1" value={tone} onChange={e => setTone(e.target.value)}>
              {TONES.map(t => <option key={t} value={t}>{t || "any"}</option>)}
            </select>
          </label>
        </div>
        <div className="border-t border-[var(--border-soft)] mt-4 pt-3">
          <div className="text-xs text-[var(--text-muted)] mb-2">{selected.size} selected</div>
          <button className="btn w-full text-xs" onClick={copySelected} disabled={selected.size === 0}>
            Copy selected as single block
          </button>
        </div>
      </aside>

      <section>
        {msg && <div className="card-soft p-2 text-sm mb-3">{msg}</div>}
        <div className="card overflow-hidden">
          {loading ? (
            <div className="p-4 text-sm text-[var(--text-muted)]">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-sm text-[var(--text-muted)]">No drafts.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase text-[var(--text-muted)] border-b border-[var(--border-soft)]">
                <tr>
                  <th className="w-10 px-3 py-2"></th>
                  <th className="text-left px-3 py-2">Brand</th>
                  <th className="text-left px-3 py-2">Contact</th>
                  <th className="text-left px-3 py-2">Subject</th>
                  <th className="text-left px-3 py-2 w-28">Status</th>
                  <th className="text-left px-3 py-2 w-32">Updated</th>
                  <th className="text-right px-3 py-2 w-32"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(t => (
                  <tr key={t.id} className="border-t border-[var(--border-soft)] hover:bg-[var(--bg-2)]">
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                    </td>
                    <td className="px-3 py-2">
                      {t.brands ? (
                        <Link href={`/app/brands/${t.brands.id}`} className="hover:underline">{t.brands.name}</Link>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2 text-[var(--text-muted)]">
                      {t.contacts?.full_name ?? "—"}
                      {t.contacts?.title && <span className="text-[11px]"> · {t.contacts.title}</span>}
                    </td>
                    <td className="px-3 py-2 truncate max-w-[280px]">{t.subject ?? "(no subject)"}</td>
                    <td className="px-3 py-2 text-[11px] text-[var(--text-muted)]">
                      {t.status}{t.tone ? ` · ${t.tone}` : ""}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-[var(--text-muted)]">
                      {(t.copied_at ?? t.sent_at ?? t.created_at)?.slice(0, 10)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <button className="btn btn-ghost text-[11px] px-2 py-1" onClick={() => setActive(t)}>Open</button>
                        <button className="btn text-[11px] px-2 py-1" onClick={() => copyOne(t)}>Copy</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {active && (
        <DetailModal
          thread={active}
          onClose={() => setActive(null)}
          onCopy={() => copyOne(active)}
          onMarkSent={() => markSent(active)}
        />
      )}
    </div>
  );
}

function DetailModal({
  thread,
  onClose,
  onCopy,
  onMarkSent,
}: {
  thread: Thread;
  onClose: () => void;
  onCopy: () => void;
  onMarkSent: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="card max-w-2xl w-full p-5 max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Draft preview</div>
          <button className="btn btn-ghost text-xs" onClick={onClose}>Close</button>
        </div>
        <div className="text-[11px] text-[var(--text-muted)] mb-1">To</div>
        <div className="text-sm mb-3">
          {thread.contacts?.full_name ?? "—"}
          {thread.contacts?.email && <span className="font-mono text-xs ml-2">&lt;{thread.contacts.email}&gt;</span>}
        </div>
        <div className="text-[11px] text-[var(--text-muted)] mb-1">Subject</div>
        <div className="text-sm font-medium mb-3">{thread.subject ?? "(no subject)"}</div>
        <div className="text-[11px] text-[var(--text-muted)] mb-1">Body</div>
        <pre className="text-xs whitespace-pre-wrap font-sans border border-[var(--border-soft)] rounded p-2 bg-[var(--bg-1)] mb-3">{thread.body_text ?? thread.body ?? ""}</pre>
        <div className="flex gap-2 justify-end">
          <button className="btn btn-ghost text-xs" onClick={onMarkSent}>Mark sent</button>
          <button className="btn text-xs" onClick={onCopy}>Copy</button>
        </div>
      </div>
    </div>
  );
}
