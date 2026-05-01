"use client";
import { useCallback, useEffect, useState } from "react";

type Tone = "direct" | "curious" | "educational";
const TONES: Tone[] = ["direct", "curious", "educational"];

interface Variant {
  tone: Tone;
  subject: string;
  body_text: string;
  body_html: string;
  model: string;
}

interface Thread {
  id: string;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  tone: string | null;
  status: string;
  copied_at: string | null;
  sent_at: string | null;
  created_at: string;
}

interface PrimaryContactSummary {
  id: string;
  full_name: string;
  first_name: string | null;
  title: string | null;
}

export default function BrandOutreachCard({
  brandId,
  primaryContact,
}: {
  brandId: string;
  primaryContact: PrimaryContactSummary | null;
}) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafting, setDrafting] = useState(false);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [activeTone, setActiveTone] = useState<Tone>("direct");
  const [signal, setSignal] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/outreach?brand_id=${brandId}`, { cache: "no-store" });
      const d = await r.json();
      setThreads(d.threads ?? []);
    } finally {
      setLoading(false);
    }
  }, [brandId]);

  useEffect(() => { load(); }, [load]);

  async function generateVariants() {
    if (!primaryContact) {
      setMsg("Set a primary contact first.");
      setTimeout(() => setMsg(null), 4000);
      return;
    }
    setDrafting(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/outreach/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_id: brandId, contact_id: primaryContact.id }),
      });
      const d = await r.json();
      if (!r.ok) {
        setMsg(`Draft failed: ${d.error ?? "unknown"}`);
      } else {
        setVariants(d.variants ?? []);
        setSignal(d.signal_used ?? null);
        setModel(d.model ?? null);
        setActiveTone((d.default_tone as Tone) ?? "direct");
      }
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDrafting(false);
    }
  }

  const active = variants.find(v => v.tone === activeTone) ?? null;

  async function saveActive() {
    if (!primaryContact || !active) return;
    const r = await fetch(`/api/outreach/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brand_id: brandId,
        contact_id: primaryContact.id,
        subject: active.subject,
        body_text: active.body_text,
        body_html: active.body_html,
        tone: active.tone,
        generation_model: active.model,
      }),
    });
    const d = await r.json();
    if (!r.ok) {
      setMsg(`Save failed: ${d.error ?? "unknown"}`);
    } else {
      setMsg("Saved as draft.");
      setVariants([]);
      await load();
    }
    setTimeout(() => setMsg(null), 4000);
  }

  async function copyAndMark(thread: Thread) {
    const text = thread.body_text ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setMsg("Copied — paste into Outlook.");
    } catch {
      setMsg("Could not access clipboard. Select and copy manually.");
    }
    if (thread.status === "draft") {
      await fetch(`/api/outreach/${thread.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "copied" }),
      });
      await load();
    }
    setTimeout(() => setMsg(null), 4000);
  }

  async function copyVariant(v: Variant) {
    try {
      await navigator.clipboard.writeText(v.body_text);
      setMsg("Copied. Save as draft if you want to track it.");
    } catch {
      setMsg("Could not access clipboard. Select and copy manually.");
    }
    setTimeout(() => setMsg(null), 4000);
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Outreach (copy-only)</div>
        <button
          className="btn text-xs"
          onClick={generateVariants}
          disabled={drafting || !primaryContact}
          title={!primaryContact ? "Set a primary contact first" : ""}
        >
          {drafting ? "Drafting…" : "Draft email"}
        </button>
      </div>

      {msg && <div className="text-xs mb-2 text-[var(--text-muted)]">{msg}</div>}

      {!primaryContact && (
        <div className="text-sm text-[var(--text-muted)] mb-3">
          Run contact discovery and pick a primary contact to draft from.
        </div>
      )}

      {variants.length > 0 && (
        <div className="border border-[var(--border)] rounded p-3 mb-4">
          <div className="flex items-center gap-2 mb-2">
            {TONES.map(t => (
              <button
                key={t}
                onClick={() => setActiveTone(t)}
                className="text-[11px] px-2 py-1 rounded"
                style={{
                  background: activeTone === t ? "var(--bg-3)" : "transparent",
                  color: activeTone === t ? "var(--text)" : "var(--text-muted)",
                  border: "1px solid var(--border)",
                }}
              >
                {t}
              </button>
            ))}
            <span className="text-[11px] text-[var(--text-muted)] ml-2">
              signal: {signal ?? "—"} • model: {model ?? "—"}
            </span>
          </div>
          {active && (
            <>
              <div className="text-xs text-[var(--text-muted)] mb-1">Subject</div>
              <div className="text-sm font-medium mb-2">{active.subject}</div>
              <div className="text-xs text-[var(--text-muted)] mb-1">Body</div>
              <pre className="text-xs whitespace-pre-wrap font-sans border border-[var(--border-soft)] rounded p-2 bg-[var(--bg-1)]">{active.body_text}</pre>
              <div className="flex gap-2 mt-2">
                <button className="btn text-xs" onClick={saveActive}>Save as draft</button>
                <button className="btn btn-ghost text-xs" onClick={() => copyVariant(active)}>Copy text</button>
                <button className="btn btn-ghost text-xs" onClick={generateVariants}>Regenerate</button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mb-2">Saved drafts</div>
      {loading ? (
        <div className="text-sm text-[var(--text-muted)]">Loading…</div>
      ) : threads.length === 0 ? (
        <div className="text-sm text-[var(--text-muted)]">No drafts yet.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {threads.map(t => (
            <div key={t.id} className="border border-[var(--border-soft)] rounded p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{t.subject ?? "(no subject)"}</div>
                  <div className="text-[11px] text-[var(--text-muted)] truncate">
                    {(t.body_text ?? "").split("\n")[0]?.slice(0, 100) || "—"}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{
                      background: t.status === "draft" ? "var(--bg-3)" : "rgba(34,197,94,0.15)",
                      color: t.status === "draft" ? "var(--text-muted)" : "#86efac",
                    }}
                  >
                    {t.status}
                    {t.tone ? ` · ${t.tone}` : ""}
                  </span>
                  <button className="btn text-[11px] px-2 py-1" onClick={() => copyAndMark(t)}>Copy</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="text-[11px] text-[var(--text-muted)] mt-3">
        Drafts are copy-only — paste into Outlook manually. No automated send.
      </div>
    </div>
  );
}
