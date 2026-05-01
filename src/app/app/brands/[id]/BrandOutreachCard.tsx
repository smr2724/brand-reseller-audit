"use client";
import { useCallback, useEffect, useState } from "react";

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
  outlook_message_id?: string | null;
  outlook_web_link?: string | null;
  drafted_in_outlook_at?: string | null;
}

interface PrimaryContactSummary {
  id: string;
  full_name: string;
  first_name: string | null;
  title: string | null;
}

interface OutlookStatus {
  connected: boolean;
  account_email: string | null;
  expires_at: string | null;
  auth_url: string;
}

interface SendResult {
  subject: string;
  web_link: string;
  contact_name: string | null;
  contact_email: string;
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
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [outlook, setOutlook] = useState<OutlookStatus | null>(null);
  const [lastSent, setLastSent] = useState<SendResult | null>(null);

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

  useEffect(() => {
    let alive = true;
    fetch("/api/outlook/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (alive) setOutlook(d as OutlookStatus); })
      .catch(() => { if (alive) setOutlook({ connected: false, account_email: null, expires_at: null, auth_url: "/api/auth/microsoft/start" }); });
    return () => { alive = false; };
  }, []);

  async function sendToOutlook() {
    if (!primaryContact) {
      setMsg("Set a primary contact for this brand first.");
      setTimeout(() => setMsg(null), 4000);
      return;
    }
    setSending(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/outreach/send-to-outlook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_id: brandId }),
      });
      const d = await r.json();
      if (!r.ok) {
        if (d?.error === "outlook_reauth_required") {
          setMsg("Outlook authorization expired — reconnect to continue.");
          setOutlook((s) => (s ? { ...s, connected: false } : s));
        } else if (d?.error === "no_primary_contact") {
          setMsg(d.message ?? "Set a primary contact first.");
        } else {
          setMsg(`Outlook draft failed: ${d?.error ?? "unknown"}`);
        }
      } else {
        setLastSent({
          subject: d.subject,
          web_link: d.web_link,
          contact_name: d.contact?.name ?? null,
          contact_email: d.contact?.email ?? "",
        });
        await load();
      }
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
      setTimeout(() => setMsg(null), 6000);
    }
  }

  const outlookConnected = !!outlook?.connected;
  const canSend = !!primaryContact && outlookConnected && !sending;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Outreach</div>
        <button
          className="btn text-xs"
          onClick={sendToOutlook}
          disabled={!canSend}
          title={
            !primaryContact
              ? "Set a primary contact first"
              : !outlookConnected
                ? "Connect Outlook first"
                : "Create the initial outreach draft in Outlook"
          }
        >
          {sending ? "Sending…" : "Send to Outlook"}
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

      {!primaryContact && (
        <div className="text-sm text-[var(--text-muted)] mb-3">
          Run contact discovery and pick a primary contact to draft from.
        </div>
      )}

      {msg && <div className="text-xs mb-2 text-[var(--text-muted)]">{msg}</div>}

      {lastSent && (
        <div className="border border-[var(--border)] rounded p-3 mb-3">
          <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mb-1">
            Draft created in Outlook
          </div>
          <div className="text-sm font-medium mb-1">{lastSent.subject}</div>
          <div className="text-[11px] text-[var(--text-muted)] mb-2">
            To: {lastSent.contact_name ? `${lastSent.contact_name} <${lastSent.contact_email}>` : lastSent.contact_email}
          </div>
          <a
            className="btn text-[11px] px-2 py-1"
            href={lastSent.web_link}
            target="_blank"
            rel="noreferrer"
          >
            Open in Outlook
          </a>
        </div>
      )}

      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mb-2">Drafts</div>
      {loading ? (
        <div className="text-sm text-[var(--text-muted)]">Loading…</div>
      ) : threads.length === 0 ? (
        <div className="text-sm text-[var(--text-muted)]">No drafts yet.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {threads.map(t => {
            const isInOutlook = t.status === "drafted_in_outlook" && !!t.outlook_web_link;
            return (
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
                        background:
                          t.status === "drafted_in_outlook"
                            ? "rgba(96,165,250,0.15)"
                            : t.status === "draft"
                              ? "var(--bg-3)"
                              : "rgba(34,197,94,0.15)",
                        color:
                          t.status === "drafted_in_outlook"
                            ? "#93c5fd"
                            : t.status === "draft"
                              ? "var(--text-muted)"
                              : "#86efac",
                      }}
                    >
                      {t.status}
                      {t.tone ? ` · ${t.tone}` : ""}
                    </span>
                    {isInOutlook && (
                      <a
                        className="btn text-[11px] px-2 py-1"
                        href={t.outlook_web_link ?? "#"}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open in Outlook
                      </a>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="text-[11px] text-[var(--text-muted)] mt-3">
        Drafts land in your Outlook drafts folder — review and send from there.
      </div>
    </div>
  );
}
