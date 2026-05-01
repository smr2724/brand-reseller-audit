import { createSupabaseServerClient } from "@/lib/supabase/server";
import Link from "next/link";
import { Layers, Plus } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function SweepsIndex() {
  const supabase = createSupabaseServerClient();
  const { data: sweeps } = await supabase
    .from("sweeps")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Layers size={20} /> Sweeps
        </h1>
        <Link href="/app/scan/batch" className="btn btn-primary text-xs"><Plus size={14} /> New batch</Link>
      </div>

      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] border-b border-[var(--border-soft)]">
            <tr>
              <th className="text-left px-4 py-2">Name</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-right px-4 py-2">Progress</th>
              <th className="text-right px-4 py-2">Started</th>
            </tr>
          </thead>
          <tbody>
            {(sweeps ?? []).map(s => (
              <tr key={s.id} className="border-b border-[var(--border-soft)] last:border-0 hover:bg-[var(--bg-3)]">
                <td className="px-4 py-3"><Link href={`/app/sweeps/${s.id}`} className="font-medium hover:underline">{s.name ?? "Sweep"}</Link></td>
                <td className="px-4 py-3"><span className={`pill ${s.status === "complete" ? "pill-deep" : s.status === "running" ? "pill-watch" : s.status === "failed" ? "pill-reject" : "pill-new"}`}>{s.status}</span></td>
                <td className="px-4 py-3 text-right tabular-nums">{s.complete_jobs}/{s.total_jobs}{s.failed_jobs > 0 ? ` (${s.failed_jobs} failed)` : ""}</td>
                <td className="px-4 py-3 text-right text-[var(--text-muted)] text-xs">{new Date(s.started_at ?? s.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {!sweeps?.length && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">No sweeps yet. <Link href="/app/scan/batch" className="hover:underline" style={{ color: "var(--accent)" }}>Run your first batch →</Link></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
