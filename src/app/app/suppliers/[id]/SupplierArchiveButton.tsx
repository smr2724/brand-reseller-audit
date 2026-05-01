"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export default function SupplierArchiveButton({ id, archived }: { id: string; archived: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function run() {
    if (busy) return;
    const action = archived ? "restore" : "archive";
    if (!archived) {
      const ok = window.confirm("Archive this supplier? It won't appear on the suppliers list or in opportunity match cards until restored.");
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/suppliers/${id}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(`Failed: ${j.error ?? res.statusText}`);
        return;
      }
      startTransition(() => router.refresh());
      if (!archived) router.push("/app/suppliers");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy || pending}
      className="btn text-xs"
      title={archived ? "Restore to active" : "Archive this supplier"}
    >
      {busy || pending ? "…" : archived ? "♻ Restore" : "📦 Archive"}
    </button>
  );
}
