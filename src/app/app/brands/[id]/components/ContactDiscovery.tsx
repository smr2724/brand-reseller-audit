"use client";
/**
 * Phase 47 — Section B on /app/brands/[id]: Contact Discovery.
 *
 * Decision-makers table, primary toggle, send-to preview, re-discover
 * button. Mounted below the seller-classification table and above the
 * "Confirm & Generate Report" CTA. Preserves the Phase-43 STEVE_CC rule
 * (`steve@rollemanagementgroup.com`) as the always-CC recipient.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const STEVE_CC_DISPLAY = "steve@rollemanagementgroup.com";

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
  const [busyId, setBusyId] = useState<string | null>(null);

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

  async function setPrimary(contactId: string) {
    setBusyId(contactId);
    try {
      const res = await fetch(
        `/api/brands/${brandId}/contacts/${contactId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_primary: true }),
        },
      );
      if (res.ok) {
        setContacts((cs) =>
          cs.map((c) => ({ ...c, is_primary: c.id === contactId })),
        );
      }
    } finally {
      setBusyId(null);
    }
  }

  async function reverify(contactId: string) {
    setBusyId(contactId);
    try {
      const res = await fetch(
        `/api/brands/${brandId}/contacts/${contactId}/verify-email`,
        { method: "POST" },
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.verify) {
        setContacts((cs) =>
          cs.map((c) =>
            c.id === contactId
              ? {
                  ...c,
                  email_status: data.verify.status,
                  ready_to_send: data.verify.status === "verified",
                }
              : c,
          ),
        );
      }
    } finally {
      setBusyId(null);
    }
  }

  useEffect(() => {
    load();
  }, [brandId]);

  const primary = contacts.find((c) => c.is_primary) ?? contacts[0] ?? null;

  return (
    <div className="card p-4 mb-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
            Contact Discovery
          </div>
          <div className="text-sm text-[var(--text-muted)] mt-1">
            Apollo + Hunter + MillionVerifier. Generation will email the primary contact (CC{" "}
            <code>{STEVE_CC_DISPLAY}</code>).
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
          No contacts found yet. Click {contactsState === "complete" ? "Re-discover" : "Discover decision-makers"} to run Apollo + Hunter + MillionVerifier.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs text-[var(--text-muted)] uppercase">
            <tr>
              <th className="text-left py-1">Primary</th>
              <th className="text-left py-1">Name / Title</th>
              <th className="text-left py-1">Email</th>
              <th className="text-left py-1">Status</th>
              <th className="text-left py-1">Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id} className="border-t border-[var(--border-soft)]">
                <td className="py-2">
                  <input
                    type="radio"
                    checked={c.is_primary}
                    disabled={busyId === c.id}
                    onChange={() => setPrimary(c.id)}
                  />
                </td>
                <td className="py-2">
                  <div className="font-medium">{c.full_name}</div>
                  <div className="text-xs text-[var(--text-muted)]">
                    {c.title ?? "—"}
                    {c.linkedin_url && (
                      <>
                        {" "}·{" "}
                        <a
                          className="underline"
                          href={c.linkedin_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          LinkedIn
                        </a>
                      </>
                    )}
                  </div>
                </td>
                <td className="py-2">
                  <code>{c.email ?? "—"}</code>
                </td>
                <td className="py-2">
                  <EmailPill status={c.email_status} />
                  {typeof c.email_verifier_score === "number" && (
                    <span className="text-xs text-[var(--text-muted)] ml-1">
                      {Math.round(c.email_verifier_score * 100)}%
                    </span>
                  )}
                </td>
                <td className="py-2 text-xs text-[var(--text-muted)]">
                  {c.email_source ?? "—"}
                </td>
                <td className="py-2 text-right">
                  {c.email && (
                    <button
                      className="btn btn-ghost text-xs"
                      disabled={busyId === c.id}
                      onClick={() => reverify(c.id)}
                    >
                      Verify
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-3 text-xs text-[var(--text-muted)]">
        Send to:{" "}
        <strong>
          {primary?.email ?? "(no primary email yet)"}
        </strong>{" "}
        · CC <code>{STEVE_CC_DISPLAY}</code>
      </div>
    </div>
  );
}

function EmailPill({ status }: { status: string | null }) {
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
  };
  const s = map[status] ?? map.unknown;
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs ${s.bg}`}>
      {s.label}
    </span>
  );
}
