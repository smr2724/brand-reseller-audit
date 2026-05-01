"use client";

import { useMemo, useState } from "react";
import {
  Search,
  Sparkles,
  Mail,
  ExternalLink,
  Link as LinkIcon,
  Loader2,
  FileText,
  Copy,
  Check,
} from "lucide-react";

interface Contact {
  id: string;
  full_name: string;
  title?: string;
  email?: string;
  email_status?: string;
  linkedin_url?: string;
  ai_priority_rank?: number;
  ai_priority_reason?: string;
  enriched_at?: string;
}

interface Candidate {
  id: string;
  name: string;
  title?: string;
  seniority?: string;
  linkedin_url?: string;
  city?: string;
  state?: string;
}

interface Thread {
  id: string;
  contact_id: string;
  opportunity_id?: string | null;
  step?: number | null;
  status?: string;
  subject?: string;
  outlook_web_link?: string;
  sent_at?: string | null;
  created_at?: string;
}

interface OpportunityOption {
  opportunity_id: string;
  keyword: string;
  legion_score?: number | null;
  supplier_score?: number | null;
}

interface ReportRow {
  id: string;
  token: string;
  opportunity_id: string;
  created_at: string;
  views: number;
}

const STEP_LABELS: Record<number, { name: string; tone: "primary" | "neutral" }> = {
  1: { name: "Initial", tone: "primary" },
  2: { name: "Follow-up 1", tone: "neutral" },
  3: { name: "Right person?", tone: "neutral" },
  4: { name: "Breakup", tone: "neutral" },
  5: { name: "Send report", tone: "primary" },
};

