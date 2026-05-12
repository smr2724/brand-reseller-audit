"use client";
/**
 * Phase 73 — Merged Decision-Makers card.
 *
 * Replaces the prior split between Phase 69 Contact Strategy and the
 * legacy/Phase 71 Contact Discovery card. This single card now shows:
 *   - verdict pill (ready / needs human review / error)
 *   - size tier + profile / avoid / rationale
 *   - CANDIDATES section: one row per `named_candidates` entry +
 *     persisted brand_contacts rows; each row has a per-row Enrich
 *     button + status (not enriched / enriching… / verified email /
 *     invalid / risky)
 *   - collapsible Discovery audit (the per-provider event trail)
 *   - bulk actions: Enrich top 3 / Retry / Add contact manually + cost
 *
 * The /app/contacts page is untouched. The bulk Enrich button now
 * targets `/api/brands/[id]/contacts/enrich` (a POST route added in
 * Phase 73 — see route.ts comment for the 405 root-cause).
 */
import React, { useEffect, useMemo, useState } from "react";

type Verdict = "ready" | "needs_human_review" | "error" | null;

interface NamedCandidate {
  name: string;
  title: string | null;
  linkedin_url?: string | null;
  reason: string;
  can_sign_50k: boolean;
  personal_stake: "equity_owner" | "p_and_l_owner" | "comp_tied_to_channel" | "none";
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  source?: "gate_c" | "llm" | null;
}

interface StrategyRow {
  id: string;
  brand_id: string;
  company_size_tier: "micro" | "small" | "mid" | "enterprise";
  employees_estimate: number | null;
  revenue_estimate_usd: number | null;
  primary_titles: string[];
  secondary_titles: string[];
  titles_to_avoid: string[];
  profile_rationale: string | null;
  named_candidates: NamedCandidate[];
  outreach_order: string[];
  verdict: Verdict;
  verdict_reason: string | null;
  total_cost_usd: number | null;
  created_at: string;
}

interface ApiResponse {
  strategy: StrategyRow | null;
  qualification_updated_at?: string | null;
}

interface RunResponse {
  ok: boolean;
  verdict: Verdict;
  strategy_id: string | null;
  reason?: string;
}

