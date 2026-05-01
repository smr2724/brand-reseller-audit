"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, XCircle, Loader2, Clock } from "lucide-react";

interface JobRow {
  id: string;
  status: string;
  payload: any;
  result_summary: any;
  error: string | null;
  related_opportunity_id: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface SweepRow {
  id: string;
  name: string | null;
  status: string;
  total_jobs: number;
  complete_jobs: number;
  failed_jobs: number;
}

export default function SweepProgress({ sweepId }: { sweepId: string }) {
  const [sweep, setSweep] = useState<SweepRow | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [done, setDone] = useState(false);

  async function tick() {
    const res = await fetch(`/api/sweeps/${sweepId}/status`);
    if (!res.ok) return;
    const data = await res.json();
    setSweep(data.sweep);
    setJobs(data.jobs);
    if (["complete", "failed", "cancelled"].includes(data.sweep?.status)) setDone(true);
  }

  useEffect(() => {
    tick();
    if (done) return;
    const id = setInterval(tick, 4000);
    return () => clearInterval(id);
  }, [sweepId, done]);

  if (!sweep) return <div className="text-sm text-[var(--text-muted)]">Loading…</div>;

  const pct = sweep.total_jobs ? Math.round((sweep.complete_jobs + sweep.failed_jobs) * 100 / sweep.total_jobs) : 0;
  const running = jobs.filter(j => j.status === "running").length;
  const pending = jobs.filter(j => j.status === "pending").length;
  const complete = jobs.filter(j => j.status === "complete").length;
  const failed = jobs.filter(j => j.status === "failed").length;
  const winners = jobs.filter(j => j.status === "complete" && (j.result_summary?.legion_score ?? 0) >= 80).length;

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold uppercase tracking-wider">Progress</div>
          <div className="text-sm text-[var(--text-muted)]">{sweep.complete_jobs + sweep.failed_jobs} / {sweep.total_jobs}</div>
        </div>
        <div className="h-2 rounded-full bg-[var(--bg-3)] overflow-hidden">
          <div className="h-full transition-all duration-500" style={{ width: `${pct}%`, background: "var(--accent)" }} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-4 text-center">
          <Stat label="Pending" value={pending} />
          <Stat label="Running" value={running} accent={running > 0} />
          <Stat label="Complete" value={complete} />
          <Stat label="Failed" value={failed} red={failed > 0} />
          <Stat label="Winners (≥80)" value={winners} accent={winners > 0} />
        </div>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--border-soft)] flex items-center justify-between">
          <div className="text-sm font-semibold uppercase tracking-wider">Seed Results</div>
          {!done && <div className="text-[10px] text-[var(--text-muted)] flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Auto-refreshing every 4s</div>}
        </div>
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] border-b border-[var(--border-soft)]">
            <tr>
              <th className="text-left px-4 py-2">Seed</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-right px-4 py-2">Score</th>
              <th className="text-right px-4 py-2">Volume</th>
              <th className="text-right px-4 py-2">Reviews</th>
              <th className="text-left px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map(j => {
              const seed = j.payload?.seed_keyword ?? "—";
              const r = j.result_summary ?? {};
              return (
                <tr key={j.id} className="border-b border-[var(--border-soft)] last:border-0">
                  <td className="px-4 py-2 font-medium">{seed}</td>
                  <td className="px-4 py-2"><StatusBadge status={j.status} /></td>
                  <td className="px-4 py-2 text-right tabular-nums" style={{ color: (r.legion_score ?? 0) >= 80 ? "var(--accent)" : undefined }}>
                    {r.legion_score ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.monthly_search_volume?.toLocaleString?.() ?? "—"}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.top_10_avg_reviews ?? "—"}</td>
                  <td className="px-4 py-2">
                    {j.related_opportunity_id ? <Link href={`/app/opportunities/${j.related_opportunity_id}`} className="text-xs hover:underline" style={{ color: "var(--accent)" }}>Open →</Link> : null}
                    {j.status === "failed" && j.error ? <span className="text-xs text-[var(--red)]" title={j.error}>error</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, accent, red }: { label: string; value: number; accent?: boolean; red?: boolean }) {
  return (
    <div className="rounded-md bg-[var(--bg-3)] py-2">
      <div className="text-xl font-semibold tabular-nums" style={{ color: red ? "var(--red)" : accent ? "var(--accent)" : undefined }}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "complete") return <span className="text-xs flex items-center gap-1" style={{ color: "var(--accent)" }}><CheckCircle2 size={12} /> Complete</span>;
  if (status === "failed") return <span className="text-xs flex items-center gap-1" style={{ color: "var(--red)" }}><XCircle size={12} /> Failed</span>;
  if (status === "running") return <span className="text-xs flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Running</span>;
  if (status === "pending") return <span className="text-xs text-[var(--text-muted)] flex items-center gap-1"><Clock size={12} /> Pending</span>;
  return <span className="text-xs text-[var(--text-muted)]">{status}</span>;
}
