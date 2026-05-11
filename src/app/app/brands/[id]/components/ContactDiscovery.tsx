"use client";
/**
 * Phase 47 → Phase 52 → Phase 61 — Section B on /app/brands/[id]:
 * Contact Discovery.
 *
 * Phase 61 changes:
 *   - The card now loads via a real GET on mount, so persisted rows
 *     show up on every page reload (no more silent 405).
 *   - Each row is expandable into a chronological per-provider audit
 *     trail (Apollo Search → Apollo Match → Hunter Domain → Hunter
 *     Finder → Pattern Guess → MillionVerifier → ZeroBounce), with raw
 *     payload disclosures.
 *   - Three actions on selected rows: Save selected (sets
 *     ready_to_send=true), Copy emails, Mark as primary.
 *   - Re-discover shows a confirmation modal when saved/primary rows
 *     exist, explaining that they survive re-discovery.
 *   - Source column renders real provenance derived from events.
 *   - Status pill has a hover tooltip with provider/score/timestamp.
 *
 * Still does NOT send any emails. The actual report-send code path
 * (lib/email/resend.ts STEVE_CC) is unaffected.
 */
import { useEffect, useMemo, useState } from "react";
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
  email_verifier: string | null;
  email_verifier_score: number | null;
  email_verified_at: string | null;
  email_pattern_used: string | null;
  phone: string | null;
  phone_status: string | null;
  is_primary: boolean;
  ready_to_send: boolean;
  enrichment_state: "discovered" | "enriched" | "error" | null;
}

interface DiscoveryEvent {
  id: string;
  brand_id: string;
  contact_id: string | null;
  run_id: string;
  provider: string;
  outcome: string;
  reason: string | null;
  email_returned: string | null;
  status_returned: string | null;
  score_returned: number | null;
  http_status: number | null;
  raw_payload: unknown;
  created_at: string;
}

interface DiscoverResp {
  state: string;
  contacts: Contact[];
  domain_pattern: string | null;
  is_catch_all: boolean | null;
  events: DiscoveryEvent[];
  error?: string;
}

const PROVIDER_ORDER: Record<string, number> = {
  apollo_search: 1,
  apollo_match: 2,
  hunter_domain: 3,
  hunter_finder: 4,
  pattern_guess: 5,
  millionverifier: 6,
  zerobounce: 7,
  orchestrator: 8,
  enrichment_deferred: 9,
};

