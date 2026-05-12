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

interface BulkEnrichResp {
  ok: boolean;
  enriched: number;
  skipped: number;
  errors: number;
  llm_cost_usd?: number;
  results: Array<{
    contact_id: string;
    state: "enriched" | "error" | "already" | "not_found" | "no_domain";
    contact?: BrandContactRow | null;
    error?: string;
    llm_cost_usd?: number;
  }>;
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
  const [bulkRunning, setBulkRunning] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  /** Phase 73 — extra LLM web-search cost accumulated across enrich
   *  calls this session. Surfaced in the cost footer so the user can
   *  see when the last-resort step billed. */
  const [extraLlmCost, setExtraLlmCost] = useState<number>(0);

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

  async function enrichTop3(): Promise<void> {
    setBulkRunning(true);
    setErr(null);
    try {
      const r = await fetch(`/api/brands/${brandId}/contacts/enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = (await r.json().catch(() => ({}))) as Partial<BulkEnrichResp> & {
        error?: string;
      };
      if (!r.ok) {
        setErr(j.error ?? `enrich error ${r.status}`);
        return;
      }
      if (typeof j.llm_cost_usd === "number" && j.llm_cost_usd > 0) {
        setExtraLlmCost((c) => c + j.llm_cost_usd!);
      }
      // Reload after bulk so contacts + events come back as a coherent set.
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

  const unEnrichedCount = candidateRows.filter(
    (r) => !r.contact || r.contact.enrichment_state === "discovered",
  ).length;

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
              const enriching =
                contact != null &&
                (enrichingIds.has(contact.id) ||
                  contact.enrichment_state === "enriching");
              const alreadyEnriched =
                contact != null &&
                (contact.enrichment_state === "enriched" ||
                  contact.enrichment_state === "enriching");
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
                    {contact ? (
                      <button
                        type="button"
                        className="btn btn-ghost text-[11px]"
                        disabled={enriching || alreadyEnriched}
                        title={
                          alreadyEnriched
                            ? "Already enriched"
                            : "Spend an Apollo email credit to unlock this contact's email."
                        }
                        onClick={() => void enrichSingle(contact.id)}
                      >
                        {enriching
                          ? "Enriching…"
                          : alreadyEnriched
                            ? "✓ enriched"
                            : "Enrich"}
                      </button>
                    ) : (
                      <span
                        className="text-[11px] text-[var(--text-muted)]"
                        title="Run contact strategy to materialize this candidate."
                      >
                        not seeded
                      </span>
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
        <button
          className="btn"
          onClick={() => void enrichTop3()}
          disabled={bulkRunning || unEnrichedCount === 0 || !ready}
          title={
            !ready
              ? "Available only when verdict=ready"
              : unEnrichedCount === 0
                ? "All candidates already enriched"
                : "Enrich up to the first 3 not-yet-enriched candidates"
          }
        >
          {bulkRunning ? "Enriching…" : "Enrich top 3"}
        </button>
        <button className="btn" onClick={() => void run()} disabled={running}>
          {running ? "Retrying…" : "Retry with different titles"}
        </button>
        <button
          className="btn"
          onClick={() => {
            alert(
              "Manual contact entry not yet wired — coming in a follow-up phase.",
            );
          }}
        >
          Add contact manually
        </button>
      </div>

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
