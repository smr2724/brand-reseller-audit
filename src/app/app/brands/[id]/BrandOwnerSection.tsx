"use client";

/**
 * Phase 33.1 / 34 — Brand Owner Resolver section, rendered at the top of
 * the user-facing brand page (/app/brands/[id]).
 *
 * Phase 34: candidates are Apollo-matched (or apollo_no_match) — the user
 * picks an actual Apollo organization with a contact count, not a raw
 * search hit. The old 13-row web-search list is hidden.
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
  // Phase 34 — Apollo + extractor fields.
  apollo_organization_id?: string | null;
  apollo_organization_name?: string | null;
  apollo_domain?: string | null;
  apollo_employee_count?: number | null;
  apollo_total_contacts?: number | null;
  apollo_hq_city?: string | null;
  apollo_hq_country?: string | null;
  apollo_industry?: string | null;
  extractor_confidence?: number | null;
  extractor_reasoning?: string | null;
  evidence_urls?: string[] | null;
  // Phase 34.1 — manual Apollo override marker.
  is_manual_apollo?: boolean | null;
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

function formatNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US");
}

function formatLocation(c: BrandOwnerCandidate): string | null {
  const city = c.apollo_hq_city ?? null;
  const country = c.apollo_hq_country ?? null;
  if (city && country) return `${city}, ${country}`;
  return city ?? country ?? null;
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
  const [manualQuery, setManualQuery] = useState<string>("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualMsg, setManualMsg] = useState<string | null>(null);

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

  // Phase 34 — only show Apollo / apollo_no_match candidates. Older raw
  // candidates from a pre-Phase-34 run still render at the bottom for
  // back-compat, but we collapse them.
  const { apolloMatches, manualMatches, noMatches, legacyHits } = useMemo(() => {
    const apolloMatches: BrandOwnerCandidate[] = [];
    const manualMatches: BrandOwnerCandidate[] = [];
    const noMatches: BrandOwnerCandidate[] = [];
    const legacyHits: BrandOwnerCandidate[] = [];
    for (const c of candidates) {
      if (c.candidate_source === "apollo_manual") manualMatches.push(c);
      else if (c.candidate_source === "apollo") apolloMatches.push(c);
      else if (c.candidate_source === "apollo_no_match") noMatches.push(c);
      else legacyHits.push(c);
    }
    const byContacts = (a: BrandOwnerCandidate, b: BrandOwnerCandidate) => {
      const ac = a.apollo_total_contacts ?? -1;
      const bc = b.apollo_total_contacts ?? -1;
      if (bc !== ac) return bc - ac;
      const af = a.extractor_confidence ?? 0;
      const bf = b.extractor_confidence ?? 0;
      return bf - af;
    };
    apolloMatches.sort(byContacts);
    manualMatches.sort(byContacts);
    noMatches.sort(
      (a, b) => (b.extractor_confidence ?? 0) - (a.extractor_confidence ?? 0),
    );
    return { apolloMatches, manualMatches, noMatches, legacyHits };
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
      const matches = Number(result.apollo_match_count ?? 0);
      const noMatch = Number(result.apollo_no_match_count ?? 0);
      const haveCounts = result.apollo_match_count != null;
      setStatusMsg(
        haveCounts
          ? `Resolver run complete — ${matches} Apollo matches, ${noMatch} no-match`
          : `Resolver run complete — ${String(result.candidates_count ?? 0)} candidates inserted`,
      );
      router.refresh();
    } else {
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

  const refreshCandidates = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/owner-resolver/candidates?brand_id=${encodeURIComponent(brand.id)}`,
        { credentials: "include", cache: "no-store" },
      );
      if (!res.ok) return;
      const json = (await res.json()) as {
        brand: BrandOwnerBrand;
        run: BrandOwnerRun | null;
        candidates: BrandOwnerCandidate[];
      };
      setBrand(json.brand);
      setRun(json.run);
      setCandidates(json.candidates ?? []);
    } catch {
      // soft-fail — manual search already showed its own status
    }
  }, [brand.id]);

  const onManualApolloSearch = useCallback(async () => {
    const q = manualQuery.trim();
    if (q.length === 0) {
      setManualMsg("Enter a company name first.");
      return;
    }
    setManualBusy(true);
    setManualMsg(null);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/owner-resolver/manual-apollo-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ brand_id: brand.id, company_name: q }),
      });
      const json = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!res.ok) {
        if (res.status === 429) {
          const retry = Number(json.retry_after_seconds ?? 0);
          setManualMsg(
            retry > 0
              ? `Rate limit — try again in ~${retry}s.`
              : (typeof json.error === "string" ? json.error : "rate limit"),
          );
        } else {
          setManualMsg(
            typeof json.error === "string" ? json.error : `failed (${res.status})`,
          );
        }
        return;
      }
      const inserted = Number(json.inserted_count ?? 0);
      const noMatch = json.no_match === true;
      setManualMsg(
        noMatch
          ? `No Apollo match for "${q}" — recorded as no-match.`
          : `Inserted ${inserted} Apollo result(s) for "${q}".`,
      );
      setManualQuery("");
      await refreshCandidates();
    } catch (e) {
      setManualMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setManualBusy(false);
    }
  }, [brand.id, manualQuery, refreshCandidates]);

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
          apolloMatches={apolloMatches}
          manualMatches={manualMatches}
          noMatches={noMatches}
          legacyHits={legacyHits}
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
          manualQuery={manualQuery}
          onManualQueryChange={setManualQuery}
          manualBusy={manualBusy}
          manualMsg={manualMsg}
          onManualSearch={onManualApolloSearch}
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
        <>
          <FailedView
            brand={brand}
            triggerBusy={triggerBusy}
            onRerun={onTrigger}
          />
          <ManualApolloSearchBlock
            manualQuery={manualQuery}
            onManualQueryChange={setManualQuery}
            manualBusy={manualBusy}
            manualMsg={manualMsg}
            onManualSearch={onManualApolloSearch}
          />
        </>
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
          Searching trademark records and the web, then reasoning through the
          owning company and looking it up in Apollo…
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

function ApolloCard({
  c,
  picked,
  expanded,
  onToggleSelected,
  onToggleExpanded,
}: {
  c: BrandOwnerCandidate;
  picked: boolean;
  expanded: boolean;
  onToggleSelected: (id: string) => void;
  onToggleExpanded: (id: string) => void;
}) {
  const sublineParts: string[] = [];
  if (c.apollo_industry) sublineParts.push(c.apollo_industry);
  const loc = formatLocation(c);
  if (loc) sublineParts.push(loc);
  if (c.apollo_employee_count != null) {
    sublineParts.push(`${formatNumber(c.apollo_employee_count)} employees`);
  }
  return (
    <div
      className={`rounded border p-3 mb-2 ${
        c.is_selected_owner ? "border-l-4 border-l-[#4ade80]" : ""
      }`}
      style={{
        background: "var(--bg-2)",
        borderColor: "var(--border-soft)",
      }}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={picked}
          onChange={() => onToggleSelected(c.id)}
          className="mt-1"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-semibold text-base">
              {c.apollo_organization_name ?? c.candidate_company_name}
            </span>
            {c.apollo_domain && (
              <a
                href={`https://${c.apollo_domain}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-[#7dd3fc] hover:underline"
              >
                {c.apollo_domain}
              </a>
            )}
          </div>
          {sublineParts.length > 0 && (
            <div className="text-xs text-[var(--text-muted)] mt-1">
              {sublineParts.join(" · ")}
            </div>
          )}
          <button
            type="button"
            onClick={() => onToggleExpanded(c.id)}
            className="text-xs text-[#7dd3fc] hover:underline mt-2"
          >
            {expanded ? "Hide why this match" : "Why this match"}
          </button>
          {expanded && (
            <div className="mt-2 text-xs">
              {c.extractor_reasoning && (
                <div className="text-[var(--text-muted)] whitespace-pre-wrap">
                  {c.extractor_reasoning}
                </div>
              )}
              {c.extractor_confidence != null && (
                <div className="text-[var(--text-muted)] mt-1">
                  Confidence: {(c.extractor_confidence * 100).toFixed(0)}%
                </div>
              )}
              {Array.isArray(c.evidence_urls) && c.evidence_urls.length > 0 && (
                <ul className="list-disc pl-5 mt-1">
                  {c.evidence_urls.slice(0, 5).map((u) => (
                    <li key={u}>
                      <a
                        href={u}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[#7dd3fc] hover:underline break-all"
                      >
                        {u}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div
            className="inline-flex items-center px-2 py-1 rounded border text-xs font-medium"
            style={{
              background: "#102a14",
              borderColor: "#1e4a28",
              color: "#4ade80",
            }}
          >
            {formatNumber(c.apollo_total_contacts)} contacts
          </div>
        </div>
      </div>
    </div>
  );
}

function NoMatchCard({
  c,
  picked,
  expanded,
  onToggleSelected,
  onToggleExpanded,
}: {
  c: BrandOwnerCandidate;
  picked: boolean;
  expanded: boolean;
  onToggleSelected: (id: string) => void;
  onToggleExpanded: (id: string) => void;
}) {
  return (
    <div
      className={`rounded border p-3 mb-2 ${
        c.is_selected_owner ? "border-l-4 border-l-[#4ade80]" : ""
      }`}
      style={{
        background: "var(--bg-3)",
        borderColor: "var(--border-soft)",
        opacity: 0.85,
      }}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={picked}
          onChange={() => onToggleSelected(c.id)}
          className="mt-1 opacity-70"
        />
        <div className="flex-1 min-w-0">
          <div className="italic text-[var(--text-muted)] font-medium">
            {c.candidate_company_name}
            {c.candidate_domain && (
              <span className="ml-2 text-xs not-italic">
                <a
                  href={`https://${c.candidate_domain}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[#7dd3fc] hover:underline"
                >
                  {c.candidate_domain}
                </a>
              </span>
            )}
          </div>
          <div className="text-xs text-[var(--text-muted)] mt-1">
            No Apollo match
            {c.extractor_reasoning ? ` — ${c.extractor_reasoning}` : ""}
          </div>
          {Array.isArray(c.evidence_urls) && c.evidence_urls.length > 0 && (
            <button
              type="button"
              onClick={() => onToggleExpanded(c.id)}
              className="text-xs text-[#7dd3fc] hover:underline mt-2"
            >
              {expanded ? "Hide evidence" : "Show evidence"}
            </button>
          )}
          {expanded &&
            Array.isArray(c.evidence_urls) &&
            c.evidence_urls.length > 0 && (
              <ul className="list-disc pl-5 mt-1 text-xs">
                {c.evidence_urls.slice(0, 5).map((u) => (
                  <li key={u}>
                    <a
                      href={u}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[#7dd3fc] hover:underline break-all"
                    >
                      {u}
                    </a>
                  </li>
                ))}
              </ul>
            )}
        </div>
      </div>
    </div>
  );
}

function CandidatesView({
  apolloMatches,
  manualMatches,
  noMatches,
  legacyHits,
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
  manualQuery,
  onManualQueryChange,
  manualBusy,
  manualMsg,
  onManualSearch,
}: {
  apolloMatches: BrandOwnerCandidate[];
  manualMatches: BrandOwnerCandidate[];
  noMatches: BrandOwnerCandidate[];
  legacyHits: BrandOwnerCandidate[];
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
  manualQuery: string;
  onManualQueryChange: (v: string) => void;
  manualBusy: boolean;
  manualMsg: string | null;
  onManualSearch: () => void;
}) {
  const selectedCount = selectedIds.size;
  const totalShown =
    apolloMatches.length + manualMatches.length + noMatches.length;

  return (
    <div>
      {totalShown === 0 && legacyHits.length === 0 ? (
        <div className="text-sm text-[var(--text-muted)] py-4">
          The resolver finished but no candidates were inserted. You can re-run
          it or mark this brand as needing manual research.
        </div>
      ) : (
        <>
          {apolloMatches.length > 0 && (
            <div className="mb-4">
              <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">
                Apollo matches ({apolloMatches.length})
              </div>
              {apolloMatches.map((c) => (
                <ApolloCard
                  key={c.id}
                  c={c}
                  picked={selectedIds.has(c.id)}
                  expanded={expanded.has(c.id)}
                  onToggleSelected={onToggleSelected}
                  onToggleExpanded={onToggleExpanded}
                />
              ))}
            </div>
          )}

          {manualMatches.length > 0 && (
            <div className="mb-4">
              <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">
                Manual Apollo searches ({manualMatches.length})
              </div>
              {manualMatches.map((c) => (
                <ApolloCard
                  key={c.id}
                  c={c}
                  picked={selectedIds.has(c.id)}
                  expanded={expanded.has(c.id)}
                  onToggleSelected={onToggleSelected}
                  onToggleExpanded={onToggleExpanded}
                />
              ))}
            </div>
          )}

          {noMatches.length > 0 && (
            <div className="mb-4">
              <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">
                No Apollo match ({noMatches.length})
              </div>
              {noMatches.map((c) => (
                <NoMatchCard
                  key={c.id}
                  c={c}
                  picked={selectedIds.has(c.id)}
                  expanded={expanded.has(c.id)}
                  onToggleSelected={onToggleSelected}
                  onToggleExpanded={onToggleExpanded}
                />
              ))}
            </div>
          )}

          {/* Legacy raw hits from pre-Phase-34 runs are intentionally hidden;
              they live in the database but are noise compared to Apollo. */}
        </>
      )}

      <ManualApolloSearchBlock
        manualQuery={manualQuery}
        onManualQueryChange={onManualQueryChange}
        manualBusy={manualBusy}
        manualMsg={manualMsg}
        onManualSearch={onManualSearch}
      />

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

