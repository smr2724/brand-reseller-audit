"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

interface BrandRow {
  id: string;
  name: string;
  status: string;
  brand_score: number | null;
  est_monthly_revenue: number | null;
  validation_score: number | null;
  keepa_last_enriched_at: string | null;
  keepa_asin_count: number | null;
}

interface TokenStatus {
  ok: boolean;
  configured: boolean;
  tokens_left?: number;
  refill_in_ms?: number;
  refill_rate?: number;
  error?: string;
}

interface BatchResult {
  brand_id: string;
  ok: boolean;
  summary?: { validation_score?: number | null; asin_count?: number };
  error?: string;
}

type Tab = "queue" | "recent";

export default function EnrichmentClient() {
  const [tab, setTab] = useState<Tab>("queue");
  const [brands, setBrands] = useState<BrandRow[]>([]);
  const [recent, setRecent] = useState<BrandRow[]>([]);
  const [tokens, setTokens] = useState<TokenStatus | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current?: string } | null>(null);
  const [results, setResults] = useState<BatchResult[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function loadBrands() {
    try {
      const res = await fetch("/api/brands?limit=500", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const all: BrandRow[] = data.brands ?? [];
      const queue = all.filter((b) => !b.keepa_last_enriched_at && b.status !== "disqualified" && b.status !== "client");
      const enriched = all
        .filter((b) => !!b.keepa_last_enriched_at)
        .sort((a, b) => (b.keepa_last_enriched_at ?? "").localeCompare(a.keepa_last_enriched_at ?? ""));
      setBrands(queue);
      setRecent(enriched);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  async function loadTokens() {
    try {
      const res = await fetch("/api/enrichment/tokens", { cache: "no-store" });
      const data = await res.json();
      setTokens(data);
    } catch {}
  }

  useEffect(() => {
    loadBrands();
    loadTokens();
    const t = setInterval(loadTokens, 30_000);
    return () => clearInterval(t);
  }, []);

  const selectedIds = useMemo(() => Array.from(selected), [selected]);
  const estimatedTokens = selectedIds.length * 100;
  const estimatedMinutes = Math.ceil(estimatedTokens / 300);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === brands.length) setSelected(new Set());
    else setSelected(new Set(brands.map((b) => b.id)));
  }

  async function runBatch() {
    if (!selectedIds.length) return;
    setRunning(true);
    setErr(null);
    setResults([]);
    setProgress({ done: 0, total: selectedIds.length });

    // Run brands serially, one at a time, calling the single-brand endpoint
    // so that progress can be tracked and tokens are respected naturally.
    const acc: BatchResult[] = [];
    for (let i = 0; i < selectedIds.length; i++) {
      const id = selectedIds[i];
      const b = brands.find((x) => x.id === id);
      setProgress({ done: i, total: selectedIds.length, current: b?.name });
      try {
        const res = await fetch(`/api/enrichment/brands/${id}/keepa`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) acc.push({ brand_id: id, ok: false, error: data.error ?? `HTTP ${res.status}` });
        else acc.push({ brand_id: id, ok: true, summary: data.summary });
      } catch (e: any) {
        acc.push({ brand_id: id, ok: false, error: String(e?.message ?? e) });
      }
      setResults([...acc]);
      await loadTokens();
    }
    setProgress({ done: selectedIds.length, total: selectedIds.length });
    setRunning(false);
    setSelected(new Set());
    loadBrands();
  }

  const top5 = useMemo(() => {
    const wins = results.filter((r) => r.ok && r.summary?.validation_score != null);
    return wins
      .map((r) => {
        const b = brands.find((x) => x.id === r.brand_id) ?? recent.find((x) => x.id === r.brand_id);
        return { id: r.brand_id, name: b?.name ?? r.brand_id, score: r.summary!.validation_score! };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }, [results, brands, recent]);

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-5">
        <div>
          <h1 className="text-2xl font-semibold">Enrichment</h1>
          <div className="text-sm text-[var(--text-muted)] mt-1">Keepa marketplace validation</div>
        </div>
        <div className="card-soft p-3 text-sm min-w-[260px]">
          <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-1">Keepa tokens</div>
          {tokens == null && <div>Loading…</div>}
          {tokens && !tokens.configured && <div className="text-[#f87171]">Not configured</div>}
          {tokens && tokens.configured && tokens.ok && (
            <div>
              <span className="text-lg font-semibold">{tokens.tokens_left ?? 0}</span>
              <span className="text-[var(--text-muted)]"> available</span>
              {tokens.refill_in_ms != null && tokens.refill_in_ms > 0 && (
                <span className="text-[var(--text-muted)]"> · refill in {Math.ceil(tokens.refill_in_ms / 1000)}s</span>
              )}
            </div>
          )}
          {tokens && tokens.configured && !tokens.ok && (
            <div className="text-[#f87171] text-xs">{tokens.error}</div>
          )}
        </div>
      </div>

      {err && <div className="card-soft p-3 mb-4 text-sm" style={{ color: "#f87171" }}>{err}</div>}

      <div className="flex gap-1 border-b border-[var(--border-soft)] mb-4">
        <TabButton active={tab === "queue"} onClick={() => setTab("queue")}>
          Queue ({brands.length})
        </TabButton>
        <TabButton active={tab === "recent"} onClick={() => setTab("recent")}>
          Recently enriched ({recent.length})
        </TabButton>
      </div>

      {tab === "queue" && (
        <div className="card p-4">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
            <div className="text-sm text-[var(--text-muted)]">
              {selected.size > 0 ? (
                <>
                  <strong>{selected.size}</strong> selected · est ~{estimatedTokens} tokens · ~{estimatedMinutes} min
                </>
              ) : (
                "Select brands to enrich"
              )}
            </div>
            <div className="flex gap-2">
              <button className="btn btn-ghost" onClick={toggleAll} disabled={running || brands.length === 0}>
                {selected.size === brands.length && brands.length > 0 ? "Deselect all" : "Select all"}
              </button>
              <button className="btn" onClick={runBatch} disabled={running || selected.size === 0}>
                {running ? "Running…" : `Enrich selected (${selected.size})`}
              </button>
            </div>
          </div>

          {progress && (
            <div className="mb-3 p-3 rounded border border-[var(--border-soft)] bg-[var(--bg-2)]">
              <div className="text-sm">
                {progress.done} / {progress.total} done
                {progress.current && <span className="text-[var(--text-muted)]"> · {progress.current}</span>}
              </div>
              <div className="h-1.5 mt-2 rounded bg-[var(--bg-3)] overflow-hidden">
                <div
                  className="h-full bg-[var(--accent)] transition-all"
                  style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
                />
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border-soft)]">
                  <th className="py-2 pr-3 w-8"></th>
                  <th className="py-2 pr-3">Brand</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Brand score</th>
                  <th className="py-2 pr-3">Est revenue</th>
                </tr>
              </thead>
              <tbody>
                {brands.length === 0 && (
                  <tr><td colSpan={5} className="py-6 text-center text-[var(--text-muted)]">All brands enriched.</td></tr>
                )}
                {brands.map((b) => (
                  <tr key={b.id} className="border-b border-[var(--border-soft)]">
                    <td className="py-2 pr-3">
                      <input
                        type="checkbox"
                        checked={selected.has(b.id)}
                        onChange={() => toggle(b.id)}
                        disabled={running}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <Link href={`/app/brands/${b.id}`} className="hover:underline">{b.name}</Link>
                    </td>
                    <td className="py-2 pr-3">{b.status}</td>
                    <td className="py-2 pr-3">{b.brand_score ?? "—"}</td>
                    <td className="py-2 pr-3">{b.est_monthly_revenue != null ? `$${Math.round(b.est_monthly_revenue).toLocaleString()}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "recent" && (
        <div className="card p-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border-soft)]">
                  <th className="py-2 pr-3">Brand</th>
                  <th className="py-2 pr-3">Validation</th>
                  <th className="py-2 pr-3">ASINs</th>
                  <th className="py-2 pr-3">Last enriched</th>
                </tr>
              </thead>
              <tbody>
                {recent.length === 0 && (
                  <tr><td colSpan={4} className="py-6 text-center text-[var(--text-muted)]">No enrichments yet.</td></tr>
                )}
                {recent.map((b) => (
                  <tr key={b.id} className="border-b border-[var(--border-soft)]">
                    <td className="py-2 pr-3">
                      <Link href={`/app/brands/${b.id}`} className="hover:underline">{b.name}</Link>
                    </td>
                    <td className="py-2 pr-3">{b.validation_score != null ? Math.round(b.validation_score) : "—"}</td>
                    <td className="py-2 pr-3">{b.keepa_asin_count ?? "—"}</td>
                    <td className="py-2 pr-3 text-[var(--text-muted)]">
                      {b.keepa_last_enriched_at ? new Date(b.keepa_last_enriched_at).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!running && results.length > 0 && (
        <div className="card p-4 mt-4">
          <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">Batch summary</div>
          <div className="text-sm mb-3">
            Enriched {results.filter((r) => r.ok).length} / {results.length} brand{results.length === 1 ? "" : "s"}.
          </div>
          {top5.length > 0 && (
            <div>
              <div className="text-xs text-[var(--text-muted)] mb-1">Top by validation score</div>
              <ol className="text-sm list-decimal pl-5 space-y-1">
                {top5.map((b) => (
                  <li key={b.id}>
                    <Link href={`/app/brands/${b.id}`} className="hover:underline">{b.name}</Link>
                    <span className="text-[var(--text-muted)]"> — {Math.round(b.score)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-2 text-sm transition-colors"
      style={{
        color: active ? "var(--text)" : "var(--text-muted)",
        borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
      }}
    >
      {children}
    </button>
  );
}
