"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

const ACTIONS: { key: string; label: string; cls: string }[] = [
  { key: "reject", label: "Reject", cls: "pill-reject" },
  { key: "watchlist", label: "Watchlist", cls: "pill-watchlist" },
  { key: "deep_dive", label: "Deep Dive", cls: "pill-deep_dive" },
  { key: "find_manufacturers", label: "Find Mfrs", cls: "pill-find_manufacturers" },
  { key: "outreach_ready", label: "Outreach", cls: "pill-outreach_ready" },
  { key: "active_deal", label: "Active Deal", cls: "pill-active_deal" },
];

export default function DecisionButtons({ id, status }: { id: string; status?: string | null }) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);

  async function click(key: string) {
    setLoading(key);
    try {
      await fetch(`/api/opportunities/${id}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: key }),
      });
      router.refresh();
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {ACTIONS.map(a => {
        const active = status === a.key;
        return (
          <button
            key={a.key} onClick={() => click(a.key)} disabled={loading !== null}
            className={`pill ${a.cls}`}
            style={{
              cursor: "pointer", padding: "5px 12px", fontSize: 12,
              outline: active ? "2px solid rgba(201,169,106,0.7)" : "none",
              outlineOffset: active ? 2 : 0,
            }}
          >{loading === a.key ? "…" : a.label}</button>
        );
      })}
    </div>
  );
}