function ManualApolloSearchBlock({
  manualQuery,
  onManualQueryChange,
  manualBusy,
  manualMsg,
  onManualSearch,
}: {
  manualQuery: string;
  onManualQueryChange: (v: string) => void;
  manualBusy: boolean;
  manualMsg: string | null;
  onManualSearch: () => void;
}) {
  return (
    <div
      className="mt-4 p-3 rounded border"
      style={{
        background: "var(--bg-2)",
        borderColor: "var(--border-soft)",
      }}
    >
      <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">
        Search Apollo for a specific company
      </div>
      <div className="text-xs text-[var(--text-muted)] mb-2">
        Don&apos;t see the right owner? Type a company name and we&apos;ll add
        the matching Apollo organization(s) above.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={manualQuery}
          onChange={(e) => onManualQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onManualSearch();
            }
          }}
          placeholder="e.g. Diversified Hospitality Solutions"
          className="input flex-1 min-w-[220px]"
          disabled={manualBusy}
        />
        <button
          type="button"
          className="btn btn-primary text-sm"
          onClick={onManualSearch}
          disabled={manualBusy || manualQuery.trim().length === 0}
        >
          {manualBusy ? "Searching…" : "Search"}
        </button>
      </div>
      {manualMsg && (
        <div className="text-xs text-[var(--text-muted)] mt-2">{manualMsg}</div>
      )}
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
