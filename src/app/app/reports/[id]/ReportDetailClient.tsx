"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  reportId: string;
  brandId: string | null;
  status: string;
  downloadHref: string;
}

export default function ReportDetailClient({ reportId, brandId, status, downloadHref }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function regenerate() {
    if (!brandId) {
      setMsg("Cannot regenerate: this report is not linked to a brand.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/reports/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_id: brandId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(`Regenerate failed: ${data.error ?? "unknown"}`);
        return;
      }
      if (data.report_id) {
        router.push(`/app/reports/${data.report_id}`);
        router.refresh();
      } else {
        setMsg("Regenerate started.");
        router.refresh();
      }
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteReport() {
    if (!confirm("Delete this report? This cannot be undone.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/reports/${reportId}`, { method: "DELETE" });
      if (res.ok) router.push("/app/reports");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {status === "completed" && (
        <a className="btn" href={downloadHref}>
          Download
        </a>
      )}
      <button className="btn btn-ghost" onClick={regenerate} disabled={busy}>
        {busy ? "Working…" : "Regenerate"}
      </button>
      <button className="btn btn-danger" onClick={deleteReport} disabled={busy}>
        Delete
      </button>
      {msg && <span className="text-xs text-[var(--text-muted)] ml-2">{msg}</span>}
    </div>
  );
}
