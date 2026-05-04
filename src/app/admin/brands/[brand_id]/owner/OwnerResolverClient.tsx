"use client";

/**
 * Phase 33 — Brand Owner Resolver review UI (client component).
 *
 * Lets the admin reviewer:
 *   - inspect candidate owners ranked by deterministic heuristic_score
 *   - select one or many as the resolved owner(s) of the brand
 *   - mark "none of these — manual research needed" (B3 reject route)
 *   - save free-text notes
 *   - rerun the resolver
 *
 * Auth (B4 fix): no bearer prompt, no localStorage. The browser is
 * authenticated via the user's Supabase session cookies; the API routes
 * verify `brands.user_id = current_user.id` before any read or write.
 */
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

export interface BrandRow {
  id: string;
  name: string;
  category: string | null;
  owner_resolution_state: string;
  owner_resolution_error: string | null;
  owner_resolved_at: string | null;
  resolved_owner_company_name: string | null;
  resolved_owner_domain: string | null;
  resolved_owner_type: string | null;
  owner_resolution_notes: string | null;
}

export interface RunRow {
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

export interface CandidateRow {
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

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function stateBadgeClass(state: string): string {
  switch (state) {
    case "selected":
      return "bg-emerald-100 text-emerald-800 border-emerald-300";
    case "candidates_ready":
      return "bg-sky-100 text-sky-800 border-sky-300";
    case "running":
      return "bg-amber-100 text-amber-800 border-amber-300";
    case "failed":
      return "bg-rose-100 text-rose-800 border-rose-300";
    default:
      return "bg-zinc-100 text-zinc-800 border-zinc-300";
  }
}

function labelBadgeClass(label: string): string {
  switch (label) {
    case "very_high":
      return "bg-emerald-100 text-emerald-800 border-emerald-300";
    case "high":
      return "bg-sky-100 text-sky-800 border-sky-300";
    case "medium":
      return "bg-amber-100 text-amber-800 border-amber-300";
    case "needs_review":
      return "bg-rose-100 text-rose-800 border-rose-300";
    default:
      return "bg-zinc-100 text-zinc-800 border-zinc-300";
  }
}

export default function OwnerResolverClient({
  brand,
  asinCount,
  run,
  candidates,
}: {
  brand: BrandRow;
  asinCount: number;
  run: RunRow | null;
  candidates: CandidateRow[];
}) {
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    const ids = new Set<string>();
    for (const c of candidates) if (c.is_selected_owner) ids.add(c.id);
    return ids;
  });
  const [ownerType, setOwnerType] = useState<string>(
    brand.resolved_owner_type ?? "manufacturer",
  );
  const [notes, setNotes] = useState<string>(brand.owner_resolution_notes ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const selectedCount = selectedIds.size;

  const sortedCandidates = useMemo(() => {
    return [...candidates].sort((a, b) => {
      if (b.heuristic_score !== a.heuristic_score) {
        return b.heuristic_score - a.heuristic_score;
      }
      return a.created_at < b.created_at ? 1 : -1;
    });
  }, [candidates]);

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

  const callApi = useCallback(
    async (path: string, body: unknown, method: "POST" | "GET" = "POST") => {
      setBusy(path);
      setErrorMsg(null);
      setStatusMsg(null);
      try {
        const res = await fetch(path, {
          method,
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: method === "POST" ? JSON.stringify(body) : undefined,
        });
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
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

  const onTrigger = useCallback(async () => {
    const result = await callApi("/api/owner-resolver/trigger", {
      brand_id: brand.id,
    });
    if (result) {
      setStatusMsg(
        `Resolver run complete — ${String(result.candidates_count ?? 0)} candidates inserted`,
      );
      router.refresh();
    }
  }, [brand.id, callApi, router]);

  const onSaveSelection = useCallback(async () => {
    if (selectedCount === 0) {
      setErrorMsg("Pick at least one candidate first");
      return;
    }
    const result = await callApi("/api/owner-resolver/select", {
      brand_id: brand.id,
      candidate_ids: Array.from(selectedIds),
      resolved_owner_type: ownerType,
    });
    if (result) {
      setStatusMsg(`Selection saved — ${String(result.selected_count ?? 0)} owner(s)`);
      router.refresh();
    }
  }, [brand.id, callApi, ownerType, router, selectedCount, selectedIds]);

  const onSaveNotes = useCallback(async () => {
    const result = await callApi("/api/owner-resolver/notes", {
      brand_id: brand.id,
      notes,
    });
    if (result) setStatusMsg("Notes saved");
  }, [brand.id, callApi, notes]);

  const onMarkNone = useCallback(async () => {
    const ok = window.confirm(
      "Mark this brand as 'none of these — manual research needed'? This sets the resolution state to 'failed' and clears any selection.",
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

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold">Brand Owner Resolver</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            <span className="font-medium">{brand.name}</span>
            {brand.category ? ` · ${brand.category}` : ""}
            {` · ${asinCount} ASIN${asinCount === 1 ? "" : "s"}`}
          </p>
        </div>
        <span
          className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${stateBadgeClass(brand.owner_resolution_state)}`}
        >
          {brand.owner_resolution_state}
        </span>
      </div>

      <div className="rounded-lg border border-zinc-200 p-4 mb-4 bg-white">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium">Latest run</div>
            {run ? (
              <div className="text-xs text-[var(--text-muted)] mt-1 space-y-0.5">
                <div>
                  <span className="font-medium">Triggered:</span> {run.triggered_by}
                </div>
                <div>
                  <span className="font-medium">Started:</span> {fmtTime(run.started_at)}
                </div>
                <div>
                  <span className="font-medium">Completed:</span>{" "}
                  {fmtTime(run.completed_at)}
                </div>
                <div>
                  <span className="font-medium">Status:</span> {run.status}
                </div>
                <div>
                  <span className="font-medium">Candidates inserted:</span>{" "}
                  {run.candidates_inserted}
                </div>
                {run.uspto_results_count != null ? (
                  <div>
                    <span className="font-medium">USPTO results:</span>{" "}
                    {run.uspto_results_count}
                  </div>
                ) : null}
                {run.web_search_results_count != null ? (
                  <div>
                    <span className="font-medium">Web results:</span>{" "}
                    {run.web_search_results_count}
                  </div>
                ) : null}
                {run.error_message ? (
                  <div className="text-rose-700">
                    <span className="font-medium">Error:</span> {run.error_message}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="text-xs text-[var(--text-muted)] mt-1">
                No runs yet. Click "Run resolver" to start.
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onTrigger}
            disabled={busy != null}
            className="px-3 py-1.5 rounded-md bg-zinc-900 text-white text-sm hover:bg-zinc-800 disabled:opacity-50"
          >
            {busy === "/api/owner-resolver/trigger"
              ? "Running…"
              : run
                ? "Rerun resolver"
                : "Run resolver"}
          </button>
        </div>
      </div>

      {statusMsg ? (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 text-emerald-900 text-sm px-3 py-2 mb-3">
          {statusMsg}
        </div>
      ) : null}
      {errorMsg ? (
        <div className="rounded-md border border-rose-300 bg-rose-50 text-rose-900 text-sm px-3 py-2 mb-3">
          {errorMsg}
        </div>
      ) : null}

      <div className="rounded-lg border border-zinc-200 bg-white overflow-hidden mb-4">
        <table className="min-w-full text-sm">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-600">
            <tr>
              <th className="px-3 py-2 text-left w-8">Pick</th>
              <th className="px-3 py-2 text-left">Candidate</th>
              <th className="px-3 py-2 text-left">Source</th>
              <th className="px-3 py-2 text-left">Score</th>
              <th className="px-3 py-2 text-left">TM status</th>
              <th className="px-3 py-2 text-left">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {sortedCandidates.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-6 text-center text-[var(--text-muted)]"
                >
                  No candidates yet. Run the resolver to gather them.
                </td>
              </tr>
            ) : (
              sortedCandidates.map((c) => {
                const isPicked = selectedIds.has(c.id);
                const wasSelected = c.is_selected_owner;
                return (
                  <tr
                    key={c.id}
                    className={`border-t border-zinc-100 ${
                      wasSelected ? "border-l-4 border-l-emerald-500" : ""
                    }`}
                  >
                    <td className="px-3 py-2 align-top">
                      <input
                        type="checkbox"
                        checked={isPicked}
                        onChange={() => toggleSelected(c.id)}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium">{c.candidate_company_name}</div>
                      {c.candidate_domain ? (
                        <a
                          href={`https://${c.candidate_domain}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-sky-700 hover:underline"
                        >
                          {c.candidate_domain}
                        </a>
                      ) : (
                        <div className="text-xs text-[var(--text-muted)]">
                          (no domain)
                        </div>
                      )}
                      {c.match_reason ? (
                        <div className="text-xs text-[var(--text-muted)] mt-1">
                          {c.match_reason}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs border bg-zinc-50">
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
                          {c.trademark_serial_number ? (
                            <div className="text-[var(--text-muted)]">
                              SN {c.trademark_serial_number}
                            </div>
                          ) : null}
                          {c.trademark_registration_date ? (
                            <div className="text-[var(--text-muted)]">
                              Reg. {c.trademark_registration_date}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top text-xs max-w-[420px]">
                      {c.evidence_text ? (
                        <button
                          type="button"
                          onClick={() => toggleExpanded(c.id)}
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
                      ) : null}
                      {c.evidence_url ? (
                        <div className="mt-1">
                          <a
                            href={c.evidence_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sky-700 hover:underline"
                          >
                            source ↗
                          </a>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 mb-4">
        <div className="text-sm font-medium mb-2">Notes</div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={onSaveNotes}
          rows={4}
          className="w-full rounded border border-zinc-300 p-2 text-sm"
          placeholder="Notes about why you picked these owners, what to look at next, etc. Saves on blur."
        />
      </div>

      <div className="sticky bottom-0 -mx-6 px-6 py-3 bg-white border-t border-zinc-200 flex flex-wrap items-center gap-3">
        <div className="text-sm">
          <span className="font-medium">{selectedCount}</span> selected
        </div>
        <label className="text-sm flex items-center gap-2">
          Owner type
          <select
            value={ownerType}
            onChange={(e) => setOwnerType(e.target.value)}
            className="rounded border border-zinc-300 px-2 py-1 text-sm"
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
          onClick={onSaveSelection}
          disabled={busy != null || selectedCount === 0}
          className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-sm hover:bg-emerald-500 disabled:opacity-50"
        >
          Save selection
        </button>
        <button
          type="button"
          onClick={onMarkNone}
          disabled={busy != null}
          className="px-3 py-1.5 rounded-md border border-zinc-300 text-sm hover:bg-zinc-50 disabled:opacity-50"
        >
          None of these — manual research
        </button>
      </div>
    </div>
  );
}