export default function ContactsSection({
  supplierId,
  supplierName,
  initialContacts,
  initialThreads,
  opportunityOptions,
  initialReports,
}: {
  supplierId: string;
  supplierName?: string;
  initialContacts: Contact[];
  initialThreads: Thread[];
  opportunityOptions: OpportunityOption[];
  initialReports: ReportRow[];
}) {
  const [contacts, setContacts] = useState<Contact[]>(initialContacts);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [candidateTotal, setCandidateTotal] = useState<number | null>(null);
  const [threads, setThreads] = useState<Thread[]>(initialThreads ?? []);
  const [reports, setReports] = useState<ReportRow[]>(initialReports ?? []);
  const [busy, setBusy] = useState<string | null>(null); // e.g. "find" or `step:${contactId}:${step}`
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Default the opportunity dropdown to the highest-supplier-score option.
  const [selectedOppId, setSelectedOppId] = useState<string>(
    opportunityOptions[0]?.opportunity_id ?? ""
  );

  const selectedOpp = useMemo(
    () => opportunityOptions.find((o) => o.opportunity_id === selectedOppId),
    [selectedOppId, opportunityOptions]
  );

  // Existing report for the currently selected opportunity (if any).
  const reportForSelected = useMemo(
    () => reports.find((r) => r.opportunity_id === selectedOppId) ?? null,
    [reports, selectedOppId]
  );

  // Steps already drafted/sent per contact for the SELECTED opportunity.
  const stepsByContact = useMemo(() => {
    const map: Record<string, Set<number>> = {};
    for (const t of threads) {
      if (!t.step) continue;
      if (selectedOppId && t.opportunity_id !== selectedOppId) continue;
      if (!map[t.contact_id]) map[t.contact_id] = new Set();
      map[t.contact_id].add(t.step);
    }
    return map;
  }, [threads, selectedOppId]);

  function threadFor(contactId: string, step: number): Thread | undefined {
    return threads.find(
      (t) =>
        t.contact_id === contactId &&
        t.step === step &&
        (selectedOppId ? t.opportunity_id === selectedOppId : true)
    );
  }

  async function find() {
    setBusy("find");
    setError(null);
    try {
      const r = await fetch("/api/contacts/find", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplier_id: supplierId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed");
      setCandidates(d.candidates);
      setCandidateTotal(d.total);
    } catch (e: any) {
      setError(String(e.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function enrich() {
    if (!confirm("Enrich the top 3 contacts with Apollo? This consumes Apollo credits.")) return;
    setBusy("enrich");
    setError(null);
    try {
      const r = await fetch("/api/contacts/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplier_id: supplierId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed");
      setContacts(d.contacts);
      setCandidates(null);
    } catch (e: any) {
      setError(String(e.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function generateReport() {
    if (!selectedOppId) {
      setError("Pick an opportunity first.");
      return;
    }
    setBusy("report");
    setError(null);
    try {
      const r = await fetch("/api/reports/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplier_id: supplierId, opportunity_id: selectedOppId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed");
      // Add or refresh the report locally
      setReports((prev) => {
        const without = prev.filter((p) => p.opportunity_id !== selectedOppId);
        return [
          { id: d.token, token: d.token, opportunity_id: selectedOppId, created_at: new Date().toISOString(), views: 0 },
          ...without,
        ];
      });
      // Auto-copy URL
      try {
        await navigator.clipboard.writeText(d.url);
        setCopied(`report:${selectedOppId}`);
        setTimeout(() => setCopied(null), 2000);
      } catch {}
    } catch (e: any) {
      setError(String(e.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function sendStep(contactId: string, step: number) {
    if (!selectedOpp) {
      setError("Pick an opportunity first.");
      return;
    }
    if (step === 5 && !reportForSelected) {
      setError('Generate the report first — step 5 needs the public report URL.');
      return;
    }

    const stepName = STEP_LABELS[step].name;
    if (!confirm(`Create Outlook draft for "${stepName}"? The draft lands in your Outlook Drafts folder for review.`)) return;

    const key = `step:${contactId}:${step}`;
    setBusy(key);
    setError(null);

    const baseUrl =
      typeof window !== "undefined" ? window.location.origin : "";
    const reportUrl = reportForSelected
      ? `${baseUrl}/r/${reportForSelected.token}`
      : undefined;

    try {
      const r = await fetch("/api/outreach/send-step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: contactId,
          step,
          product_category: selectedOpp.keyword,
          opportunity_id: selectedOppId,
          report_url: reportUrl,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed");
      // Add the new thread row to local state
      if (d.thread) {
        setThreads((prev) => [d.thread, ...prev]);
      }
      // Open the Outlook web draft. No mailto fallback — the API will have
      // already returned an error if the draft couldn't be created.
      if (d.web_link) {
        window.open(d.web_link, "_blank");
      }
    } catch (e: any) {
      setError(String(e.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function copyText(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch {}
  }

  const reportUrl = reportForSelected
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/r/${reportForSelected.token}`
    : null;

  return (
    <div className="card p-4 md:p-5 mb-4">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Contacts &amp; Outreach</h2>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Find people at this supplier, enrich the top 3, then run the 5-step email sequence — one
            click per step.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button className="btn" onClick={find} disabled={busy !== null}>
            {busy === "find" ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            Find contacts
          </button>
          <button className="btn btn-primary" onClick={enrich} disabled={busy !== null}>
            {busy === "enrich" ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            Enrich top 3
          </button>
        </div>
      </div>

      {error && (
        <div className="text-xs px-3 py-2 mb-3 rounded border border-[var(--red)] text-[var(--red)] bg-[rgba(255,80,80,0.05)]">
          {error}
        </div>
      )}

      {/* Opportunity picker + Report controls */}
      {contacts.length > 0 && (
        <div className="rounded border border-[var(--border)] p-3 mb-4 bg-[rgba(255,255,255,0.02)]">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[220px]">
              <label className="block text-[11px] uppercase tracking-wide text-[var(--text-muted)] mb-1">
                Sequence is about
              </label>
              {opportunityOptions.length > 0 ? (
                <select
                  value={selectedOppId}
                  onChange={(e) => setSelectedOppId(e.target.value)}
                  className="w-full text-sm px-3 py-2 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--text)]"
                >
                  {opportunityOptions.map((o) => (
                    <option key={o.opportunity_id} value={o.opportunity_id}>
                      {o.keyword}
                      {o.supplier_score != null ? ` · fit ${o.supplier_score}` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="text-xs text-[var(--text-muted)] py-2">
                  No matched opportunities yet — link this supplier to an opportunity from the
                  Suppliers page first.
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1 min-w-[260px]">
              <label className="block text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                Public report
              </label>
              {reportForSelected && reportUrl ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <a
                    href={reportUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-[var(--gold)] hover:underline truncate max-w-[260px]"
                  >
                    {reportUrl.replace(/^https?:\/\//, "")}
                  </a>
                  <button
                    className="btn btn-ghost text-xs"
                    onClick={() => copyText(reportUrl, `report:${selectedOppId}`)}
                  >
                    {copied === `report:${selectedOppId}` ? <Check size={12} /> : <Copy size={12} />}
                    {copied === `report:${selectedOppId}` ? "Copied" : "Copy"}
                  </button>
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {reportForSelected.views} view{reportForSelected.views === 1 ? "" : "s"}
                  </span>
                </div>
              ) : (
                <button
                  className="btn"
                  onClick={generateReport}
                  disabled={busy !== null || !selectedOppId}
                >
                  {busy === "report" ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <FileText size={14} />
                  )}
                  Generate report
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Saved contacts (top-3 enriched) — each gets a 5-step stepper */}
      {contacts.length > 0 && (
        <div className="mb-4">
          <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mb-2">
            Top contacts ({contacts.length})
          </div>
          <div className="space-y-3">
            {contacts.map((c) => {
              const sent = stepsByContact[c.id] ?? new Set<number>();
              return (
                <div
                  key={c.id}
                  className="rounded border border-[var(--border)] p-3 bg-[rgba(255,255,255,0.01)]"
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="font-medium text-sm">{c.full_name}</div>
                        {c.ai_priority_rank ? (
                          <span className="pill pill-deep" style={{ fontSize: 10 }}>
                            #{c.ai_priority_rank}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">{c.title ?? "—"}</div>
                      {c.email && (
                        <div className="text-xs mt-1">
                          <a href={`mailto:${c.email}`} className="hover:underline break-all">
                            {c.email}
                          </a>
                          {c.email_status && (
                            <span className="ml-2 text-[var(--text-muted)]">· {c.email_status}</span>
                          )}
                        </div>
                      )}
                      {c.ai_priority_reason && (
                        <div className="text-[11px] text-[var(--text-muted)] mt-1.5 italic leading-snug">
                          “{c.ai_priority_reason}”
                        </div>
                      )}
                      {c.linkedin_url && (
                        <a
                          href={c.linkedin_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:underline mt-1.5"
                        >
                          <LinkIcon size={12} /> LinkedIn
                        </a>
                      )}
                    </div>
                  </div>

                  {/* 5-step button row */}
                  <div className="mt-3 pt-3 border-t border-[var(--border-soft)]">
                    <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mb-2">
                      Sequence
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {[1, 2, 3, 4, 5].map((step) => {
                        const isSent = sent.has(step);
                        const t = threadFor(c.id, step);
                        const key = `step:${c.id}:${step}`;
                        const isBusy = busy === key;
                        const previousSent = step === 1 || sent.has(step - 1);
                        const disabled =
                          busy !== null ||
                          !c.email ||
                          !selectedOppId ||
                          (step === 5 && !reportForSelected) ||
                          // Allow re-creating a draft if the previous wasn't sent yet, but soft-warn via UI
                          false;
                        const meta = STEP_LABELS[step];
                        return (
                          <div key={step} className="flex flex-col items-start">
                            <button
                              onClick={() => sendStep(c.id, step)}
                              disabled={disabled}
                              className={`btn ${
                                meta.tone === "primary" && !isSent ? "btn-primary" : ""
                              } ${isSent ? "opacity-70" : ""}`}
                              style={{ minWidth: 0 }}
                              title={
                                step === 5 && !reportForSelected
                                  ? "Generate the report first to enable this step."
                                  : !previousSent
                                  ? `Tip: usually you'd send step ${step - 1} first.`
                                  : undefined
                              }
                            >
                              {isBusy ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : isSent ? (
                                <Check size={12} />
                              ) : (
                                <Mail size={12} />
                              )}
                              <span className="text-xs">
                                <span className="text-[var(--text-muted)] mr-1">{step}.</span>
                                {meta.name}
                              </span>
                            </button>
                            {t?.outlook_web_link && (
                              <a
                                href={t.outlook_web_link}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[10px] text-[var(--gold)] hover:underline mt-1 inline-flex items-center gap-1"
                              >
                                <ExternalLink size={10} /> Open draft
                              </a>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Candidate preview (after Find) */}
      {candidates && (
        <div className="mb-2">
          <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mb-2">
            Apollo found {candidateTotal ?? candidates.length} people · showing first {candidates.length}
          </div>
          <div className="rounded border border-[var(--border)] overflow-hidden">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Title</th>
                  <th>Seniority</th>
                  <th>Location</th>
                </tr>
              </thead>
              <tbody>
                {candidates.slice(0, 15).map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.linkedin_url ? (
                        <a href={c.linkedin_url} target="_blank" rel="noreferrer" className="hover:underline">
                          {c.name || "—"}
                        </a>
                      ) : (
                        c.name || "—"
                      )}
                    </td>
                    <td className="text-xs">{c.title ?? "—"}</td>
                    <td className="text-xs text-[var(--text-muted)]">{c.seniority ?? "—"}</td>
                    <td className="text-xs text-[var(--text-muted)]">
                      {[c.city, c.state].filter(Boolean).join(", ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-[var(--text-muted)] mt-2">
            Click <strong>Enrich top 3</strong> to let AI pick the best three and unlock their emails.
          </p>
        </div>
      )}

      {!contacts.length && !candidates && !busy && (
        <div className="text-sm text-[var(--text-muted)] text-center py-6">
          No contacts yet. Click <strong className="text-[var(--text)]">Find contacts</strong> to
          search Apollo for people at {supplierName ?? "this company"}.
        </div>
      )}
    </div>
  );
}