const PROVIDER_LABEL: Record<string, string> = {
  apollo_search: "Apollo Search",
  apollo_match: "Apollo Match",
  hunter_domain: "Hunter Domain",
  hunter_finder: "Hunter Finder",
  pattern_guess: "Pattern Guess",
  millionverifier: "MillionVerifier",
  zerobounce: "ZeroBounce",
  orchestrator: "Orchestrator",
  enrichment_deferred: "Enrichment Deferred",
};

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
  const [events, setEvents] = useState<DiscoveryEvent[]>([]);
  const [pattern, setPattern] = useState<string | null>(null);
  const [catchAll, setCatchAll] = useState<boolean | null>(null);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showOlderForId, setShowOlderForId] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [confirmReDiscover, setConfirmReDiscover] = useState(false);
  const [enrichingIds, setEnrichingIds] = useState<Set<string>>(new Set());

  async function load() {
    try {
      const res = await fetch(`/api/brands/${brandId}/contacts/discover`, {
        method: "GET",
      });
      const data = (await res.json().catch(() => ({}))) as Partial<DiscoverResp>;
      if (!res.ok) {
        // 404 = brand not found for this user; surface generically.
        setErr(data?.error ?? `HTTP ${res.status}`);
        return;
      }
      setContacts(data.contacts ?? []);
      setEvents(data.events ?? []);
      setPattern(data.domain_pattern ?? null);
      setCatchAll(data.is_catch_all ?? null);
      setContactsState(data.state ?? initialContactsState);
      if (data.error === "no domain resolved for brand") {
        setDomainError(
          "No domain resolved for this brand yet. Set the owner domain in the brand profile to run discovery.",
        );
      } else {
        setDomainError(null);
      }
    } catch {
      /* ignore — leaves card in initial state */
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
        setEvents(data.events ?? []);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);

  function flashToast(message: string) {
    setToast(message);
    setTimeout(() => setToast(null), 2200);
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

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleShowOlder(id: string) {
    setShowOlderForId((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedRows = useMemo(
    () => contacts.filter((c) => selectedIds.has(c.id)),
    [contacts, selectedIds],
  );
  const selectedWithEmail = useMemo(
    () => selectedRows.filter((c) => !!c.email),
    [selectedRows],
  );
  const hasLinkedIn = contacts.some((c) => !!c.linkedin_url);
  const savedCount = contacts.filter(
    (c) => c.ready_to_send || c.is_primary,
  ).length;

  // Group events by contact and run.
  const eventsByContact = useMemo(() => {
    const byContact = new Map<string, DiscoveryEvent[]>();
    for (const ev of events) {
      const cid = ev.contact_id ?? "__brand__";
      if (!byContact.has(cid)) byContact.set(cid, []);
      byContact.get(cid)!.push(ev);
    }
    return byContact;
  }, [events]);

  // Domain-level events (Hunter domain, Apollo search, orchestrator errors
  // with no contact_id). Shown once at the top of any expanded row's panel
  // so the user sees the upstream context for that run.
  const brandLevelEventsByRun = useMemo(() => {
    const m = new Map<string, DiscoveryEvent[]>();
    const brandLevel = eventsByContact.get("__brand__") ?? [];
    for (const ev of brandLevel) {
      if (!m.has(ev.run_id)) m.set(ev.run_id, []);
      m.get(ev.run_id)!.push(ev);
    }
    return m;
  }, [eventsByContact]);

  const latestRunId = useMemo(() => {
    if (events.length === 0) return null;
    // events came back sorted ascending by created_at; the last entry
    // is from the most recent run.
    return events[events.length - 1].run_id;
  }, [events]);

  async function onSaveSelected() {
    if (selectedRows.length === 0) return;
    try {
      const res = await fetch(
        `/api/brands/${brandId}/contacts/save-selected`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contactIds: selectedRows.map((c) => c.id),
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        contacts?: Array<{ id: string; ready_to_send?: boolean }>;
        error?: string;
      };
      if (!res.ok) {
        flashToast(`Save failed: ${data.error ?? `HTTP ${res.status}`}`);
        return;
      }
      const savedIds = new Set((data.contacts ?? []).map((c) => c.id));
      setContacts((prev) =>
        prev.map((c) =>
          savedIds.has(c.id) ? { ...c, ready_to_send: true } : c,
        ),
      );
      flashToast(
        `Saved ${savedIds.size} contact${savedIds.size === 1 ? "" : "s"}. They'll persist on this page next visit.`,
      );
    } catch (e) {
      flashToast(
        `Save failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  function onCopyEmails() {
    if (selectedWithEmail.length === 0) return;
    const text = selectedWithEmail.map((c) => c.email).join("\n");
    void copyText(text, `${selectedWithEmail.length} emails`);
  }

  async function onMarkPrimary() {
    if (selectedRows.length !== 1) return;
    const target = selectedRows[0];
    if (!target.email) return;
    try {
      const res = await fetch(
        `/api/brands/${brandId}/contacts/${target.id}/primary`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        contact?: { id: string; full_name: string; is_primary: boolean };
        error?: string;
      };
      if (!res.ok) {
        flashToast(`Couldn't mark primary: ${data.error ?? `HTTP ${res.status}`}`);
        return;
      }
      const newPrimaryId = data.contact?.id ?? target.id;
      setContacts((prev) =>
        prev
          .map((c) => ({
            ...c,
            is_primary: c.id === newPrimaryId,
          }))
          .sort((a, b) => {
            if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
            return 0;
          }),
      );
      flashToast(`Marked ${target.full_name} as primary contact.`);
    } catch (e) {
      flashToast(
        `Couldn't mark primary: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async function onEnrich(contactId: string) {
    setEnrichingIds((prev) => {
      const next = new Set(prev);
      next.add(contactId);
      return next;
    });
    try {
      const res = await fetch(
        `/api/brands/${brandId}/contacts/${contactId}/enrich`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        contact?: Contact;
        events?: DiscoveryEvent[];
        error?: string;
      };
      if (!res.ok) {
        flashToast(`Enrich failed: ${data.error ?? `HTTP ${res.status}`}`);
        return;
      }
      if (data.contact) {
        const updated = data.contact;
        setContacts((prev) =>
          prev.map((c) => (c.id === updated.id ? updated : c)),
        );
      }
      if (data.events && data.events.length > 0) {
        setEvents((prev) => [...prev, ...(data.events ?? [])]);
      }
      flashToast(
        data.contact?.email
          ? `Enriched ${data.contact.full_name} → ${data.contact.email}.`
          : `Enrich ran for ${data.contact?.full_name ?? "contact"} but no email was resolved.`,
      );
    } catch (e) {
      flashToast(
        `Enrich failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setEnrichingIds((prev) => {
        const next = new Set(prev);
        next.delete(contactId);
        return next;
      });
    }
  }

  function onClickReDiscover() {
    if (savedCount > 0) {
      setConfirmReDiscover(true);
    } else {
      void discover(true);
    }
  }

  return (
    <div className="card p-4 mb-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
            Contact Discovery
          </div>
          <div className="text-sm text-[var(--text-muted)] mt-1">
            Apollo + Hunter + MillionVerifier. Find decision-maker contacts,
            review the provider chain, and save the ones you want to keep.
          </div>
        </div>
        <button
          className="btn"
          disabled={running}
          onClick={onClickReDiscover}
        >
          {running
            ? "Discovering…"
            : contacts.length > 0
              ? "Re-discover"
              : "Discover decision-makers"}
        </button>
      </div>

      {err && <div className="text-sm text-red-400 mb-2">{err}</div>}
      {domainError && (
        <div className="text-sm text-amber-300 mb-2">{domainError}</div>
      )}

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

      {/* Phase 62 — surface brand/run-level events (Apollo search,
          Hunter domain-pattern) above the per-contact table so the user
          can see what happened at the run level even when no contacts
          were resolved (or before they expand a row). */}
      {latestRunId &&
        (brandLevelEventsByRun.get(latestRunId) ?? []).length > 0 && (
          <details className="mb-3 rounded border border-[var(--border-soft)] p-2">
            <summary className="text-xs text-[var(--text-muted)] cursor-pointer select-none">
              Discovery run audit ({(brandLevelEventsByRun.get(latestRunId) ?? []).length} run-level event{(brandLevelEventsByRun.get(latestRunId) ?? []).length === 1 ? "" : "s"})
            </summary>
            <div className="mt-2">
              <EventTrail
                latestEvents={[]}
                brandEvents={brandLevelEventsByRun.get(latestRunId) ?? []}
              />
            </div>
          </details>
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
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <button
              className="btn btn-ghost text-xs"
              disabled={selectedRows.length === 0}
              onClick={onSaveSelected}
            >
              Save selected ({selectedRows.length})
            </button>
            <button
              className="btn btn-ghost text-xs"
              disabled={selectedWithEmail.length === 0}
              onClick={onCopyEmails}
              title={
                selectedRows.length > selectedWithEmail.length
                  ? `${selectedRows.length - selectedWithEmail.length} selected row(s) have no email and will be skipped.`
                  : undefined
              }
            >
              {selectedRows.length > 0 &&
              selectedWithEmail.length !== selectedRows.length
                ? `Copy emails (${selectedWithEmail.length} of ${selectedRows.length})`
                : `Copy emails${selectedWithEmail.length > 0 ? ` (${selectedWithEmail.length})` : ""}`}
            </button>
            <button
              className="btn btn-ghost text-xs"
              disabled={
                selectedRows.length !== 1 || !selectedRows[0]?.email
              }
              onClick={onMarkPrimary}
              title={
                selectedRows.length !== 1
                  ? "Select exactly one row to mark primary."
                  : !selectedRows[0]?.email
                    ? "Selected row has no email — can't mark as primary."
                    : undefined
              }
            >
              Mark as primary
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
                <th className="text-left py-1 w-6"></th>
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
              {contacts.map((c) => {
                const isExpanded = expandedIds.has(c.id);
                const contactEvents = eventsByContact.get(c.id) ?? [];
                const provenance = describeProvenance(contactEvents);
                return (
                  <ContactRow
                    key={c.id}
                    c={c}
                    isExpanded={isExpanded}
                    isSelected={selectedIds.has(c.id)}
                    hasLinkedIn={hasLinkedIn}
                    onToggleExpanded={() => toggleExpanded(c.id)}
                    onToggleRow={() => toggleRow(c.id)}
                    onCopyEmail={(v) => copyText(v, "email")}
                    provenance={provenance}
                    contactEvents={contactEvents}
                    brandEventsByRun={brandLevelEventsByRun}
                    latestRunId={latestRunId}
                    showOlder={showOlderForId.has(c.id)}
                    onToggleShowOlder={() => toggleShowOlder(c.id)}
                    isEnriching={enrichingIds.has(c.id)}
                    onEnrich={() => void onEnrich(c.id)}
                  />
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {confirmReDiscover && (
        <ConfirmModal
          title="Re-discover contacts?"
          body="Re-discovering will refresh provider data for these contacts, but won't erase your saved emails, primary contact, or notes."
          cancelLabel="Cancel"
          confirmLabel="Re-discover"
          onCancel={() => setConfirmReDiscover(false)}
          onConfirm={() => {
            setConfirmReDiscover(false);
            void discover(true);
          }}
        />
      )}
    </div>
  );
}

function ContactRow({
  c,
  isExpanded,
  isSelected,
  hasLinkedIn,
  onToggleExpanded,
  onToggleRow,
  onCopyEmail,
  provenance,
  contactEvents,
  brandEventsByRun,
  latestRunId,
  showOlder,
  onToggleShowOlder,
  isEnriching,
  onEnrich,
}: {
  c: Contact;
  isExpanded: boolean;
  isSelected: boolean;
  hasLinkedIn: boolean;
  onToggleExpanded: () => void;
  onToggleRow: () => void;
  onCopyEmail: (email: string) => void;
  provenance: string;
  contactEvents: DiscoveryEvent[];
  brandEventsByRun: Map<string, DiscoveryEvent[]>;
  latestRunId: string | null;
  showOlder: boolean;
  onToggleShowOlder: () => void;
  isEnriching: boolean;
  onEnrich: () => void;
}) {
  const isDiscovered = c.enrichment_state === "discovered";
  const colSpan = hasLinkedIn ? 7 : 6;
  // Group this contact's events by run.
  const eventsByRun = new Map<string, DiscoveryEvent[]>();
  for (const ev of contactEvents) {
    if (!eventsByRun.has(ev.run_id)) eventsByRun.set(ev.run_id, []);
    eventsByRun.get(ev.run_id)!.push(ev);
  }
  const runIdsDesc: string[] = Array.from(eventsByRun.keys()).sort((a, b) => {
    const aLatest = a === latestRunId ? 1 : 0;
    const bLatest = b === latestRunId ? 1 : 0;
    if (aLatest !== bLatest) return bLatest - aLatest;
    // Fallback: sort by max created_at within the run, desc.
    const aTs = Math.max(
      ...(eventsByRun.get(a) ?? []).map((e) => Date.parse(e.created_at)),
    );
    const bTs = Math.max(
      ...(eventsByRun.get(b) ?? []).map((e) => Date.parse(e.created_at)),
    );
    return bTs - aTs;
  });
  const latestEvents = latestRunId ? (eventsByRun.get(latestRunId) ?? []) : [];
  const olderRunIds = runIdsDesc.filter((r) => r !== latestRunId);
  return (
    <>
      <tr className="border-t border-[var(--border-soft)]">
        <td className="py-2 align-top">
          <button
            type="button"
            className="text-[var(--text-muted)] hover:text-[var(--text)] text-xs"
            aria-label={isExpanded ? "Collapse" : "Expand"}
            onClick={onToggleExpanded}
          >
            {isExpanded ? "▾" : "▸"}
          </button>
        </td>
        <td className="py-2 align-top">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleRow}
            aria-label={`Select ${c.full_name}`}
          />
        </td>
        <td className="py-2 align-top">
          <div className="font-medium flex items-center gap-2">
            <span>{c.full_name}</span>
            {c.is_primary && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-700/40 text-amber-200">
                Primary
              </span>
            )}
            {c.ready_to_send && !c.is_primary && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-800/40 text-emerald-200">
                Saved
              </span>
            )}
          </div>
          <div className="text-xs text-[var(--text-muted)]">
            {c.title ?? "—"}
          </div>
        </td>
        <td className="py-2 align-top">
          {c.email ? (
            <span className="inline-flex items-center gap-2">
              <code>{c.email}</code>
              <button
                type="button"
                className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] underline"
                onClick={() => onCopyEmail(c.email!)}
              >
                Copy
              </button>
            </span>
          ) : isDiscovered ? (
            <button
              type="button"
              className="btn btn-ghost text-[11px]"
              disabled={isEnriching}
              onClick={onEnrich}
              title="Spend an Apollo email credit to unlock this contact's email."
            >
              {isEnriching ? "Enriching…" : "Enrich"}
            </button>
          ) : (
            <code>—</code>
          )}
        </td>
        <td className="py-2 align-top">
          {isDiscovered ? (
            <span className="inline-block px-2 py-0.5 rounded text-xs bg-zinc-700/40 text-zinc-200">
              Not enriched
            </span>
          ) : (
            <>
              <EmailPill
                status={c.email_status}
                hasEmail={!!c.email}
                verifier={c.email_verifier}
                score={c.email_verifier_score}
                verifiedAt={c.email_verified_at}
              />
              {typeof c.email_verifier_score === "number" && (
                <span className="text-xs text-[var(--text-muted)] ml-1">
                  {Math.round(c.email_verifier_score * 100)}%
                </span>
              )}
            </>
          )}
        </td>
        <td className="py-2 align-top text-xs text-[var(--text-muted)]">
          {provenance || "—"}
        </td>
        {hasLinkedIn && (
          <td className="py-2 align-top text-xs">
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
      {isExpanded && (
        <tr className="bg-[var(--bg-soft,rgba(255,255,255,0.02))]">
          <td colSpan={colSpan} className="px-4 py-3 align-top">
            <EventTrail
              latestEvents={latestEvents}
              brandEvents={
                latestRunId ? (brandEventsByRun.get(latestRunId) ?? []) : []
              }
            />
            {olderRunIds.length > 0 && (
              <div className="mt-3">
                <button
                  type="button"
                  className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] underline"
                  onClick={onToggleShowOlder}
                >
                  {showOlder
                    ? "Hide earlier discovery runs"
                    : `View earlier discovery runs (${olderRunIds.length})`}
                </button>
                {showOlder && (
                  <div className="mt-2 space-y-3">
                    {olderRunIds.map((rid) => (
                      <div key={rid}>
                        <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mb-1">
                          Run {rid.slice(0, 8)}
                        </div>
                        <EventTrail
                          latestEvents={eventsByRun.get(rid) ?? []}
                          brandEvents={brandEventsByRun.get(rid) ?? []}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function EventTrail({
  latestEvents,
  brandEvents,
}: {
  latestEvents: DiscoveryEvent[];
  brandEvents: DiscoveryEvent[];
}) {
  // Combine brand-level + contact-level events for the run, then sort
  // by chronological order: provider order first (the canonical chain
  // top-to-bottom), tie-broken by created_at.
  const all = [...brandEvents, ...latestEvents];
  const sorted = all.slice().sort((a, b) => {
    const ao = PROVIDER_ORDER[a.provider] ?? 99;
    const bo = PROVIDER_ORDER[b.provider] ?? 99;
    if (ao !== bo) return ao - bo;
    return Date.parse(a.created_at) - Date.parse(b.created_at);
  });
  if (sorted.length === 0) {
    return (
      <div className="text-xs text-[var(--text-muted)]">
        No provider events recorded for this contact yet. Run discovery to populate the audit trail.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {sorted.map((ev) => (
        <EventCard key={ev.id} ev={ev} />
      ))}
    </div>
  );
}

function EventCard({ ev }: { ev: DiscoveryEvent }) {
  const [showRaw, setShowRaw] = useState(false);
  const providerLabel = PROVIDER_LABEL[ev.provider] ?? ev.provider;
  return (
    <div className="rounded border border-[var(--border-soft)] p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-zinc-800/60 text-zinc-200">
          {providerLabel}
        </span>
        <OutcomePill outcome={ev.outcome} />
        {ev.status_returned && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-700/40 text-zinc-300">
            {ev.status_returned}
          </span>
        )}
        {typeof ev.score_returned === "number" && (
          <span className="text-[11px] text-[var(--text-muted)]">
            score {ev.score_returned.toFixed(2)}
          </span>
        )}
        {typeof ev.http_status === "number" && (
          <span className="text-[11px] text-[var(--text-muted)]">
            HTTP {ev.http_status}
          </span>
        )}
        <span className="text-[11px] text-[var(--text-muted)] ml-auto">
          {relativeTime(ev.created_at)}
        </span>
      </div>
      {ev.reason && (
        <div className="mt-1 text-[var(--text)]">{ev.reason}</div>
      )}
      {ev.email_returned && (
        <div className="mt-1 text-[var(--text-muted)]">
          email: <code>{ev.email_returned}</code>
        </div>
      )}
      {ev.raw_payload != null && (
        <div className="mt-1">
          <button
            type="button"
            className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] underline"
            onClick={() => setShowRaw((v) => !v)}
          >
            {showRaw ? "Hide raw response" : "Show raw response"}
          </button>
          {showRaw && (
            <pre className="mt-1 max-h-64 overflow-auto rounded bg-black/40 p-2 text-[11px] leading-snug whitespace-pre-wrap break-words">
              {safeStringify(ev.raw_payload)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function OutcomePill({ outcome }: { outcome: string }) {
  const map: Record<string, { bg: string; label: string }> = {
    found: { bg: "bg-emerald-800/40 text-emerald-200", label: "found" },
    not_found: { bg: "bg-zinc-700/40 text-zinc-200", label: "not found" },
    skipped: { bg: "bg-zinc-700/30 text-zinc-300", label: "skipped" },
    error: { bg: "bg-red-800/40 text-red-200", label: "error" },
    retry_exhausted: { bg: "bg-red-800/40 text-red-200", label: "retries exhausted" },
  };
  const s = map[outcome] ?? { bg: "bg-zinc-700/40 text-zinc-200", label: outcome };
  return (
    <span className={`text-[11px] px-1.5 py-0.5 rounded ${s.bg}`}>
      {s.label}
    </span>
  );
}

function ConfirmModal({
  title,
  body,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="card max-w-md p-4">
        <div className="font-medium mb-2">{title}</div>
        <div className="text-sm text-[var(--text-muted)] mb-4">{body}</div>
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost text-xs" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className="btn text-xs" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmailPill({
  status,
  hasEmail,
  verifier,
  score,
  verifiedAt,
}: {
  status: string | null;
  hasEmail: boolean;
  verifier: string | null;
  score: number | null;
  verifiedAt: string | null;
}) {
  let label: string;
  let bg: string;
  if (!hasEmail || status === "not_found") {
    label = "Not found";
    bg = "bg-zinc-700/40 text-zinc-200";
  } else {
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
    const s = status ? map[status] : null;
    if (!s) {
      return <span className="text-xs text-[var(--text-muted)]">—</span>;
    }
    label = s.label;
    bg = s.bg;
  }
  const tooltipBits: string[] = [];
  if (verifier && verifier !== "none") {
    tooltipBits.push(verifier === "millionverifier" ? "MillionVerifier" : "ZeroBounce");
  }
  if (status) tooltipBits.push(status);
  if (typeof score === "number") tooltipBits.push(score.toFixed(2));
  if (verifiedAt) tooltipBits.push(relativeTime(verifiedAt));
  const title = tooltipBits.join(" · ");
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs ${bg}`}
      title={title || undefined}
    >
      {label}
    </span>
  );
}

function describeProvenance(events: DiscoveryEvent[]): string {
  // Determine which provider yielded the persisted email, then which
  // verifier last spoke.
  let source: string | null = null;
  let verifier: { name: string; outcome: string; status: string | null } | null = null;
  // Iterate in chronological order.
  for (const ev of events) {
    if (ev.outcome === "found") {
      if (ev.provider === "apollo_match" || ev.provider === "apollo_search") {
        source = "Apollo";
      } else if (ev.provider === "hunter_finder") {
        source = "Hunter";
      } else if (ev.provider === "pattern_guess") {
        source = "Pattern guess";
      }
    }
    if (ev.provider === "millionverifier" && ev.outcome === "found") {
      verifier = { name: "MillionVerifier", outcome: ev.outcome, status: ev.status_returned };
    }
    if (ev.provider === "zerobounce" && ev.outcome === "found") {
      verifier = { name: "ZeroBounce", outcome: ev.outcome, status: ev.status_returned };
    }
  }
  if (!source) return "";
  if (!verifier) return source;
  const ok = verifier.status === "verified";
  const verifierLabel =
    verifier.status && verifier.status !== "verified"
      ? `${verifier.name} ${verifier.status}`
      : `${verifier.name} ${ok ? "✓" : ""}`.trim();
  return `${source} → ${verifierLabel}`;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  return `${days}d ago`;
}
