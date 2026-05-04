"use client";

/**
 * Phase 33.1 — Brand Owner Resolver section, rendered at the top of the
 * user-facing brand page (/app/brands/[id]).
 *
 * State-driven UI:
 *   pending          → "Find brand owner" CTA
 *   running          → spinner + polling /candidates every 3s, hard cap 90s
 *   candidates_ready → multi-select table, owner-type, save/reject, notes
 *   selected         → resolved-owner result card + re-run button
 *   failed           → error message + try-again button
 *
 * Auth: all API calls go through the user's Supabase session (cookies);
 * brand ownership is enforced server-side by the API routes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export interface BrandOwnerBrand {
  id: string;
  name: string;
  owner_resolution_state: string;
  owner_resolution_error: string | null;
  owner_resolved_at: string | null;
  resolved_owner_company_name: string | null;
  resolved_owner_domain: string | null;
  resolved_owner_type: string | null;
  owner_resolution_notes: string | null;
}

export interface BrandOwnerRun {
  id: string;
  brand_id: string;
  triggered_by: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  error_message: string | null;
  uspto_query: string | null;
  uspto_results_count: number | null;
  web_search_queries: string[] | null;
  web_search_results_count: number | null;
  candidates_inserted: number;
}

export interface BrandOwnerCandidate {
  id: string;
  brand_id: string;
  resolution_run_id: string;
  candidate_company_name: string;
  candidate_domain: string | null;
  candidate_source: string;
  evidence_text: string | null;
  evidence_url: string | null;
  match_reason: string | null;
  trademark_serial_number: string | null;
  trademark_status: string | null;
  trademark_registration_date: string | null;
  trademark_owner_address: string | null;
  goods_services_text: string | null;
  heuristic_score: number;
  heuristic_label: string;
  is_selected_owner: boolean;
  needs_manual_review: boolean;
  selected_at: string | null;
  created_at: string;
}

const OWNER_TYPES = [
  "manufacturer",
  "brand_owner",
  "licensee",
  "distributor",
  "dba",
  "holding_co",
  "unknown",
] as const;

const POLL_MS = 3000;
const MAX_POLLS = 30;

function labelBadgeClass(label: string): string {
  switch (label) {
    case "very_high":
      return "bg-[#102a14] text-[#4ade80] border-[#1e4a28]";
    case "high":
      return "bg-[#0e2236] text-[#7dd3fc] border-[#1e3a55]";
    case "medium":
      return "bg-[#2a2410] text-[#facc15] border-[#4a3e1e]";
    case "needs_review":
      return "bg-[#2a1415] text-[#f87171] border-[#4a1e21]";
    default:
      return "bg-[var(--bg-3)] text-[var(--text-muted)] border-[var(--border-soft)]";
  }
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function secondsSince(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

export default function BrandOwnerSection({
  brand: initialBrand,
  run: initialRun,
  candidates: initialCandidates,
}: {
  brand: BrandOwnerBrand;
  run: BrandOwnerRun | null;
  candidates: BrandOwnerCandidate[];
}) {
  const router = useRouter();
  const [brand, setBrand] = useState(initialBrand);
  const [run, setRun] = useState<BrandOwnerRun | null>(initialRun);
  const [candidates, setCandidates] =
    useState<BrandOwnerCandidate[]>(initialCandidates);
  const [busy, setBusy] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [pollExhausted, setPollExhausted] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    const ids = new Set<string>();
    for (const c of initialCandidates) if (c.is_selected_owner) ids.add(c.id);
    return ids;
  });
  const [ownerType, setOwnerType] = useState<string>(
    initialBrand.resolved_owner_type ?? "manufacturer",
  );
  const [notes, setNotes] = useState<string>(
    initialBrand.owner_resolution_notes ?? "",
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Sync local state when SSR refresh hands us new props.
  useEffect(() => {
    setBrand(initialBrand);
    setRun(initialRun);
    setCandidates(initialCandidates);
    setOwnerType(initialBrand.resolved_owner_type ?? "manufacturer");
    setNotes(initialBrand.owner_resolution_notes ?? "");
    const ids = new Set<string>();
    for (const c of initialCandidates) if (c.is_selected_owner) ids.add(c.id);
    setSelectedIds(ids);
  }, [initialBrand, initialRun, initialCandidates]);

  const pollCountRef = useRef(0);

  // Polling effect: fires while state === 'running'.
  useEffect(() => {
    if (brand.owner_resolution_state !== "running") {
      pollCountRef.current = 0;
      setPollExhausted(false);
      return;
    }
    let cancelled = false;
    pollCountRef.current = 0;
    setPollExhausted(false);

    const tick = async () => {
      if (cancelled) return;
      pollCountRef.current += 1;
      try {
        const res = await fetch(
          `/api/owner-resolver/candidates?brand_id=${encodeURIComponent(brand.id)}`,
          { credentials: "include", cache: "no-store" },
        );
        if (!res.ok) throw new Error(`poll failed (${res.status})`);
        const json = (await res.json()) as {
          brand: BrandOwnerBrand;
          run: BrandOwnerRun | null;
          candidates: BrandOwnerCandidate[];
        };
        if (cancelled) return;
        setBrand(json.brand);
        setRun(json.run);
        setCandidates(json.candidates ?? []);
        if (json.brand.owner_resolution_state !== "running") {
          router.refresh();
          return;
        }
        if (pollCountRef.current >= MAX_POLLS) {
          setPollExhausted(true);
          return;
        }
        setTimeout(tick, POLL_MS);
      } catch {
        if (cancelled) return;
        if (pollCountRef.current >= MAX_POLLS) {
          setPollExhausted(true);
          return;
        }
        setTimeout(tick, POLL_MS);
      }
    };
    setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
    };
  }, [brand.id, brand.owner_resolution_state, router]);

  const sortedCandidates = useMemo(() => {
    return [...candidates].sort((a, b) => {
      if (b.heuristic_score !== a.heuristic_score) {
        return b.heuristic_score - a.heuristic_score;
      }
      return a.created_at < b.created_at ? 1 : -1;
    });
  }, [candidates]);

  const callApi = useCallback(
    async (
      path: string,
      body: unknown,
      method: "POST" = "POST",
    ): Promise<Record<string, unknown> | null> => {
      setBusy(path);
      setErrorMsg(null);
      setStatusMsg(null);
      try {
        const res = await fetch(path, {
          method,
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        });
        const json = (await res
          .json()
          .catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          setErrorMsg(
            typeof json.error === "string"
              ? json.error
              : `request failed (${res.status})`,
          );
          return null;
        }
        return json;
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const optimisticToRunning = useCallback(() => {
    setBrand((b) => ({
      ...b,
      owner_resolution_state: "running",
      owner_resolution_error: null,
    }));
    setRun((r) =>
      r
        ? { ...r, status: "running", started_at: new Date().toISOString() }
        : {
            id: "optimistic",
            brand_id: brand.id,
            triggered_by: "user",
            started_at: new Date().toISOString(),
            completed_at: null,
            status: "running",
            error_message: null,
            uspto_query: null,
            uspto_results_count: null,
            web_search_queries: null,
            web_search_results_count: null,
            candidates_inserted: 0,
          },
    );
  }, [brand.id]);

  const onTrigger = useCallback(async () => {
    optimisticToRunning();
    const result = await callApi("/api/owner-resolver/trigger", {
      brand_id: brand.id,
    });
    if (result) {
      setStatusMsg(
        `Resolver run complete — ${String(result.candidates_count ?? 0)} candidates inserted`,
      );
      router.refresh();
    } else {
      // trigger failed — refresh so we re-read whatever real state is in DB.
      router.refresh();
    }
  }, [brand.id, callApi, optimisticToRunning, router]);

  const onSaveSelection = useCallback(async () => {
    if (selectedIds.size === 0) {
      setErrorMsg("Pick at least one candidate first");
      return;
    }
    const result = await callApi("/api/owner-resolver/select", {
      brand_id: brand.id,
      candidate_ids: Array.from(selectedIds),
      resolved_owner_type: ownerType,
    });
    if (result) {
      setStatusMsg(
        `Selection saved — ${String(result.selected_count ?? 0)} owner(s)`,
      );
      router.refresh();
    }
  }, [brand.id, callApi, ownerType, router, selectedIds]);

  const onSaveNotes = useCallback(async () => {
    if ((notes ?? "") === (initialBrand.owner_resolution_notes ?? "")) return;
    const result = await callApi("/api/owner-resolver/notes", {
      brand_id: brand.id,
      notes,
    });
    if (result) setStatusMsg("Notes saved");
  }, [brand.id, callApi, initialBrand.owner_resolution_notes, notes]);

  const onMarkNone = useCallback(async () => {
    const ok = window.confirm(
      "None of these are the owner? This marks the brand as failed so you can do manual research.",
    );
    if (!ok) return;
    const result = await callApi("/api/owner-resolver/reject", {
      brand_id: brand.id,
      note: notes.trim().length > 0 ? notes.trim() : undefined,
    });
    if (result) {
      setStatusMsg("Marked failed — none of the candidates matched.");
      router.refresh();
    }
  }, [brand.id, callApi, notes, router]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const state = brand.owner_resolution_state;
  const triggerBusy = busy === "/api/owner-resolver/trigger";

  return (
    <div className="card p-5 mb-6">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
            Brand Owner
          </div>
          <div className="text-sm text-[var(--text-muted)] mt-1">
            Identify the company that actually owns this brand to power outreach.
          </div>
        </div>
      </div>

      {statusMsg && (
        <div
          className="mb-3 p-2 rounded border text-sm"
          style={{
            background: "#102a14",
            borderColor: "#1e4a28",
            color: "#4ade80",
          }}
        >
          {statusMsg}
        </div>
      )}
      {errorMsg && (
        <div
          className="mb-3 p-2 rounded border text-sm"
          style={{
            background: "#2a1415",
            borderColor: "#4a1e21",
            color: "#f87171",
          }}
        >
          {errorMsg}
        </div>
      )}

      {state === "pending" && (
        <PendingView triggerBusy={triggerBusy} onTrigger={onTrigger} />
      )}

      {state === "running" && (
        <RunningView
          run={run}
          pollExhausted={pollExhausted}
          onRefresh={() => router.refresh()}
        />
      )}

      {state === "candidates_ready" && (
        <CandidatesView
          candidates={sortedCandidates}
          selectedIds={selectedIds}
          ownerType={ownerType}
          notes={notes}
          expanded={expanded}
          busy={busy}
          onToggleSelected={toggleSelected}
          onToggleExpanded={toggleExpanded}
          onOwnerTypeChange={setOwnerType}
          onNotesChange={setNotes}
          onSaveNotes={onSaveNotes}
          onSaveSelection={onSaveSelection}
          onMarkNone={onMarkNone}
          onRerun={onTrigger}
          triggerBusy={triggerBusy}
        />
      )}

      {state === "selected" && (
        <SelectedView
          brand={brand}
          triggerBusy={triggerBusy}
          onRerun={onTrigger}
        />
      )}

      {state === "failed" && (
        <FailedView
          brand={brand}
          triggerBusy={triggerBusy}
          onRerun={onTrigger}
        />
      )}
    </div>
  );
}

function PendingView({
  triggerBusy,
  onTrigger,
}: {
  triggerBusy: boolean;
  onTrigger: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div className="text-sm text-[var(--text-muted)]">
        We can identify the company that actually owns this brand to power outreach.
      </div>
      <button
        type="button"
        className="btn btn-primary text-sm"
        onClick={onTrigger}
        disabled={triggerBusy}
      >
        {triggerBusy ? "Starting…" : "Find brand owner"}
      </button>
    </div>
  );
}

function RunningView({
  run,
  pollExhausted,
  onRefresh,
}: {
  run: BrandOwnerRun | null;
  pollExhausted: boolean;
  onRefresh: () => void;
}) {
  const elapsed = secondsSince(run?.started_at ?? null);
  return (
    <div
      className="p-3 rounded border flex items-center gap-3 flex-wrap"
      style={{
        background: "#1a2233",
        borderColor: "#2c3a55",
        color: "#bcd0ee",
      }}
    >
      <span className="inline-block w-3 h-3 rounded-full border-2 border-[#bcd0ee] border-t-transparent animate-spin" />
      <div className="flex-1 min-w-[200px]">
        <div className="text-sm font-medium">
          Searching trademark records and the web for the company behind this brand…
        </div>
        <div className="text-xs text-[var(--text-muted)] mt-1">
          Started {elapsed}s ago.
          {pollExhausted
            ? " Taking longer than expected — try refreshing."
            : ""}
        </div>
      </div>
      {pollExhausted && (
        <button
          type="button"
          className="btn btn-ghost text-xs"
          onClick={onRefresh}
        >
          Refresh
        </button>
      )}
    </div>
  );
}

function CandidatesView({
  candidates,
  selectedIds,
  ownerType,
  notes,
  expanded,
  busy,
  onToggleSelected,
  onToggleExpanded,
  onOwnerTypeChange,
  onNotesChange,
  onSaveNotes,
  onSaveSelection,
  onMarkNone,
  onRerun,
  triggerBusy,
}: {
  candidates: BrandOwnerCandidate[];
  selectedIds: Set<string>;
  ownerType: string;
  notes: string;
  expanded: Set<string>;
  busy: string | null;
  onToggleSelected: (id: string) => void;
  onToggleExpanded: (id: string) => void;
  onOwnerTypeChange: (v: string) => void;
  onNotesChange: (v: string) => void;
  onSaveNotes: () => void;
  onSaveSelection: () => void;
  onMarkNone: () => void;
  onRerun: () => void;
  triggerBusy: boolean;
}) {
  const selectedCount = selectedIds.size;
  return (
    <div>
      {candidates.length === 0 ? (
        <div className="text-sm text-[var(--text-muted)] py-4">
          The resolver finished but no candidates were inserted. You can re-run
          it or mark this brand as needing manual research.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-[var(--border-soft)]">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border-soft)] text-xs uppercase tracking-wide">
                <th className="px-3 py-2 w-8">Pick</th>
                <th className="px-3 py-2">Candidate</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Score</th>
                <th className="px-3 py-2">TM status</th>
                <th className="px-3 py-2">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => {
                const isPicked = selectedIds.has(c.id);
                const wasSelected = c.is_selected_owner;
                return (
                  <tr
                    key={c.id}
                    className={`border-b border-[var(--border-soft)] ${
                      wasSelected ? "border-l-4 border-l-[#4ade80]" : ""
                    }`}
                  >
                    <td className="px-3 py-2 align-top">
                      <input
                        type="checkbox"
                        checked={isPicked}
                        onChange={() => onToggleSelected(c.id)}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium">
                        {c.candidate_company_name}
                      </div>
                      {c.candidate_domain ? (
                        <a
                          href={`https://${c.candidate_domain}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-[#7dd3fc] hover:underline"
                        >
                          {c.candidate_domain}
                        </a>
                      ) : (
                        <div className="text-xs text-[var(--text-muted)]">
                          (no domain)
                        </div>
                      )}
                      {c.match_reason && (
                        <div className="text-xs text-[var(--text-muted)] mt-1">
                          {c.match_reason}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs border border-[var(--border-soft)] bg-[var(--bg-2)]">
                        {c.candidate_source}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="flex flex-col gap-1">
                        <span className="font-medium">{c.heuristic_score}</span>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs border ${labelBadgeClass(c.heuristic_label)}`}
                        >
                          {c.heuristic_label}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top text-xs">
                      {c.trademark_status ? (
                        <>
                          <div>{c.trademark_status}</div>
                          {c.trademark_serial_number && (
                            <div className="text-[var(--text-muted)]">
                              SN {c.trademark_serial_number}
                            </div>
                          )}
                          {c.trademark_registration_date && (
                            <div className="text-[var(--text-muted)]">
                              Reg. {c.trademark_registration_date}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top text-xs max-w-[420px]">
                      {c.evidence_text && (
                        <button
                          type="button"
                          onClick={() => onToggleExpanded(c.id)}
                          className="text-left"
                        >
                          {expanded.has(c.id) ? (
                            <span>{c.evidence_text}</span>
                          ) : (
                            <span>
                              {c.evidence_text.slice(0, 120)}
                              {c.evidence_text.length > 120 ? "…" : ""}
                            </span>
                          )}
                        </button>
                      )}
                      {c.evidence_url && (
                        <div className="mt-1">
                          <a
                            href={c.evidence_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[#7dd3fc] hover:underline"
                          >
                            source ↗
                          </a>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4">
        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">
          Notes
        </div>
        <textarea
          className="input min-h-[80px] font-normal w-full"
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          onBlur={onSaveNotes}
          placeholder="Notes about why you picked these owners, what to look at next, etc. Saves on blur."
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="text-sm">
          <span className="font-medium">{selectedCount}</span> selected
        </div>
        <label className="text-sm flex items-center gap-2">
          Owner type
          <select
            className="select w-auto"
            value={ownerType}
            onChange={(e) => onOwnerTypeChange(e.target.value)}
          >
            {OWNER_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-primary text-sm"
          onClick={onSaveSelection}
          disabled={busy != null || selectedCount === 0}
        >
          Save selection
        </button>
        <button
          type="button"
          className="btn btn-ghost text-sm"
          onClick={onMarkNone}
          disabled={busy != null}
        >
          None of these
        </button>
        <button
          type="button"
          className="btn btn-ghost text-sm ml-auto"
          onClick={onRerun}
          disabled={triggerBusy}
        >
          {triggerBusy ? "Re-running…" : "Re-run resolver"}
        </button>
      </div>
    </div>
  );
}

function SelectedView({
  brand,
  triggerBusy,
  onRerun,
}: {
  brand: BrandOwnerBrand;
  triggerBusy: boolean;
  onRerun: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div className="flex-1 min-w-[260px]">
        <div className="text-lg font-semibold">
          {brand.resolved_owner_company_name ?? "—"}
        </div>
        {brand.resolved_owner_domain && (
          <a
            href={`https://${brand.resolved_owner_domain}`}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-[#7dd3fc] hover:underline"
          >
            {brand.resolved_owner_domain}
          </a>
        )}
        <div className="text-xs text-[var(--text-muted)] mt-1">
          {brand.resolved_owner_type ?? "unknown"}
          {brand.owner_resolved_at
            ? ` · resolved ${fmtTime(brand.owner_resolved_at)}`
            : ""}
        </div>
        {brand.owner_resolution_notes && (
          <div className="mt-3 text-sm whitespace-pre-wrap">
            {brand.owner_resolution_notes}
          </div>
        )}
      </div>
      <button
        type="button"
        className="btn btn-ghost text-sm"
        onClick={onRerun}
        disabled={triggerBusy}
      >
        {triggerBusy ? "Re-running…" : "Re-run resolver"}
      </button>
    </div>
  );
}

function FailedView({
  brand,
  triggerBusy,
  onRerun,
}: {
  brand: BrandOwnerBrand;
  triggerBusy: boolean;
  onRerun: () => void;
}) {
  return (
    <div
      className="p-3 rounded border flex items-start justify-between gap-3 flex-wrap"
      style={{
        background: "#2a1415",
        borderColor: "#4a1e21",
        color: "#f87171",
      }}
    >
      <div className="flex-1 min-w-[260px]">
        <div className="text-sm font-medium">Resolver did not produce a match</div>
        <div className="text-xs mt-1">
          {brand.owner_resolution_error ?? "No candidates were accepted."}
        </div>
        {brand.owner_resolution_notes && (
          <div className="mt-2 text-xs text-[var(--text-muted)] whitespace-pre-wrap">
            {brand.owner_resolution_notes}
          </div>
        )}
      </div>
      <button
        type="button"
        className="btn btn-primary text-sm"
        onClick={onRerun}
        disabled={triggerBusy}
      >
        {triggerBusy ? "Trying…" : "Try again"}
      </button>
    </div>
  );
}
