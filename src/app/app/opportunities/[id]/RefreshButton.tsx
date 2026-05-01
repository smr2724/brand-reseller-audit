"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { RefreshCw } from "lucide-react";

export default function RefreshButton({ id }: { id: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    try {
      const res = await fetch(`/api/opportunities/${id}/refresh`, { method: "POST" });
      const data = await res.json();
      if (data?.opportunityId) router.push(`/app/opportunities/${data.opportunityId}`);
      else router.refresh();
    } finally { setLoading(false); }
  }

  return (
    <button className="btn" onClick={run} disabled={loading}>
      <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
      {loading ? "Refreshing…" : "Refresh data"}
    </button>
  );
}
