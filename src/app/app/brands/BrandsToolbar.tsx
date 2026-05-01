"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

interface Props {
  defaults: { status: string; q: string; sort: string };
}

export default function BrandsToolbar({ defaults }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  const [status, setStatus] = useState(defaults.status);
  const [q, setQ] = useState(defaults.q);
  const [sort, setSort] = useState(defaults.sort);

  const [smartscoutUploading, setSmartscoutUploading] = useState(false);
  const [overlayUploading, setOverlayUploading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  function applyFilters(next: { status?: string; q?: string; sort?: string }) {
    const sp = new URLSearchParams(params?.toString() ?? "");
    const nextStatus = next.status ?? status;
    const nextQ = next.q ?? q;
    const nextSort = next.sort ?? sort;
    if (nextStatus) sp.set("status", nextStatus); else sp.delete("status");
    if (nextQ) sp.set("q", nextQ); else sp.delete("q");
    if (nextSort) sp.set("sort", nextSort); else sp.delete("sort");
    startTransition(() => {
      router.push(`/app/brands?${sp.toString()}`);
    });
  }

  async function uploadFile(file: File, sourceType: "smartscout_raw" | "initial_targets_analysis") {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("source_type", sourceType);
    if (sourceType === "smartscout_raw") setSmartscoutUploading(true);
    else setOverlayUploading(true);
    try {
      const res = await fetch("/api/imports", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        setToast(`Upload failed: ${data.error ?? "unknown error"}`);
      } else {
        setToast(`Imported ${data.row_count} rows — ${data.inserted} inserted, ${data.updated} updated, ${data.skipped} skipped`);
        router.refresh();
      }
    } catch (e) {
      setToast(`Upload error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSmartscoutUploading(false);
      setOverlayUploading(false);
      setTimeout(() => setToast(null), 8000);
    }
  }

  return (
    <div>
      {toast && (
        <div className="mb-4 card-soft p-3 text-sm border-[var(--accent)]/40">{toast}</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <UploadCard
          title="Upload SmartScout Export"
          subtitle="Raw brand list (.xlsx)"
          uploading={smartscoutUploading}
          onFile={(f) => uploadFile(f, "smartscout_raw")}
        />
        <UploadCard
          title="Upload Initial Targets Analysis"
          subtitle="Manual analysis overlay (.xlsx)"
          uploading={overlayUploading}
          onFile={(f) => uploadFile(f, "initial_targets_analysis")}
        />
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs text-[var(--text-muted)] mb-1">Search</label>
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") applyFilters({ q }); }}
            onBlur={() => applyFilters({ q })}
            placeholder="Brand name…"
          />
        </div>
        <div className="min-w-[160px]">
          <label className="block text-xs text-[var(--text-muted)] mb-1">Status</label>
          <select
            className="select"
            value={status}
            onChange={(e) => { setStatus(e.target.value); applyFilters({ status: e.target.value }); }}
          >
            <option value="">All</option>
            <option value="new">New</option>
            <option value="qualified">Qualified</option>
            <option value="disqualified">Disqualified</option>
            <option value="contacted">Contacted</option>
            <option value="client">Client</option>
          </select>
        </div>
        <div className="min-w-[200px]">
          <label className="block text-xs text-[var(--text-muted)] mb-1">Sort</label>
          <select
            className="select"
            value={sort}
            onChange={(e) => { setSort(e.target.value); applyFilters({ sort: e.target.value }); }}
          >
            <option value="score_desc">Brand Score (desc)</option>
            <option value="dominant_pct_asc">Dominant Seller % (asc)</option>
            <option value="revenue_desc">Est Monthly Revenue (desc)</option>
            <option value="name_asc">Name (A–Z)</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function UploadCard({
  title, subtitle, uploading, onFile,
}: { title: string; subtitle: string; uploading: boolean; onFile: (f: File) => void }) {
  const [dragActive, setDragActive] = useState(false);

  return (
    <label
      className={`card cursor-pointer p-4 flex items-center justify-between transition-colors ${
        dragActive ? "border-[var(--accent)]" : ""
      } ${uploading ? "opacity-60" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-xs text-[var(--text-muted)] mt-1">{subtitle}</div>
      </div>
      <div className="text-sm text-[var(--accent)]">
        {uploading ? "Uploading…" : "Choose file"}
      </div>
      <input
        type="file"
        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        disabled={uploading}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.currentTarget.value = "";
        }}
      />
    </label>
  );
}
