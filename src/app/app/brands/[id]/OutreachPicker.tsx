"use client";
/**
 * Phase 70 — Outreach picker.
 *
 * Lists MillionVerifier-confirmed `brand_contacts` for the current brand
 * with checkboxes (primary pre-checked). Single "Send to Outlook" button
 * sequentially POSTs to /api/outreach/send-to-outlook once per checked
 * contact — each call creates ONE Microsoft Graph draft. Per-contact
 * success/failure lines stream into the DRAFTS history below.
 *
 * The email template is FIXED server-side (Steve's verbatim copy). The
 * client never supplies subject or body.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

interface VerifiedContact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  title: string | null;
  company_domain: string | null;
  email: string | null;
  email_status: string | null;
  email_verifier: string | null;
  email_verifier_score: number | null;
  is_primary: boolean | null;
  enrichment_state: string | null;
  created_at: string;
}

interface DraftEvent {
  id: string;
  contact_id: string | null;
  email_returned: string | null;
  raw_payload: unknown;
  created_at: string;
}

interface OutlookStatus {
  connected: boolean;
  account_email: string | null;
  expires_at: string | null;
  auth_url: string;
}

interface SessionResultLine {
  key: string;
  kind: "success" | "error";
  contactName: string;
  message: string;
  ts: string;
}

function fmtPT(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function nameFor(c: { first_name: string | null; last_name: string | null; full_name: string | null }): string {
  const first = c.first_name?.trim() ?? "";
  const last = c.last_name?.trim() ?? "";
  const composed = `${first} ${last}`.trim();
  if (composed) return composed;
  return c.full_name?.trim() ?? "(unnamed)";
}

export default function OutreachPicker({ brandId }: { brandId: string }) {
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [contacts, setContacts] = useState<VerifiedContact[]>([]);
  const [drafts, setDrafts] = useState<DraftEvent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [outlook, setOutlook] = useState<OutlookStatus | null>(null);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [sessionLines, setSessionLines] = useState<SessionResultLine[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    try {
      const r = await fetch(`/api/brands/${brandId}/contacts/verified`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) {
        setLoadErr(d?.error ?? `HTTP ${r.status}`);
        setContacts([]);
        setDrafts([]);
        return;
      }
      const list = (d.contacts ?? []) as VerifiedContact[];
      setContacts(list);
      setDrafts((d.drafts ?? []) as DraftEvent[]);
      // Pre-check the primary contact.
      const next = new Set<string>();
      const primary = list.find((c) => c.is_primary);
      if (primary) next.add(primary.id);
      setSelected(next);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [brandId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let alive = true;
    fetch("/api/outlook/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (alive) setOutlook(d as OutlookStatus); })
      .catch(() => {
        if (alive) setOutlook({
          connected: false,
          account_email: null,
          expires_at: null,
          auth_url: "/api/auth/microsoft/start",
        });
      });
    return () => { alive = false; };
  }, []);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectedCount = selected.size;
  const outlookConnected = !!outlook?.connected;
  const canSend = selectedCount > 0 && outlookConnected && !sending && !loading;

  async function sendOne(contact: VerifiedContact): Promise<SessionResultLine> {
    const key = `${contact.id}-${Date.now()}`;
    const ts = new Date().toISOString();
    const display = nameFor(contact);
    try {
      const r = await fetch("/api/outreach/send-to-outlook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: contact.id, brandId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (d?.error === "outlook_reauth_required") {
          setOutlook((s) => (s ? { ...s, connected: false } : s));
          return {
            key,
            kind: "error",
            contactName: display,
            message: "Outlook authorization expired — reconnect to continue.",
            ts,
          };
        }
        return {
          key,
          kind: "error",
          contactName: display,
          message: d?.message ?? d?.error ?? `HTTP ${r.status}`,
          ts,
        };
      }
      return {
        key,
        kind: "success",
        contactName: display,
        message: `Sent to Outlook drafts (${fmtPT(ts)} PT)`,
        ts,
      };
    } catch (e) {
      return {
        key,
        kind: "error",
        contactName: display,
        message: e instanceof Error ? e.message : String(e),
        ts,
      };
    }
  }

  async function onSend() {
    if (!canSend) return;
    const chosen = contacts.filter((c) => selected.has(c.id));
    if (chosen.length === 0) return;
    setSending(true);
    setSessionLines([]);
    setProgress({ done: 0, total: chosen.length });
    let i = 0;
    for (const c of chosen) {
      i += 1;
      setProgress({ done: i - 1, total: chosen.length });
      const line = await sendOne(c);
      setSessionLines((prev) => [...prev, line]);
      setProgress({ done: i, total: chosen.length });
    }
    setSending(false);
    setProgress(null);
    // Refresh server-persisted drafts so the history list catches up.
    load().catch(() => {});
  }

  const empty = !loading && contacts.length === 0 && !loadErr;

  const persistedDraftLines = useMemo(() => {
    return drafts.map((ev) => {
      const cid = ev.contact_id;
      const c = cid ? contacts.find((x) => x.id === cid) : null;
      const name = c ? nameFor(c) : ev.email_returned ?? "(unknown contact)";
      return {
        id: ev.id,
        name,
        ts: ev.created_at,
      };
    });
  }, [drafts, contacts]);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Outreach</div>
        <button
          className="btn text-xs"
          onClick={onSend}
          disabled={!canSend}
          title={
            !outlookConnected
              ? "Connect Outlook first"
              : selectedCount === 0
                ? "Pick at least one contact"
                : "Create one Outlook draft per selected contact"
          }
        >
          {sending && progress
            ? `Sending… (${progress.done} of ${progress.total})`
            : "Send to Outlook"}
        </button>
      </div>

      {!outlookConnected && (
        <div className="mb-3 text-xs p-2 rounded border border-[var(--border-soft)] bg-[var(--bg-2)]">
          Outlook isn&apos;t connected — drafts can&apos;t be created.{" "}
          <a className="underline text-[var(--accent)]" href={outlook?.auth_url ?? "/api/auth/microsoft/start"}>
            Connect Outlook
          </a>
        </div>
      )}

      {loadErr && (
        <div className="mb-3 text-xs p-2 rounded border border-[#4a1e21] bg-[#2a1415] text-[#f87171]">
          {loadErr}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-[var(--text-muted)]">Loading…</div>
      ) : empty ? (
        <div className="text-sm text-[var(--text-muted)] p-3 rounded border border-[var(--border-soft)] bg-[var(--bg-2)]">
          <div className="font-medium text-[var(--text)] mb-1">No verified contacts yet.</div>
          Run Contact Strategy + enrichment above to get verified emails for this brand.
        </div>
      ) : (
        <>
          <div className="text-xs text-[var(--text-muted)] mb-3">
            Pick which verified contacts to draft to. Each one becomes a separate draft in your Outlook drafts folder.
          </div>
          <div className="flex flex-col gap-2 mb-4">
            {contacts.map((c) => {
              const checked = selected.has(c.id);
              const name = nameFor(c);
              const title = c.title ?? "";
              const company = c.company_domain ?? "";
              const titleLine = [title, company].filter(Boolean).join(", ");
              return (
                <label
                  key={c.id}
                  className="flex items-start gap-3 p-2 rounded border border-[var(--border-soft)] bg-[var(--bg-2)] hover:bg-[var(--bg-3)] cursor-pointer"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={checked}
                    onChange={() => toggle(c.id)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">
                      {name}
                      {titleLine && (
                        <span className="font-normal text-[var(--text-muted)]"> — {titleLine}</span>
                      )}
                    </div>
                    <div className="text-[11px] text-[var(--text-muted)] truncate">
                      <span className="font-mono">{c.email ?? "—"}</span>
                      {c.is_primary && (
                        <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-[rgba(96,165,250,0.15)] text-[#93c5fd] border border-[rgba(96,165,250,0.25)]">
                          primary
                        </span>
                      )}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </>
      )}

      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mb-2">Drafts</div>
      {sessionLines.length === 0 && persistedDraftLines.length === 0 ? (
        <div className="text-sm text-[var(--text-muted)]">No drafts yet.</div>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {sessionLines.map((l) => (
            <li
              key={l.key}
              className={l.kind === "error" ? "text-[#f87171]" : "text-[var(--text)]"}
            >
              {l.kind === "success"
                ? `• Sent to Outlook drafts: ${l.contactName} (${fmtPT(l.ts)} PT)`
                : `• Failed: ${l.contactName} — ${l.message}`}
            </li>
          ))}
          {persistedDraftLines.map((l) => (
            <li key={l.id} className="text-[var(--text-muted)]">
              • Sent to Outlook drafts: {l.name} ({fmtPT(l.ts)} PT)
            </li>
          ))}
        </ul>
      )}

      <div className="text-[11px] text-[var(--text-muted)] mt-3">
        Drafts land in your Outlook drafts folder — review and send from there.
      </div>
    </div>
  );
}
