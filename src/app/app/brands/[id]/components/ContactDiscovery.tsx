"use client";
/**
 * Phase 47 — Section B on /app/brands/[id]: Contact Discovery.
 *
 * Decision-makers table + clipboard tooling. This is an internal admin
 * view — it does NOT send any emails. The actual report-send code path
 * (lib/email/resend.ts STEVE_CC) is unaffected.
 *
 * Phase 52: dropped the radio-based primary selector and the "send to"
 * footer; replaced with multi-select checkboxes + Copy buttons that
 * write a TSV-formatted block to the clipboard for clean Excel/Sheets
 * paste.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Contact {
  id: string;
  full_name: string;
  title: string | null;
  linkedin_url: string | null;
  company_domain: string | null;
  email: string | null;
  email_status: string | null;
  email_source: string | null;
  email_verifier_score: number | null;
  phone: string | null;
  phone_status: string | null;
  is_primary: boolean;
  ready_to_send: boolean;
}

interface DiscoverResp {
  state: string;
  contacts: Contact[];
  domain_pattern: string | null;
  is_catch_all: boolean | null;
}

export default function ContactDiscovery({
  brandId,
  initialContactsState,
}: {
  brandId: string;
  initialContactsState: string;
}) {
  const router = useRouter();
  const [contactsState, setContactsState] = useState(initialContactsState);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [pattern, setPattern] = useState<string | null>(null);
  const [catchAll, setCatchAll] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch(`/api/brands/${brandId}/contacts/discover`, {
        method: "GET",
      });
      if (res.status === 405 || !res.ok) {
        // GET not implemented — pull straight from the contacts list.
        const r2 = await fetch(`/api/brands/${brandId}`);
        if (!r2.ok) return;
      }
    } catch {
      /* ignore */
    }
  }

  async function discover(force: boolean) {
    setRunning(true);
    setErr(null);
    setContactsState("running");
    try {
      const res = await fetch(`/api/brands/${brandId}/contacts/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<
        DiscoverResp & { error: string }
      >;
      if (!res.ok) {
        setErr(data?.error ?? `HTTP ${res.status}`);
        setContactsState("error");
      } else {
        setContacts(data.contacts ?? []);
        setPattern(data.domain_pattern ?? null);
        setCatchAll(data.is_catch_all ?? null);
        setContactsState(data.state ?? "complete");
        router.refresh();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setContactsState("error");
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    load();
  }, [brandId]);

  function flashToast(message: string) {
    setToast(message);
    setTimeout(() => setToast(null), 2000);
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      flashToast(`Copied ${label}!`);
    } catch (e) {
      flashToast(
        `Copy failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  function rowsToTsv(rows: Contact[]): string {
    const header = ["Name", "Title", "Email", "LinkedIn", "Source"].join("\t");
    const body = rows
      .map((c) =>
        [
          c.full_name ?? "",
          c.title ?? "",
          c.email ?? "",
          c.linkedin_url ?? "",
          formatSourceLabel(c.email_source),
        ]
          .map((v) => String(v).replace(/\t/g, " ").replace(/\r?\n/g, " "))
          .join("\t"),
      )
      .join("\n");
    return `${header}\n${body}`;
  }

  function toggleRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selectedIds.size === contacts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(contacts.map((c) => c.id)));
    }
  }

  const selectedRows = contacts.filter((c) => selectedIds.has(c.id));
  const hasLinkedIn = contacts.some((c) => !!c.linkedin_url);

  return (
    <div className="card p-4 mb-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
            Contact Discovery
          </div>
          <div className="text-sm text-[var(--text-muted)] mt-1">
            Apollo + Hunter + MillionVerifier. Find decision-maker contacts
            and copy them for your outreach.
          </div>
        </div>
        <button
          className="btn"
          disabled={running}
          onClick={() => discover(true)}
        >
          {running
            ? "Discovering…"
            : contacts.length > 0
              ? "Re-discover"
              : "Discover decision-makers"}
        </button>
      </div>

      {err && <div className="text-sm text-red-400 mb-2">{err}</div>}

      {(pattern || catchAll != null) && (
        <div className="mb-3 text-xs text-[var(--text-muted)]">
          Domain signal:
          {pattern ? (
            <>
              {" "}pattern <code>{pattern}</code>
            </>
          ) : (
            <> no pattern detected</>
          )}
          {catchAll != null && (
            <>
              {" "}· catch-all: <strong>{catchAll ? "yes" : "no"}</strong>
            </>
          )}
        </div>
      )}

      {contacts.length === 0 ? (
        <div className="text-sm text-[var(--text-muted)]">
          No contacts found yet. Click{" "}
          {contactsState === "complete"
            ? "Re-discover"
            : "Discover decision-makers"}{" "}
          to run Apollo + Hunter + MillionVerifier.
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-2">
            <button
              className="btn btn-ghost text-xs"
              disabled={selectedRows.length === 0}
              onClick={() =>
                copyText(
                  rowsToTsv(selectedRows),
                  `${selectedRows.length} selected`,
                )
              }
            >
              Copy selected ({selectedRows.length})
            </button>
            <button
              className="btn btn-ghost text-xs"
              onClick={() =>
                copyText(rowsToTsv(contacts), `all ${contacts.length}`)
              }
            >
              Copy all
            </button>
            {toast && (
              <span className="text-xs text-[var(--accent,#60a5fa)] ml-2">
                {toast}
              </span>
            )}
          </div>
          <table className="w-full text-sm">
            <thead className="text-xs text-[var(--text-muted)] uppercase">
              <tr>
                <th className="text-left py-1 w-8">
                  <input
                    type="checkbox"
                    checked={
                      contacts.length > 0 &&
                      selectedIds.size === contacts.length
                    }
                    onChange={toggleAll}
                    aria-label="Select all"
                  />
                </th>
                <th className="text-left py-1">Name / Title</th>
                <th className="text-left py-1">Email</th>
                <th className="text-left py-1">Status</th>
                <th className="text-left py-1">Source</th>
                {hasLinkedIn && <th className="text-left py-1">LinkedIn</th>}
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} className="border-t border-[var(--border-soft)]">
                  <td className="py-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(c.id)}
                      onChange={() => toggleRow(c.id)}
                      aria-label={`Select ${c.full_name}`}
                    />
                  </td>
                  <td className="py-2">
                    <div className="font-medium">{c.full_name}</div>
                    <div className="text-xs text-[var(--text-muted)]">
                      {c.title ?? "—"}
                    </div>
                  </td>
                  <td className="py-2">
                    {c.email ? (
                      <span className="inline-flex items-center gap-2">
                        <code>{c.email}</code>
                        <button
                          type="button"
                          className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] underline"
                          onClick={() => copyText(c.email!, "email")}
                        >
                          Copy
                        </button>
                      </span>
                    ) : (
                      <code>—</code>
                    )}
                  </td>
                  <td className="py-2">
                    <EmailPill status={c.email_status} hasEmail={!!c.email} />
                    {typeof c.email_verifier_score === "number" && (
                      <span className="text-xs text-[var(--text-muted)] ml-1">
                        {Math.round(c.email_verifier_score * 100)}%
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-xs text-[var(--text-muted)]">
                    {formatSourceLabel(c.email_source)}
                  </td>
                  {hasLinkedIn && (
                    <td className="py-2 text-xs">
                      {c.linkedin_url ? (
                        <a
                          className="underline text-[var(--text-muted)] hover:text-[var(--text)]"
                          href={c.linkedin_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          LinkedIn ↗
                        </a>
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function formatSourceLabel(source: string | null | undefined): string {
  if (!source) return "—";
  switch (source) {
    case "apollo":
    case "apollo_crm":
      return "Apollo";
    case "hunter":
    case "hunter_pattern":
      return "Hunter";
    case "pattern_guess":
      return "Pattern guess";
    case "manual":
      return "Manual";
    default:
      return "—";
  }
}

function EmailPill({
  status,
  hasEmail,
}: {
  status: string | null;
  hasEmail: boolean;
}) {
  if (!hasEmail || status === "not_found") {
    return (
      <span className="inline-block px-2 py-0.5 rounded text-xs bg-zinc-700/40 text-zinc-200">
        Not found
      </span>
    );
  }
  if (!status) return <span className="text-xs text-[var(--text-muted)]">—</span>;
  const map: Record<string, { bg: string; label: string }> = {
    verified: { bg: "bg-green-700/40 text-green-200", label: "Verified ✓" },
    likely: { bg: "bg-amber-600/30 text-amber-200", label: "Likely" },
    risky: { bg: "bg-red-700/30 text-red-200", label: "Risky" },
    catch_all: { bg: "bg-zinc-600/40 text-zinc-200", label: "Catch-all" },
    bounced: { bg: "bg-red-800/40 text-red-200", label: "Bounced" },
    invalid: { bg: "bg-red-800/40 text-red-200", label: "Invalid" },
    guessed: { bg: "bg-zinc-700/40 text-zinc-200", label: "Guessed" },
    unknown: { bg: "bg-zinc-700/40 text-zinc-200", label: "Unknown" },
    not_found: { bg: "bg-zinc-700/40 text-zinc-200", label: "Not found" },
  };
  const s = map[status] ?? map.unknown;
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs ${s.bg}`}>
      {s.label}
    </span>
  );
}
