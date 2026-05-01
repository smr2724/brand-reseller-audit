"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, RefreshCw } from "lucide-react";

interface Props {
  opportunityId: string;
  hasSuppliers: boolean;
  scanStatus?: string | null;
  initialJobId?: string | null;
}

export default function FindSuppliersButton({ opportunityId, hasSuppliers, scanStatus, initialJobId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(initialJobId ?? null);
  const [pollStatus, setPollStatus] = useState<string | null>(scanStatus ?? null);
  const [err, setErr] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll the job until it finishes, then refresh the page.
  useEffect(() => {
    if (!jobId) return;
    if (pollTimer.current) clearInterval(pollTimer.current);

    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/status?job_id=${jobId}`);
        const data = await res.json();
        if (!res.ok) return;
        setPollStatus(data.status);
        if (["complete", "failed", "cancelled"].includes(data.status)) {
          if (pollTimer.current) clearInterval(pollTimer.current);
          pollTimer.current = null;
          setJobId(null);
          setBusy(false);
          if (data.status === "failed") setErr(data.error ?? "Scan failed");
          router.refresh();
        }
      } catch {
        /* swallow */
      }
    };
    tick();
    pollTimer.current = setInterval(tick, 4000);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [jobId, router]);

  async function trigger() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/opportunities/${opportunityId}/find-suppliers`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      setJobId(data.job_id);
      setPollStatus("running");
    } catch (e: any) {
      setErr(e?.message ?? "Failed");
      setBusy(false);
    }
  }

  const isRunning = busy || pollStatus === "running" || pollStatus === "pending";
  const label = isRunning
    ? "Scanning suppliers… (may take ~2 min)"
    : hasSuppliers
      ? "Re-scan suppliers"
      : "Find suppliers";
  const Icon = hasSuppliers ? RefreshCw : Search;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button onClick={trigger} disabled={isRunning} className="btn btn-primary text-xs">
        <Icon size={14} className={isRunning ? "animate-spin" : ""} />
        {label}
      </button>
      {err && <span className="text-xs text-[var(--red)]">{err}</span>}
    </div>
  );
}
