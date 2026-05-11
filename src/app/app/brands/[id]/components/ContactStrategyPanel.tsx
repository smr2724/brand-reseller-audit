"use client";
/**
 * Phase 69 — Contact Strategy panel.
 *
 * Renders below QualificationReview on /app/brands/[id]. Shows the
 * size-tier classification, ideal contact profile, ranked candidates
 * with score + stake, and action buttons.
 *
 * When verdict='needs_human_review', the panel surfaces the search
 * trail + reason and disables the "Enrich top 3" button (per spec).
 * "Add contact manually" and "Retry with different titles" buttons are
 * always exposed.
 *
 * The legacy ContactDiscovery / BrandContactsCard flow is left intact;
 * enriching the top-3 from this panel re-uses that pipeline via the
 * existing `/api/brands/[id]/contacts/enrich` endpoint.
 */
import React, { useEffect, useState } from "react";

type Verdict = "ready" | "needs_human_review" | "error" | null;

interface ApolloPerson {
  id: string;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  title: string | null;
  linkedin_headline: string | null;
  linkedin_url: string | null;
  seniority: string | null;
  department: string | null;
  email: string | null;
  email_status: string | null;
  organization_id: string | null;
  organization_name: string | null;
  organization_domain: string | null;
}

interface NamedCandidate {
  name: string;
  title: string | null;
  reason: string;
  can_sign_50k: boolean;
  personal_stake: "equity_owner" | "p_and_l_owner" | "comp_tied_to_channel" | "none";
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
}

interface RunResponse {
  ok: boolean;
  verdict: Verdict;
  strategy_id: string | null;
  reason?: string;
  ranked?: { candidate: ApolloPerson; score: number }[];
}

function formatStake(stake: NamedCandidate["personal_stake"]): string {
  switch (stake) {
    case "equity_owner":
      return "equity_owner";
    case "p_and_l_owner":
      return "p_and_l_owner";
    case "comp_tied_to_channel":
      return "comp_tied_to_channel";
    default:
      return "none";
  }
}

function formatRevenue(n: number | null): string {
  if (!n) return "—";
  if (n >= 1_000_000_000) return `~$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `~$${(n / 1_000_000).toFixed(0)}M`;
  return `~$${Math.round(n).toLocaleString()}`;
}

export default function ContactStrategyPanel({ brandId }: { brandId: string }) {
  const [strategy, setStrategy] = useState<StrategyRow | null>(null);
  const [ranked, setRanked] = useState<RunResponse["ranked"]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [running, setRunning] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/brands/${brandId}/contact-strategy`, {
        cache: "no-store",
      });
      if (!r.ok) {
        setStrategy(null);
        return;
      }
      const j = (await r.json()) as ApiResponse;
      setStrategy(j.strategy);
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
      setRanked(j.ranked ?? []);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  async function enrichTop3(): Promise<void> {
    setErr(null);
    try {
      const r = await fetch(`/api/brands/${brandId}/contacts/enrich`, {
        method: "POST",
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(j.error ?? `enrich error ${r.status}`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);

  if (loading && !strategy) {
    return (
      <div className="card p-4 mb-4">
        <div className="text-sm font-semibold">Contact Strategy</div>
        <div className="text-xs text-[var(--text-muted)] mt-1">Loading…</div>
      </div>
    );
  }

  if (!strategy) {
    return (
      <div className="card p-4 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">Contact Strategy</div>
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

  const rankedDisplay = (ranked ?? []).slice(0, 5);

  return (
    <div className="card p-4 mb-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div>
          <div className="text-sm font-semibold">Contact Strategy</div>
          <div className="text-xs text-[var(--text-muted)]">
            Size tier: <span className="font-mono">{strategy.company_size_tier}</span>
            {strategy.employees_estimate ? ` (${strategy.employees_estimate} employees, ${formatRevenue(strategy.revenue_estimate_usd)} revenue)` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {ready && (
            <span className="text-xs px-2 py-1 rounded bg-green-900 text-green-200">ready</span>
          )}
          {needsReview && (
            <span className="text-xs px-2 py-1 rounded bg-yellow-900 text-yellow-200">
              needs human review
            </span>
          )}
          {errorVerdict && (
            <span className="text-xs px-2 py-1 rounded bg-red-900 text-red-200">error</span>
          )}
        </div>
      </div>

      <div className="text-xs text-[var(--text-muted)] mt-2">
        <div>
          <span className="font-semibold">Profile:</span> {strategy.primary_titles.slice(0, 4).join(", ") || "—"}
        </div>
        {strategy.titles_to_avoid.length > 0 && (
          <div>
            <span className="font-semibold">Avoid:</span> {strategy.titles_to_avoid.join(", ")}
          </div>
        )}
        {strategy.profile_rationale && (
          <div className="mt-1 italic">{strategy.profile_rationale}</div>
        )}
      </div>

      {rankedDisplay.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-semibold mb-1">Recommended candidates (ranked):</div>
          <ol className="text-xs space-y-1">
            {rankedDisplay.map((r, idx) => {
              const c = r.candidate;
              const stakeMatch = strategy.named_candidates.find(
                (n) => n.name.trim().toLowerCase() === (c.name ?? `${c.first_name ?? ""} ${c.last_name ?? ""}`).trim().toLowerCase(),
              );
              const stake = stakeMatch ? formatStake(stakeMatch.personal_stake) : "—";
              const stakeOk = stakeMatch && stakeMatch.personal_stake !== "none" && stakeMatch.can_sign_50k;
              return (
                <li key={c.id || idx} className="flex gap-2">
                  <span className="font-mono">{idx + 1}.</span>
                  <span className="flex-1">{c.name ?? (`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "(unknown)")}</span>
                  <span className="text-[var(--text-muted)]">{c.title ?? ""}</span>
                  <span className="font-mono">score {r.score}</span>
                  <span>{stakeOk ? "✓" : "◯"}</span>
                  <span className="text-[var(--text-muted)]">stake: {stake}</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {needsReview && (
        <div className="mt-3 p-2 rounded border border-yellow-700 bg-yellow-950/40 text-xs">
          <div className="font-semibold text-yellow-200">Why human review?</div>
          <div className="text-yellow-100 mt-1">{strategy.verdict_reason ?? "—"}</div>
          <div className="mt-2 text-yellow-200/80">
            Search trail: tier={strategy.company_size_tier}, primary titles attempted:{" "}
            <span className="font-mono">{strategy.primary_titles.slice(0, 3).join(", ")}</span>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mt-3">
        <button
          className="btn"
          onClick={() => void enrichTop3()}
          disabled={!ready}
          title={ready ? "Enrich top 3 candidates" : "Available only when verdict=ready"}
        >
          Enrich top 3
        </button>
        <button className="btn" onClick={() => void run()} disabled={running}>
          {running ? "Retrying…" : "Retry with different titles"}
        </button>
        <button
          className="btn"
          onClick={() => {
            alert("Manual contact entry not yet wired — coming in a follow-up phase.");
          }}
        >
          Add contact manually
        </button>
      </div>

      {strategy.total_cost_usd != null && (
        <div className="text-[10px] text-[var(--text-muted)] mt-2">
          cost: ${strategy.total_cost_usd.toFixed(2)}
        </div>
      )}
      {err && <div className="text-sm text-red-400 mt-2">{err}</div>}
    </div>
  );
}