interface BrandContactRow {
  id: string;
  full_name: string;
  title: string | null;
  linkedin_url: string | null;
  email: string | null;
  email_status: string | null;
  email_source: string | null;
  email_verifier: string | null;
  email_verifier_score: number | null;
  is_primary: boolean;
  ready_to_send: boolean;
  enrichment_state: "discovered" | "enriching" | "enriched" | "error" | null;
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

interface DiscoverGet {
  state: string;
  contacts: BrandContactRow[];
  events: DiscoveryEvent[];
  domain_pattern: string | null;
  is_catch_all: boolean | null;
  error?: string;
}

interface PerRowEnrichResp {
  ok?: boolean;
  contact?: BrandContactRow;
  events?: DiscoveryEvent[];
  error?: string;
  llm_cost_usd?: number;
}

interface CandidateRowState {
  name: string;
  title: string | null;
  linkedin_url: string | null;
  source: string;
  contact: BrandContactRow | null;
}

interface CandidateEnrichResp {
  ok?: boolean;
  state?: "enriched" | "already" | "error";
  contact?: BrandContactRow | null;
  events?: DiscoveryEvent[];
  error?: string;
  llm_cost_usd?: number;
}

/** Phase 73.2 — manual-add route response shape. */
interface ManualAddResp {
  ok?: boolean;
  contact?: BrandContactRow;
  error?: string;
  mv_status?: string;
  mv_score?: number;
  detail?: string;
}

const EMAIL_SHAPE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function formatRevenue(n: number | null): string {
  if (!n) return "—";
  if (n >= 1_000_000_000) return `~$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `~$${(n / 1_000_000).toFixed(0)}M`;
  return `~$${Math.round(n).toLocaleString()}`;
}

function sourceLabel(c: NamedCandidate | null, contact: BrandContactRow | null): string {
  if (contact?.email_source) {
    switch (contact.email_source) {
      case "apollo":
      case "apollo_crm":
      case "apollo_match":
      case "apollo_linkedin_match":
        return "Apollo";
      case "hunter":
      case "hunter_finder":
        return "Hunter";
      case "hunter_pattern":
        return "Pattern";
      case "llm_websearch":
        return "LLM web-search";
      case "manual":
        return "Manual";
      default:
        return contact.email_source;
    }
  }
  if (c?.source === "gate_c") return "Gate C";
  if (c?.source === "llm") return "LLM size-tier";
  return "—";
}

function statusLine(contact: BrandContactRow | null, enriching: boolean): React.ReactNode {
  if (enriching) return <span className="text-amber-300">enriching…</span>;
  if (!contact) return <span className="text-[var(--text-muted)]">not enriched</span>;
  const state = contact.enrichment_state;
  if (state === "discovered" && !contact.email) {
    return <span className="text-[var(--text-muted)]">not enriched</span>;
  }
  if (state === "enriching") {
    return <span className="text-amber-300">enriching…</span>;
  }
  if (state === "error") {
    return <span className="text-red-300">error</span>;
  }
  if (contact.email && contact.email_status === "verified") {
    return (
      <span className="text-emerald-300">
        ✓ verified: <code>{contact.email}</code>
      </span>
    );
  }
  if (contact.email && contact.email_status === "risky") {
    return (
      <span className="text-amber-200">
        risky: <code>{contact.email}</code>
      </span>
    );
  }
  if (contact.email && contact.email_status === "invalid") {
    return (
      <span className="text-red-300">
        invalid: <code>{contact.email}</code>
      </span>
    );
  }
  if (contact.email) {
    return (
      <span className="text-zinc-300">
        {contact.email_status ?? "unverified"}: <code>{contact.email}</code>
      </span>
    );
  }
  return <span className="text-[var(--text-muted)]">no email found</span>;
}

const PROVIDER_LABEL: Record<string, string> = {
  apollo_search: "Apollo Search",
  apollo_match: "Apollo Match",
  hunter_domain: "Hunter Domain",
  hunter_finder: "Hunter Finder",
  hunter_pattern: "Hunter Pattern",
  pattern_guess: "Pattern Guess",
  linkedin_verify: "LinkedIn Verify",
  llm_websearch: "LLM Web Search",
  millionverifier: "MillionVerifier",
  zerobounce: "ZeroBounce",
  orchestrator: "Orchestrator",
  enrichment_deferred: "Enrichment Deferred",
};

export default function ContactStrategyPanel({ brandId }: { brandId: string }) {
  const [strategy, setStrategy] = useState<StrategyRow | null>(null);
  const [qualUpdatedAt, setQualUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [running, setRunning] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  const [contacts, setContacts] = useState<BrandContactRow[]>([]);
  const [events, setEvents] = useState<DiscoveryEvent[]>([]);
  const [enrichingIds, setEnrichingIds] = useState<Set<string>>(new Set());
  /** Phase 73.1 — track in-flight enriches for unseeded named
   *  candidates (no brand_contact row yet). Keyed by lower-cased name
   *  since there's no id to track. */
  const [enrichingNames, setEnrichingNames] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  /** Phase 73 — extra LLM web-search cost accumulated across enrich
   *  calls this session. Surfaced in the cost footer so the user can
   *  see when the last-resort step billed. */
  const [extraLlmCost, setExtraLlmCost] = useState<number>(0);

  // Phase 73.2 — manual contact entry modal state. Triggered by the
  // "Add contact manually" button at the bottom of the card. Submits to
  // /api/brands/[id]/contacts/manual-add which MV-gates the email before
  // writing.
  const [manualOpen, setManualOpen] = useState(false);
  const [manualFirst, setManualFirst] = useState("");
  const [manualLast, setManualLast] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [manualEmail, setManualEmail] = useState("");
  const [manualLinkedIn, setManualLinkedIn] = useState("");
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const [manualInlineError, setManualInlineError] = useState<string | null>(
    null,
  );

  async function load(): Promise<void> {
    setLoading(true);
    setErr(null);
    try {
      const [stratR, discR] = await Promise.all([
        fetch(`/api/brands/${brandId}/contact-strategy`, { cache: "no-store" }),
        fetch(`/api/brands/${brandId}/contacts/discover`, { method: "GET" }),
      ]);
      if (stratR.ok) {
        const j = (await stratR.json()) as ApiResponse;
        setStrategy(j.strategy);
        setQualUpdatedAt(j.qualification_updated_at ?? null);
      } else {
        setStrategy(null);
        setQualUpdatedAt(null);
      }
      if (discR.ok) {
        const j = (await discR.json()) as Partial<DiscoverGet>;
        setContacts(j.contacts ?? []);
        setEvents(j.events ?? []);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function run(): Promise<void> {
    setRunning(true);
    setErr(null);
    try {
      const r = await fetch(`/api/brands/${brandId}/contact-strategy`, {
        method: "POST",
      });
      const j = (await r.json()) as RunResponse;
      if (!r.ok || !j.ok) {
        setErr(j.reason ?? `error ${r.status}`);
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  async function enrichSingle(contactId: string): Promise<void> {
    setEnrichingIds((prev) => new Set(prev).add(contactId));
    setErr(null);
    try {
      const r = await fetch(
        `/api/brands/${brandId}/contacts/${contactId}/enrich`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      const j = (await r.json().catch(() => ({}))) as PerRowEnrichResp;
      if (!r.ok) {
        setErr(j.error ?? `enrich error ${r.status}`);
      } else if (j.contact) {
        setContacts((prev) =>
          prev.map((c) => (c.id === j.contact!.id ? j.contact! : c)),
        );
        if (j.events) setEvents((prev) => [...prev, ...(j.events ?? [])]);
        if (typeof j.llm_cost_usd === "number" && j.llm_cost_usd > 0) {
          setExtraLlmCost((c) => c + j.llm_cost_usd!);
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEnrichingIds((prev) => {
        const next = new Set(prev);
        next.delete(contactId);
        return next;
      });
    }
  }

  /** Phase 73.1 — per-row Enrich for a named candidate that has no
   *  brand_contacts row yet. The server endpoint either finds the
   *  existing row by full_name OR seeds a new one in `discovered`
   *  state, then runs the same fallback chain as bulk Enrich. */
  async function enrichCandidate(row: CandidateRowState): Promise<void> {
    const key = row.name.trim().toLowerCase();
    if (!key) return;
    setEnrichingNames((prev) => new Set(prev).add(key));
    setErr(null);
    try {
      const r = await fetch(
        `/api/brands/${brandId}/contacts/enrich-candidate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: row.name,
            title: row.title,
            linkedin_url: row.linkedin_url,
          }),
        },
      );
      const j = (await r.json().catch(() => ({}))) as CandidateEnrichResp;
      if (!r.ok) {
        setErr(j.error ?? `enrich error ${r.status}`);
        return;
      }
      if (j.contact) {
        setContacts((prev) => {
          const has = prev.some((c) => c.id === j.contact!.id);
          return has
            ? prev.map((c) => (c.id === j.contact!.id ? j.contact! : c))
            : [...prev, j.contact!];
        });
      }
      if (j.events && j.events.length > 0) {
        setEvents((prev) => [...prev, ...(j.events ?? [])]);
      }
      if (typeof j.llm_cost_usd === "number" && j.llm_cost_usd > 0) {
        setExtraLlmCost((c) => c + j.llm_cost_usd!);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEnrichingNames((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  /**
   * Phase 73.1 — Bulk "Enrich top N" dispatches to the SAME row-
   * level handler the per-row button uses, so seeded and unseeded
   * candidates take the right path:
   *   - seeded (contact present)   → /contacts/[contactId]/enrich
   *   - unseeded (named-only)      → /contacts/enrich-candidate
   *
   * The previous bulk implementation hit /contacts/enrich which only
   * targets `enrichment_state='discovered'` rows in brand_contacts —
   * named candidates without a contact row silently produced
   * `{enriched: 0}` (the Maria-Ringo-on-Carna4 bug). Routing through
   * the row handler means there is exactly one source of truth for
   * what an Enrich click does.
   *
   * Runs the first N=Math.min(unEnrichedCount, 3) candidates in
   * parallel via Promise.allSettled; per-row failures don't abort
   * the rest.
   */
  async function enrichTop3(): Promise<void> {
    setBulkRunning(true);
    setErr(null);
    try {
      const targets = candidateRows
        .filter((r) => !r.contact || !r.contact.email)
        .slice(0, 3);
      if (targets.length === 0) return;
      const settled = await Promise.allSettled(
        targets.map((row) =>
          row.contact ? enrichSingle(row.contact.id) : enrichCandidate(row),
        ),
      );
      const failures = settled.filter((s) => s.status === "rejected");
      if (failures.length > 0 && failures.length === settled.length) {
        // All failed; surface a single banner. Per-row errors are
        // already set by the handlers via setErr.
        setErr(
          `bulk enrich: ${failures.length} of ${settled.length} failed`,
        );
      }
      // Reload so the discovery audit and other contacts catch up
      // with anything the chain wrote (Hunter domain cache, etc.).
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBulkRunning(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);

  function openManual(): void {
    setManualFirst("");
    setManualLast("");
    setManualTitle("");
    setManualEmail("");
    setManualLinkedIn("");
    setManualInlineError(null);
    setManualOpen(true);
  }

  function closeManual(): void {
    if (manualSubmitting) return;
    setManualOpen(false);
    setManualInlineError(null);
  }

  async function submitManual(): Promise<void> {
    setManualInlineError(null);
    const first = manualFirst.trim();
    const last = manualLast.trim();
    const title = manualTitle.trim();
    const email = manualEmail.trim().toLowerCase();
    const linkedinUrl = manualLinkedIn.trim();
    if (!first || !last || !title) {
      setManualInlineError("First name, last name, and title are required.");
      return;
    }
    if (!EMAIL_SHAPE.test(email)) {
      setManualInlineError("Please enter a valid email address.");
      return;
    }
    setManualSubmitting(true);
    try {
      const r = await fetch(`/api/brands/${brandId}/contacts/manual-add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: first,
          last_name: last,
          title,
          email,
          linkedin_url: linkedinUrl || null,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as ManualAddResp;
      if (r.status === 422 && j.error === "mv_rejected") {
        setManualInlineError(
          `MillionVerifier says this address is ${j.mv_status ?? "non-valid"}. Manual entries must be MV-valid. Please try a different email.`,
        );
        return;
      }
      if (!r.ok || !j.ok) {
        setErr(j.error ?? j.detail ?? `manual-add error ${r.status}`);
        return;
      }
      setManualOpen(false);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setManualSubmitting(false);
    }
  }

  // Build the unified candidate-row list: named_candidates + any
  // brand_contacts rows that don't appear in named_candidates by name
  // (covers contacts persisted by the legacy/Apollo founder scan).
  const candidateRows: CandidateRowState[] = useMemo(() => {
    if (!strategy) {
      return contacts.map((c) => ({
        name: c.full_name,
        title: c.title,
        linkedin_url: c.linkedin_url,
        source: sourceLabel(null, c),
        contact: c,
      }));
    }
    const used = new Set<string>();
    const out: CandidateRowState[] = [];
    for (const nc of strategy.named_candidates) {
      const lname = (nc.name ?? "").trim().toLowerCase();
      const match = contacts.find(
        (c) => (c.full_name ?? "").trim().toLowerCase() === lname,
      );
      if (match) used.add(match.id);
      out.push({
        name: nc.name,
        title: nc.title,
        linkedin_url: nc.linkedin_url ?? match?.linkedin_url ?? null,
        source: sourceLabel(nc, match ?? null),
        contact: match ?? null,
      });
    }
    for (const c of contacts) {
      if (used.has(c.id)) continue;
      out.push({
        name: c.full_name,
        title: c.title,
        linkedin_url: c.linkedin_url,
        source: sourceLabel(null, c),
        contact: c,
      });
    }
    return out;
  }, [strategy, contacts]);

  if (loading && !strategy && contacts.length === 0) {
    return (
      <div className="card p-4 mb-4">
        <div className="text-sm font-semibold">Decision-Makers</div>
        <div className="text-xs text-[var(--text-muted)] mt-1">Loading…</div>
      </div>
    );
  }

  if (!strategy) {
    return (
      <div className="card p-4 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">Decision-Makers</div>
            <div className="text-xs text-[var(--text-muted)] mt-1">
              No strategy yet. Run after qualification passes.
            </div>
          </div>
          <button className="btn" onClick={() => void run()} disabled={running}>
            {running ? "Running…" : "Run contact strategy"}
          </button>
        </div>
        {err && <div className="text-sm text-red-400 mt-2">{err}</div>}
      </div>
    );
  }

  const needsReview = strategy.verdict === "needs_human_review";
  const ready = strategy.verdict === "ready";
  const errorVerdict = strategy.verdict === "error";

  const strategyStale =
    !!qualUpdatedAt &&
    !!strategy.created_at &&
    Date.parse(strategy.created_at) < Date.parse(qualUpdatedAt);

  // Phase 73.1 — "unenriched" = no contact row at all, OR a contact
  // row with no resolved email. The bulk button now hides at 0 and
  // shows dynamic copy ("Enrich" / "Enrich top 2" / "Enrich top 3").
  const unEnrichedCount = candidateRows.filter(
    (r) => !r.contact || !r.contact.email,
  ).length;
  const bulkButtonLabel =
    unEnrichedCount === 1
      ? "Enrich"
      : `Enrich top ${Math.min(unEnrichedCount, 3)}`;

  return (
    <div className="card p-4 mb-4">
      {strategyStale && (
        <div className="mb-3 p-2 rounded border border-amber-700 bg-amber-950/40 text-xs flex items-center justify-between gap-2">
          <span className="text-amber-100">
            Qualification updated — re-run contact strategy
          </span>
          <button
            className="btn"
            onClick={() => void run()}
            disabled={running}
          >
            {running ? "Running…" : "Re-run"}
          </button>
        </div>
      )}
      <div className="flex items-center justify-between gap-3 mb-2">
        <div>
          <div className="text-sm font-semibold">Decision-Makers</div>
          <div className="text-xs text-[var(--text-muted)]">
            Size tier:{" "}
            <span className="font-mono">{strategy.company_size_tier}</span>
            {strategy.employees_estimate
              ? ` (${strategy.employees_estimate} employees, ${formatRevenue(strategy.revenue_estimate_usd)} revenue)`
              : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {ready && (
            <span className="text-xs px-2 py-1 rounded bg-green-900 text-green-200">
              ready
            </span>
          )}
          {needsReview && (
            <span className="text-xs px-2 py-1 rounded bg-yellow-900 text-yellow-200">
              needs human review
            </span>
          )}
          {errorVerdict && (
            <span className="text-xs px-2 py-1 rounded bg-red-900 text-red-200">
              error
            </span>
          )}
          <button className="btn btn-ghost text-xs" onClick={() => void run()} disabled={running}>
            {running ? "…" : "Re-run"}
          </button>
        </div>
      </div>

      <div className="text-xs text-[var(--text-muted)] mt-2">
        <div>
          <span className="font-semibold">Profile:</span>{" "}
          {strategy.primary_titles.slice(0, 4).join(", ") || "—"}
        </div>
        {strategy.titles_to_avoid.length > 0 && (
          <div>
            <span className="font-semibold">Avoid:</span>{" "}
            {strategy.titles_to_avoid.join(", ")}
          </div>
        )}
        {strategy.profile_rationale && (
          <div className="mt-1 italic">{strategy.profile_rationale}</div>
        )}
      </div>

      {/* Candidates section */}
      <div className="mt-4 border-t border-[var(--border-soft)] pt-3">
        <div className="text-xs font-semibold mb-2 uppercase tracking-wide text-[var(--text-muted)]">
          Candidates ({candidateRows.length})
        </div>
        {candidateRows.length === 0 ? (
          <div className="text-xs text-[var(--text-muted)]">
            No candidates yet.
          </div>
        ) : (
          <ul className="space-y-2">
            {candidateRows.map((row, idx) => {
              const contact = row.contact;
              const nameKey = row.name.trim().toLowerCase();
              const candidateEnriching = enrichingNames.has(nameKey);
              const enriching =
                candidateEnriching ||
                (contact != null &&
                  (enrichingIds.has(contact.id) ||
                    contact.enrichment_state === "enriching"));
              // Phase 73.1 — "already enriched" means the row has a
              // non-null email. Rows in `enriched` state without an
              // email (Apollo unlock burned but missed) still get a
              // re-enrich shot via the fallback chain — labeled
              // "Retry" so the user can see this is a re-attempt.
              const alreadyEnriched =
                contact != null &&
                contact.email != null &&
                contact.email.length > 0;
              const isRetry =
                contact != null &&
                !alreadyEnriched &&
                (contact.enrichment_state === "error" ||
                  contact.enrichment_state === "enriched");
              const buttonLabel = enriching
                ? isRetry
                  ? "Retrying…"
                  : "Enriching…"
                : isRetry
                  ? "Retry"
                  : "Enrich";
              return (
                <li
                  key={contact?.id ?? `nc:${idx}`}
                  className="rounded border border-[var(--border-soft)] p-2 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{row.name}</span>
                      <span className="text-[var(--text-muted)]">
                        {row.title ?? "—"}
                      </span>
                      {contact?.is_primary && (
                        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-700/40 text-amber-200">
                          Primary
                        </span>
                      )}
                    </div>
                    {alreadyEnriched ? (
                      <span
                        className="text-[11px] text-emerald-300"
                        title="Already enriched"
                      >
                        ✓ enriched
                      </span>
                    ) : contact ? (
                      <button
                        type="button"
                        className="btn btn-ghost text-[11px]"
                        disabled={enriching}
                        title={
                          isRetry
                            ? "Previous attempt finished without an email. Re-run the fallback chain."
                            : "Run the fallback chain (Apollo → Hunter → 8-pattern → LLM web-search) for this row."
                        }
                        onClick={() => void enrichSingle(contact.id)}
                      >
                        {buttonLabel}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost text-[11px]"
                        disabled={enriching}
                        title="Seed this candidate and run the full fallback chain."
                        onClick={() => void enrichCandidate(row)}
                      >
                        {buttonLabel}
                      </button>
                    )}
                  </div>
                  <div className="mt-1 text-[var(--text-muted)] flex flex-wrap gap-x-2">
                    <span>Source: {row.source}</span>
                    {row.linkedin_url && (
                      <span>
                        ·{" "}
                        <a
                          className="underline hover:text-[var(--text)]"
                          href={row.linkedin_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          LinkedIn ↗
                        </a>
                      </span>
                    )}
                  </div>
                  <div className="mt-1">{statusLine(contact, enriching)}</div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Discovery audit (collapsible) */}
      {events.length > 0 && (
        <div className="mt-4 border-t border-[var(--border-soft)] pt-3">
          <button
            type="button"
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] underline"
            onClick={() => setAuditOpen((v) => !v)}
          >
            {auditOpen ? "▾" : "▸"} Discovery audit ({events.length} event
            {events.length === 1 ? "" : "s"})
          </button>
          {auditOpen && (
            <div className="mt-2 space-y-1">
              {events
                .slice()
                .sort(
                  (a, b) =>
                    Date.parse(a.created_at) - Date.parse(b.created_at),
                )
                .map((ev) => (
                  <div
                    key={ev.id}
                    className="rounded border border-[var(--border-soft)] p-2 text-[11px]"
                  >
                    <div className="flex flex-wrap gap-2">
                      <span className="font-mono px-1.5 py-0.5 rounded bg-zinc-800/60 text-zinc-200">
                        {PROVIDER_LABEL[ev.provider] ?? ev.provider}
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-zinc-700/40 text-zinc-300">
                        {ev.outcome}
                      </span>
                      {ev.status_returned && (
                        <span className="text-[var(--text-muted)]">
                          {ev.status_returned}
                        </span>
                      )}
                      {ev.email_returned && (
                        <code className="text-[var(--text-muted)]">
                          {ev.email_returned}
                        </code>
                      )}
                    </div>
                    {ev.reason && (
                      <div className="mt-1 text-[var(--text)]">{ev.reason}</div>
                    )}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {needsReview && (
        <div className="mt-3 p-2 rounded border border-yellow-700 bg-yellow-950/40 text-xs">
          <div className="font-semibold text-yellow-200">Why human review?</div>
          <div className="text-yellow-100 mt-1">
            {strategy.verdict_reason ?? "—"}
          </div>
          <div className="mt-2 text-yellow-200/80">
            Search trail: tier={strategy.company_size_tier}, primary titles
            attempted:{" "}
            <span className="font-mono">
              {strategy.primary_titles.slice(0, 3).join(", ")}
            </span>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mt-3">
        {unEnrichedCount > 0 && (
          <button
            className="btn"
            onClick={() => void enrichTop3()}
            disabled={bulkRunning || !ready}
            title={
              !ready
                ? "Available only when verdict=ready"
                : unEnrichedCount === 1
                  ? "Enrich the one not-yet-enriched candidate"
                  : `Enrich up to the first ${Math.min(unEnrichedCount, 3)} not-yet-enriched candidates`
            }
          >
            {bulkRunning ? "Enriching…" : bulkButtonLabel}
          </button>
        )}
        <button className="btn" onClick={() => void run()} disabled={running}>
          {running ? "Retrying…" : "Retry with different titles"}
        </button>
        <button className="btn" onClick={openManual}>
          Add contact manually
        </button>
      </div>

      {manualOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={closeManual}
        >
          <div
            className="card w-full max-w-md p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold mb-2">
              Add contact manually
            </div>
            <div className="text-xs text-[var(--text-muted)] mb-3">
              The email is sent to MillionVerifier. Only addresses MV
              marks <code>valid</code> are saved.
            </div>
            <div className="space-y-2 text-xs">
              <label className="block">
                <div className="text-[var(--text-muted)] mb-1">First name</div>
                <input
                  type="text"
                  className="w-full rounded border border-[var(--border-soft)] bg-transparent px-2 py-1"
                  value={manualFirst}
                  onChange={(e) => setManualFirst(e.target.value)}
                  disabled={manualSubmitting}
                />
              </label>
              <label className="block">
                <div className="text-[var(--text-muted)] mb-1">Last name</div>
                <input
                  type="text"
                  className="w-full rounded border border-[var(--border-soft)] bg-transparent px-2 py-1"
                  value={manualLast}
                  onChange={(e) => setManualLast(e.target.value)}
                  disabled={manualSubmitting}
                />
              </label>
              <label className="block">
                <div className="text-[var(--text-muted)] mb-1">Title</div>
                <input
                  type="text"
                  className="w-full rounded border border-[var(--border-soft)] bg-transparent px-2 py-1"
                  value={manualTitle}
                  onChange={(e) => setManualTitle(e.target.value)}
                  disabled={manualSubmitting}
                  placeholder="Owner / Founder / President / …"
                />
              </label>
              <label className="block">
                <div className="text-[var(--text-muted)] mb-1">Email</div>
                <input
                  type="email"
                  className="w-full rounded border border-[var(--border-soft)] bg-transparent px-2 py-1"
                  value={manualEmail}
                  onChange={(e) => setManualEmail(e.target.value)}
                  disabled={manualSubmitting}
                />
              </label>
              <label className="block">
                <div className="text-[var(--text-muted)] mb-1">
                  LinkedIn URL <span className="opacity-60">(optional)</span>
                </div>
                <input
                  type="url"
                  className="w-full rounded border border-[var(--border-soft)] bg-transparent px-2 py-1"
                  value={manualLinkedIn}
                  onChange={(e) => setManualLinkedIn(e.target.value)}
                  disabled={manualSubmitting}
                />
              </label>
            </div>
            {manualInlineError && (
              <div className="mt-3 text-xs text-red-300">
                {manualInlineError}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={closeManual}
                disabled={manualSubmitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void submitManual()}
                disabled={manualSubmitting}
              >
                {manualSubmitting ? "Verifying…" : "Verify & save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {(strategy.total_cost_usd != null || extraLlmCost > 0) && (
        <div className="text-[10px] text-[var(--text-muted)] mt-2">
          cost: $
          {(((strategy.total_cost_usd ?? 0) + extraLlmCost) || 0).toFixed(2)}
          {extraLlmCost > 0 && (
            <span> (incl. ${extraLlmCost.toFixed(2)} LLM web-search)</span>
          )}
        </div>
      )}
      {err && <div className="text-sm text-red-400 mt-2">{err}</div>}
    </div>
  );
}
