"use client";

/**
 * Phase 33.1 / 34 / 34.2 — Brand Owner Resolver section, rendered at the
 * top of the user-facing brand page (/app/brands/[id]).
 *
 * Phase 34.2: a transparency checkpoint sits between the extractor and
 * Apollo. When the brand is in `awaiting_apollo_selection` we render the
 * extractor candidates with checkboxes + a free-text "add another
 * candidate" form + "Look up selected" / "Pick for me" buttons. Apollo
 * fires only when the user clicks one of those.
 *
 * The polling effect now also watches for the `enriching_apollo` state
 * (Apollo running in the background) and clears any stale errorMsg the
 * moment the brand state transitions away from `running` so the red
 * "Load failed" banner can't stick around after a fetch was aborted by
 * router.refresh().
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import type { EvidenceSummary } from "@/lib/owner-resolver/evidence";

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
  // Phase 34.2 — transparency checkpoint fields.
  derived_from_candidate_id?: string | null;
  apollo_search_attempted_at?: string | null;
  // Phase 34.3 — `raw_payload.apollo_source` (`crm` | `public`) lets the
  // UI render the right "Your Apollo CRM" / "Apollo Public" badge.
  raw_payload?: Record<string, unknown> | null;
}

/**
 * Phase 34.3 — Read `raw_payload.apollo_source` ("crm" | "public") off
 * a candidate. Returns null for non-Apollo rows or pre-34.3 rows that
 * never had the field set.
 */
function getApolloSource(c: BrandOwnerCandidate): "crm" | "public" | null {
  const rp = c.raw_payload;
  if (!rp || typeof rp !== "object") return null;
  const v = (rp as Record<string, unknown>).apollo_source;
  if (v === "crm" || v === "public") return v;
  return null;
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
  evidence: initialEvidence = null,
}: {
  brand: BrandOwnerBrand;
  run: BrandOwnerRun | null;
  candidates: BrandOwnerCandidate[];
  evidence?: EvidenceSummary | null;
}) {
  const router = useRouter();
  const [brand, setBrand] = useState(initialBrand);
  const [run, setRun] = useState<BrandOwnerRun | null>(initialRun);
  const [candidates, setCandidates] =
    useState<BrandOwnerCandidate[]>(initialCandidates);
  const [evidence, setEvidence] = useState<EvidenceSummary | null>(
    initialEvidence,
  );
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

  // Phase 34.2 — transparency checkpoint state. Selection of which
  // extractor candidates to forward to Apollo + a free-text "add another"
  // form.
  const [checkpointSelected, setCheckpointSelected] = useState<Set<string>>(
    new Set(),
  );
  const [extractorAddName, setExtractorAddName] = useState<string>("");
  const [extractorAddDomain, setExtractorAddDomain] = useState<string>("");
  const [extractorAddBusy, setExtractorAddBusy] = useState(false);
  const [extractorAddMsg, setExtractorAddMsg] = useState<string | null>(null);

  useEffect(() => {
    setBrand(initialBrand);
    setRun(initialRun);
    setCandidates(initialCandidates);
    setEvidence(initialEvidence);
    setOwnerType(initialBrand.resolved_owner_type ?? "manufacturer");
    setNotes(initialBrand.owner_resolution_notes ?? "");
    const ids = new Set<string>();
    for (const c of initialCandidates) if (c.is_selected_owner) ids.add(c.id);
    setSelectedIds(ids);
  }, [initialBrand, initialRun, initialCandidates, initialEvidence]);

  const pollCountRef = useRef(0);

  // Phase 34.2 — poll while the resolver is doing work in the background.
  // `running` covers Phase 1 (USPTO + web + extractor). `enriching_apollo`
  // covers Phase 2 (Apollo). Once we leave either state we clear the
  // `errorMsg` (which can otherwise carry a stale "Load failed" from a
  // fetch that got aborted by router.refresh()) and refresh the page.
  const isPolling =
    brand.owner_resolution_state === "running" ||
    brand.owner_resolution_state === "enriching_apollo";

  useEffect(() => {
    if (!isPolling) {
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
          evidence?: EvidenceSummary | null;
        };
        if (cancelled) return;
        setBrand(json.brand);
        setRun(json.run);
        setCandidates(json.candidates ?? []);
        setEvidence(json.evidence ?? null);
        const nextState = json.brand.owner_resolution_state;
        if (nextState !== "running" && nextState !== "enriching_apollo") {
          // Clear any stale "Load failed" left over from an aborted
          // trigger fetch — at this point we have fresh data so the
          // banner is misleading.
          setErrorMsg(null);
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
  }, [brand.id, isPolling, router]);

  // Belt-and-suspenders: any time the brand state moves out of `running` /
  // `enriching_apollo`, clear an error banner left over from the trigger
  // request that may have been aborted while the work continued
  // server-side. (router.refresh() can abort the in-flight fetch which
  // surfaces as "TypeError: Load failed" on Safari.)
  //
  // Phase 34.3 — also clear the green "Looking up X candidates..."
  // status banner the moment we leave `enriching_apollo`. Previously
  // this banner stuck around into `candidates_ready` and rendered
  // alongside the empty-state message, confusing the user.
  useEffect(() => {
    if (
      brand.owner_resolution_state !== "running" &&
      brand.owner_resolution_state !== "enriching_apollo"
    ) {
      setErrorMsg((prev) =>
        prev && /load failed|fetch|aborted/i.test(prev) ? null : prev,
      );
      setStatusMsg((prev) =>
        prev && /looking up|searching|enriching/i.test(prev) ? null : prev,
      );
    }
  }, [brand.owner_resolution_state]);

  // Phase 34 / 34.2 — bucket candidates by source. Extractor rows appear
  // at the transparency checkpoint; apollo / apollo_manual rows after.
  const {
    apolloMatches,
    manualMatches,
    noMatches,
    legacyHits,
    extractorCandidates,
  } = useMemo(() => {
    const apolloMatches: BrandOwnerCandidate[] = [];
    const manualMatches: BrandOwnerCandidate[] = [];
    const noMatches: BrandOwnerCandidate[] = [];
    const legacyHits: BrandOwnerCandidate[] = [];
    const extractorCandidates: BrandOwnerCandidate[] = [];
    for (const c of candidates) {
      // Phase 34.4 — `apollo_crm` and `apollo_manual_crm` rows are the
      // CRM (`accounts/search`) variants of the same records that come
      // back from `mixed_companies/search`. They classify into the same
      // buckets as their public counterparts; the UI badge is keyed off
      // `raw_payload.apollo_source`, not `candidate_source`.
      if (
        c.candidate_source === "apollo_manual" ||
        c.candidate_source === "apollo_manual_crm"
      )
        manualMatches.push(c);
      else if (
        c.candidate_source === "apollo" ||
        c.candidate_source === "apollo_crm"
      )
        apolloMatches.push(c);
      else if (c.candidate_source === "apollo_no_match") noMatches.push(c);
      else if (
        c.candidate_source === "extractor" ||
        c.candidate_source === "extractor_manual"
      )
        extractorCandidates.push(c);
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
    extractorCandidates.sort((a, b) => {
      // extractor_manual rows always first (user-added), then by confidence.
      const am = a.candidate_source === "extractor_manual" ? 1 : 0;
      const bm = b.candidate_source === "extractor_manual" ? 1 : 0;
      if (am !== bm) return bm - am;
      return (b.extractor_confidence ?? 0) - (a.extractor_confidence ?? 0);
    });
    return { apolloMatches, manualMatches, noMatches, legacyHits, extractorCandidates };
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

  // Phase 34.6 — Reset resolver button. Clears candidates, marks any
  // non-terminal runs failed, and flips the brand back to `pending` so
  // the user can rerun without manual SQL. Does NOT delete run rows;
  // audit history is preserved.
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const onResetResolver = useCallback(async () => {
    setResetBusy(true);
    setResetError(null);
    try {
      const res = await fetch(
        `/api/brands/${encodeURIComponent(brand.id)}/owner-resolver/reset`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        },
      );
      const json = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!res.ok || !json.ok) {
        const msg =
          typeof json.error === "string"
            ? json.error
            : `reset failed (${res.status})`;
        setResetError(msg);
        return;
      }
      // Optimistically clear local state and refetch so the UI returns
      // to the pending view immediately.
      setBrand((b) => ({
        ...b,
        owner_resolution_state: "pending",
        owner_resolution_error: null,
      }));
      setCandidates([]);
      setSelectedIds(new Set());
      setCheckpointSelected(new Set());
      setStatusMsg(null);
      setErrorMsg(null);
      try {
        const refresh = await fetch(
          `/api/owner-resolver/candidates?brand_id=${encodeURIComponent(brand.id)}`,
          { credentials: "include", cache: "no-store" },
        );
        if (refresh.ok) {
          const fresh = (await refresh.json()) as {
            brand: BrandOwnerBrand;
            run: BrandOwnerRun | null;
            candidates: BrandOwnerCandidate[];
            evidence?: EvidenceSummary | null;
          };
          setBrand(fresh.brand);
          setRun(fresh.run);
          setCandidates(fresh.candidates ?? []);
          setEvidence(fresh.evidence ?? null);
        }
      } catch {
        // ignore — the optimistic state above is already correct.
      }
      router.refresh();
    } catch (e) {
      setResetError(e instanceof Error ? e.message : String(e));
    } finally {
      setResetBusy(false);
    }
  }, [brand.id, router]);

  const onTrigger = useCallback(async () => {
    optimisticToRunning();
    const result = await callApi("/api/owner-resolver/trigger", {
      brand_id: brand.id,
    });
    if (result) {
      const extractorCount = Number(result.extractor_candidate_count ?? 0);
      const state = String(result.state ?? "");
      if (state === "awaiting_apollo_selection") {
        setStatusMsg(
          `Found ${extractorCount} candidate${extractorCount === 1 ? "" : "s"} — review below and pick which to look up in Apollo.`,
        );
      } else {
        setStatusMsg(
          `Resolver run complete — ${String(result.candidates_count ?? 0)} candidates inserted`,
        );
      }
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
        evidence?: EvidenceSummary | null;
      };
      setBrand(json.brand);
      setRun(json.run);
      setCandidates(json.candidates ?? []);
      setEvidence(json.evidence ?? null);
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

  const toggleCheckpointSelected = useCallback((id: string) => {
    setCheckpointSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onAddExtractorCandidate = useCallback(async () => {
    const name = extractorAddName.trim();
    if (name.length === 0) {
      setExtractorAddMsg("Enter a company name first.");
      return;
    }
    setExtractorAddBusy(true);
    setExtractorAddMsg(null);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/owner-resolver/add-extractor-candidate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          brand_id: brand.id,
          company_name: name,
          domain: extractorAddDomain.trim() || undefined,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setExtractorAddMsg(
          typeof json.error === "string" ? json.error : `failed (${res.status})`,
        );
        return;
      }
      const cand = json.candidate as BrandOwnerCandidate | undefined;
      if (cand?.id) {
        setCandidates((prev) => [...prev, cand]);
        setCheckpointSelected((prev) => {
          const next = new Set(prev);
          next.add(cand.id);
          return next;
        });
      }
      setExtractorAddName("");
      setExtractorAddDomain("");
      setExtractorAddMsg(`Added "${name}".`);
    } catch (e) {
      setExtractorAddMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setExtractorAddBusy(false);
    }
  }, [brand.id, extractorAddDomain, extractorAddName]);

  const optimisticToEnrichingApollo = useCallback(() => {
    setBrand((b) => ({
      ...b,
      owner_resolution_state: "enriching_apollo",
      owner_resolution_error: null,
    }));
  }, []);

  const onLookupSelectedInApollo = useCallback(
    async (allIds: string[]) => {
      const ids =
        allIds.length > 0
          ? allIds
          : Array.from(checkpointSelected);
      if (ids.length === 0) {
        setErrorMsg("Pick at least one candidate first.");
        return;
      }
      optimisticToEnrichingApollo();
      const result = await callApi("/api/owner-resolver/run-apollo", {
        brand_id: brand.id,
        candidate_ids: ids,
      });
      if (result) {
        setStatusMsg(
          `Looking up ${ids.length} candidate${ids.length === 1 ? "" : "s"} in Apollo…`,
        );
        setCheckpointSelected(new Set());
        router.refresh();
      } else {
        // Roll back optimistic state by polling.
        router.refresh();
      }
    },
    [
      brand.id,
      callApi,
      checkpointSelected,
      optimisticToEnrichingApollo,
      router,
    ],
  );

  const onPickForMe = useCallback(() => {
    const allIds = extractorCandidates.map((c) => c.id);
    void onLookupSelectedInApollo(allIds);
  }, [extractorCandidates, onLookupSelectedInApollo]);

  const onLookupChecked = useCallback(() => {
    void onLookupSelectedInApollo([]);
  }, [onLookupSelectedInApollo]);

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

      <EvidencePanel
        run={run}
        evidence={evidence}
        onReset={onResetResolver}
        resetBusy={resetBusy}
        resetError={resetError}
      />

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

      {state === "awaiting_apollo_selection" && (
        <CheckpointView
          extractorCandidates={extractorCandidates}
          checkpointSelected={checkpointSelected}
          expanded={expanded}
          onToggleSelected={toggleCheckpointSelected}
          onToggleExpanded={toggleExpanded}
          extractorAddName={extractorAddName}
          extractorAddDomain={extractorAddDomain}
          onExtractorAddNameChange={setExtractorAddName}
          onExtractorAddDomainChange={setExtractorAddDomain}
          extractorAddBusy={extractorAddBusy}
          extractorAddMsg={extractorAddMsg}
          onAddExtractorCandidate={onAddExtractorCandidate}
          onLookupChecked={onLookupChecked}
          onPickForMe={onPickForMe}
          onRerun={onTrigger}
          triggerBusy={triggerBusy}
          busy={busy}
        />
      )}

      {state === "enriching_apollo" && (
        <EnrichingApolloView
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
          extractorCandidates={extractorCandidates}
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

function ApolloSourceBadge({
  source,
}: {
  source: "crm" | "public" | null;
}) {
  if (source === "crm") {
    return (
      <span
        className="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium"
        style={{
          background: "#102a2a",
          borderColor: "#1e4a4a",
          color: "#5eead4",
        }}
        title="Found in your saved Apollo CRM accounts"
      >
        Your Apollo CRM
      </span>
    );
  }
  if (source === "public") {
    return (
      <span
        className="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium"
        style={{
          background: "#1a2233",
          borderColor: "#2c3a55",
          color: "#bcd0ee",
        }}
        title="Found in Apollo's public organizations directory"
      >
        Apollo Public
      </span>
    );
  }
  return null;
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
            <ApolloSourceBadge source={getApolloSource(c)} />
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
  extractorCandidates,
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
  extractorCandidates: BrandOwnerCandidate[];
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
  // Phase 34.3 — Surface the extractor rows that we attempted in Apollo
  // but got 0 hits, so the user can see "we tried 4 strategies, got
  // nothing — try the manual search below".
  const extractorAttempted = extractorCandidates.filter(
    (c) => c.apollo_search_attempted_at != null,
  );

  return (
    <div>
      {totalShown === 0 && legacyHits.length === 0 ? (
        <div
          className="p-3 rounded border text-sm mb-4"
          style={{
            background: "#1a1f2a",
            borderColor: "#2c3a55",
            color: "#bcd0ee",
          }}
        >
          <div className="font-medium mb-1">
            Apollo had no public listing or saved account for{" "}
            {extractorAttempted.length > 0
              ? extractorAttempted.length === 1
                ? `"${extractorAttempted[0]?.candidate_company_name ?? "this name"}"`
                : `these ${extractorAttempted.length} names`
              : "these names"}
            .
          </div>
          <div className="text-xs text-[var(--text-muted)]">
            We searched Apollo with 4 strategies (name+domain, domain
            only, cleaned name, and domain enrich) across both your CRM
            accounts and Apollo&apos;s public directory. Try the manual
            search below or revise your selection.
          </div>
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

function ExtractorCandidateCard({
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
  const conf = c.extractor_confidence;
  const isManual = c.candidate_source === "extractor_manual";
  const sublineParts: string[] = [];
  if (conf != null) sublineParts.push(`Confidence: ${conf.toFixed(2)}`);
  if (isManual) sublineParts.push("User-added");
  return (
    <div
      className="rounded border p-3 mb-2"
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
              {c.candidate_company_name}
            </span>
            {c.candidate_domain && (
              <a
                href={`https://${c.candidate_domain}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-[#7dd3fc] hover:underline"
              >
                {c.candidate_domain}
              </a>
            )}
          </div>
          {sublineParts.length > 0 && (
            <div className="text-xs text-[var(--text-muted)] mt-1">
              {sublineParts.join(" · ")}
            </div>
          )}
          {c.extractor_reasoning && (
            <div className="text-xs text-[var(--text-muted)] mt-1 whitespace-pre-wrap">
              {c.extractor_reasoning}
            </div>
          )}
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

function CheckpointView({
  extractorCandidates,
  checkpointSelected,
  expanded,
  onToggleSelected,
  onToggleExpanded,
  extractorAddName,
  extractorAddDomain,
  onExtractorAddNameChange,
  onExtractorAddDomainChange,
  extractorAddBusy,
  extractorAddMsg,
  onAddExtractorCandidate,
  onLookupChecked,
  onPickForMe,
  onRerun,
  triggerBusy,
  busy,
}: {
  extractorCandidates: BrandOwnerCandidate[];
  checkpointSelected: Set<string>;
  expanded: Set<string>;
  onToggleSelected: (id: string) => void;
  onToggleExpanded: (id: string) => void;
  extractorAddName: string;
  extractorAddDomain: string;
  onExtractorAddNameChange: (v: string) => void;
  onExtractorAddDomainChange: (v: string) => void;
  extractorAddBusy: boolean;
  extractorAddMsg: string | null;
  onAddExtractorCandidate: () => void;
  onLookupChecked: () => void;
  onPickForMe: () => void;
  onRerun: () => void;
  triggerBusy: boolean;
  busy: string | null;
}) {
  const apolloBusy = busy === "/api/owner-resolver/run-apollo";
  const checkedCount = checkpointSelected.size;
  return (
    <div>
      <div
        className="mb-3 p-3 rounded border text-sm"
        style={{
          background: "#1a2233",
          borderColor: "#2c3a55",
          color: "#bcd0ee",
        }}
      >
        <div className="font-medium mb-1">
          Extractor found these candidates — review and select which to look
          up in Apollo
        </div>
        <div className="text-xs text-[var(--text-muted)]">
          We searched USPTO and the web, then asked a reasoning model to
          extract the owning company. Pick which of these to look up in
          Apollo to attach contact counts and organization metadata.
        </div>
      </div>

      {extractorCandidates.length === 0 ? (
        <div className="text-sm text-[var(--text-muted)] py-4">
          No extractor candidates above the confidence threshold. You can add
          one below or re-run the resolver.
        </div>
      ) : (
        extractorCandidates.map((c) => (
          <ExtractorCandidateCard
            key={c.id}
            c={c}
            picked={checkpointSelected.has(c.id)}
            expanded={expanded.has(c.id)}
            onToggleSelected={onToggleSelected}
            onToggleExpanded={onToggleExpanded}
          />
        ))
      )}

      <div
        className="mt-4 p-3 rounded border"
        style={{
          background: "var(--bg-2)",
          borderColor: "var(--border-soft)",
        }}
      >
        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">
          Add another candidate
        </div>
        <div className="text-xs text-[var(--text-muted)] mb-2">
          Know the owner already? Type a company name (and optional domain).
          We&apos;ll add it to the list below pre-checked, ready to forward
          to Apollo.
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={extractorAddName}
            onChange={(e) => onExtractorAddNameChange(e.target.value)}
            placeholder="Company name"
            className="input flex-1 min-w-[200px]"
            disabled={extractorAddBusy}
          />
          <input
            type="text"
            value={extractorAddDomain}
            onChange={(e) => onExtractorAddDomainChange(e.target.value)}
            placeholder="Domain (optional)"
            className="input flex-1 min-w-[160px]"
            disabled={extractorAddBusy}
          />
          <button
            type="button"
            className="btn btn-ghost text-sm"
            onClick={onAddExtractorCandidate}
            disabled={extractorAddBusy || extractorAddName.trim().length === 0}
          >
            {extractorAddBusy ? "Adding…" : "+ Add"}
          </button>
        </div>
        {extractorAddMsg && (
          <div className="text-xs text-[var(--text-muted)] mt-2">
            {extractorAddMsg}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="text-sm">
          <span className="font-medium">{checkedCount}</span> selected
        </div>
        <button
          type="button"
          className="btn btn-primary text-sm"
          onClick={onLookupChecked}
          disabled={apolloBusy || checkedCount === 0}
        >
          {apolloBusy ? "Looking up…" : "Look up selected in Apollo"}
        </button>
        <button
          type="button"
          className="btn btn-ghost text-sm"
          onClick={onPickForMe}
          disabled={apolloBusy || extractorCandidates.length === 0}
        >
          Pick for me — look up all of them
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

function EnrichingApolloView({
  pollExhausted,
  onRefresh,
}: {
  pollExhausted: boolean;
  onRefresh: () => void;
}) {
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
          Looking up selected candidates in Apollo…
        </div>
        <div className="text-xs text-[var(--text-muted)] mt-1">
          {pollExhausted
            ? "Taking longer than expected — try refreshing."
            : "This usually takes a few seconds."}
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

/**
 * Phase 34.5 — Resolver evidence panel. Renders side-by-side USPTO and
 * Web Search outcome cards above the candidate flow so the user can see
 * exactly what each upstream returned (or how it failed) before working
 * the candidate list. Default-expanded `<details>`. Hidden entirely
 * when there is no run yet.
 */
function EvidencePanel({
  run,
  evidence,
  onReset,
  resetBusy,
  resetError,
}: {
  run: BrandOwnerRun | null;
  evidence: EvidenceSummary | null;
  onReset: () => void;
  resetBusy: boolean;
  resetError: string | null;
}) {
  if (!run || !evidence) return null;
  const status = run.status;
  if (!status || status === "pending") return null;

  return (
    <details
      open
      className="mb-4 rounded-xl border border-slate-700/60 bg-slate-900/40 p-3"
    >
      <summary className="flex cursor-pointer select-none items-center justify-between gap-3 text-xs uppercase tracking-wide text-[var(--text-muted)]">
        <span>Resolver evidence</span>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              // Prevent the surrounding <details> from toggling when the
              // user clicks the button.
              e.preventDefault();
              e.stopPropagation();
              if (!resetBusy) onReset();
            }}
            disabled={resetBusy}
            className="rounded border border-slate-600/70 bg-slate-900/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {resetBusy ? "Resetting…" : "Reset resolver"}
          </button>
        </span>
      </summary>
      {resetError && (
        <div className="mt-2 break-all rounded bg-rose-950/40 px-2 py-1 text-[11px] text-rose-200">
          {resetError}
        </div>
      )}
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <UsptoEvidenceCard uspto={evidence.uspto} />
        <WebSearchEvidenceCard webSearch={evidence.webSearch} />
      </div>
    </details>
  );
}

function StatusDot({ tone }: { tone: "green" | "yellow" | "red" }) {
  const cls =
    tone === "green"
      ? "bg-emerald-500"
      : tone === "yellow"
        ? "bg-amber-400"
        : "bg-rose-500";
  return (
    <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${cls}`} />
  );
}

function UsptoEvidenceCard({
  uspto,
}: {
  uspto: EvidenceSummary["uspto"];
}) {
  const {
    query,
    resultsCount,
    errored,
    errorMessage,
    notes,
    marks,
  } = uspto;
  let body: ReactNode;
  if (errored) {
    body = (
      <>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <StatusDot tone="red" />
          Trademark search failed
        </div>
        {errorMessage && (
          <div className="mt-2 break-all rounded bg-slate-950/60 p-2 font-mono text-[11px] text-rose-200">
            {errorMessage}
          </div>
        )}
        <div className="mt-2 text-xs text-[var(--text-muted)]">
          Resolver fell back to web search alone for this run.
        </div>
      </>
    );
  } else if (resultsCount === 0) {
    body = (
      <>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <StatusDot tone="yellow" />
          No live trademark filings found
        </div>
        {query && (
          <div className="mt-2 text-xs text-[var(--text-muted)]">
            Query:{" "}
            <code className="break-words font-mono text-[11px]">{query}</code>
          </div>
        )}
        {notes && (
          <div className="mt-2 text-xs text-[var(--text-muted)]">{notes}</div>
        )}
      </>
    );
  } else {
    body = (
      <>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <StatusDot tone="green" />
          Found {resultsCount} live trademark filing
          {resultsCount === 1 ? "" : "s"}
        </div>
        {notes && (
          <div className="mt-1 text-xs text-[var(--text-muted)]">{notes}</div>
        )}
        {marks.length > 0 && (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                <tr>
                  <th className="py-1 pr-2 text-left">Mark</th>
                  <th className="py-1 pr-2 text-left">Owner</th>
                  <th className="py-1 pr-2 text-left">Status</th>
                  <th className="py-1 pr-2 text-left">Serial</th>
                  <th className="py-1 pr-2 text-left">Source</th>
                </tr>
              </thead>
              <tbody>
                {marks.slice(0, 5).map((m, i) => (
                  <tr
                    key={`${m.serialNumber ?? "no-serial"}-${i}`}
                    className="border-t border-slate-800/60 align-top"
                  >
                    <td className="py-1 pr-2">{m.mark ?? "—"}</td>
                    <td className="py-1 pr-2">{m.owner ?? "—"}</td>
                    <td className="py-1 pr-2">{m.status ?? "—"}</td>
                    <td className="py-1 pr-2 font-mono">
                      {m.serialNumber ?? "—"}
                    </td>
                    <td className="py-1 pr-2">
                      {m.sourceUrl ? (
                        <a
                          href={m.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-300 hover:underline"
                        >
                          link
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {query && (
          <details className="mt-2">
            <summary className="cursor-pointer select-none text-xs text-[var(--text-muted)]">
              Query
            </summary>
            <code className="mt-1 block break-words font-mono text-[11px] text-[var(--text-muted)]">
              {query}
            </code>
          </details>
        )}
      </>
    );
  }
  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-950/30 p-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
        Trademark Search (USPTO via web)
      </div>
      {body}
    </div>
  );
}

function WebSearchEvidenceCard({
  webSearch,
}: {
  webSearch: EvidenceSummary["webSearch"];
}) {
  const {
    queries,
    resultsCount,
    errored,
    errorMessage,
    sources,
    fullText,
    fullTextTruncated,
  } = webSearch;
  let header: ReactNode;
  if (errored) {
    header = (
      <>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <StatusDot tone="red" />
          Web search failed
        </div>
        {errorMessage && (
          <div className="mt-2 break-all rounded bg-slate-950/60 p-2 font-mono text-[11px] text-rose-200">
            {errorMessage}
          </div>
        )}
      </>
    );
  } else if (resultsCount === 0) {
    header = (
      <div className="flex items-center gap-2 text-sm font-semibold">
        <StatusDot tone="yellow" />
        No web sources returned
      </div>
    );
  } else {
    header = (
      <div className="flex items-center gap-2 text-sm font-semibold">
        <StatusDot tone="green" />
        Web search returned {resultsCount} source
        {resultsCount === 1 ? "" : "s"}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-950/30 p-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
        Web Search (OpenAI)
      </div>
      {header}

      {queries.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer select-none text-xs text-[var(--text-muted)]">
            Queries used ({queries.length})
          </summary>
          <ul className="mt-1 list-disc pl-5 text-xs text-[var(--text-muted)]">
            {queries.map((q, i) => (
              <li key={i} className="break-all font-mono">
                {q}
              </li>
            ))}
          </ul>
        </details>
      )}

      {sources.length > 0 && (
        <ul className="mt-2 space-y-2">
          {sources.map((s, i) => (
            <li key={`${s.url}-${i}`} className="text-xs">
              <div className="flex items-start gap-2">
                <span
                  aria-hidden
                  className="mt-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-slate-500"
                />
                <div className="min-w-0">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-blue-300 hover:underline"
                  >
                    {s.title ?? s.url}
                  </a>
                  <div className="truncate font-mono text-[10px] text-[var(--text-muted)]">
                    {s.url}
                  </div>
                  {s.snippet && (
                    <div className="mt-0.5 text-[var(--text-muted)]">
                      {s.snippet}
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {fullText && (
        <details className="mt-3">
          <summary className="cursor-pointer select-none text-xs text-[var(--text-muted)]">
            Show full extracted text
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-950/60 p-2 font-mono text-[11px] text-slate-200">
            {fullText}
          </pre>
          {fullTextTruncated && (
            <div className="mt-1 text-[10px] text-[var(--text-muted)]">
              Truncated to first 2000 characters.
            </div>
          )}
        </details>
      )}
    </div>
  );
}
