"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect } from "react";

const STATUSES = ["", "new", "deep_dive", "review", "watchlist", "reject", "find_manufacturers", "outreach_ready", "active_deal"];
const STATUS_LABEL: Record<string, string> = {
  "": "All statuses",
  new: "New", deep_dive: "Deep Dive", review: "Review", watchlist: "Watchlist",
  reject: "Reject", find_manufacturers: "Find Mfrs", outreach_ready: "Outreach Ready", active_deal: "Active Deal",
};
const PATHS = ["", "partner", "launch", "acquire", "avoid"];
const PATH_LABEL: Record<string, string> = { "": "All paths", partner: "Partner", launch: "Launch", acquire: "Acquire", avoid: "Avoid" };
const SORTS = [
  { v: "score_desc", l: "Score ↓" },
  { v: "score_asc", l: "Score ↑" },
  { v: "demand_desc", l: "Demand ↓" },
  { v: "comp_desc", l: "Comp. weak ↓" },
  { v: "last_scanned", l: "Last scanned" },
];

export default function DashboardFilters({
  categories,
  initial,
  archivedCount,
  showArchived,
}: {
  categories: string[];
  initial: any;
  archivedCount?: number;
  showArchived?: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(initial.q ?? "");

  useEffect(() => { setQ(initial.q ?? ""); }, [initial.q]);

  function update(key: string, val: string) {
    const sp = new URLSearchParams(params.toString());
    if (val) sp.set(key, val); else sp.delete(key);
    router.push(`/app/dashboard?${sp.toString()}`);
  }

  function toggleArchived() {
    const sp = new URLSearchParams(params.toString());
    if (showArchived) sp.delete("archived"); else sp.set("archived", "1");
    router.push(`/app/dashboard?${sp.toString()}`);
  }

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault(); update("q", q.trim());
  }

  return (
    <div className="card p-3 md:p-4">
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
        <form onSubmit={onSearchSubmit} className="col-span-2 md:col-span-2">
          <input className="input" placeholder="Search keyword…" value={q} onChange={e => setQ(e.target.value)} />
        </form>

        <select className="select" value={initial.status ?? ""} onChange={e => update("status", e.target.value)}>
          {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>

        <select className="select" value={initial.path ?? ""} onChange={e => update("path", e.target.value)}>
          {PATHS.map(p => <option key={p} value={p}>{PATH_LABEL[p]}</option>)}
        </select>

        <select className="select" value={initial.category ?? ""} onChange={e => update("category", e.target.value)}>
          <option value="">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        <select className="select" value={initial.sort ?? "score_desc"} onChange={e => update("sort", e.target.value)}>
          {SORTS.map(s => <option key={s.v} value={s.v}>Sort: {s.l}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
        <input
          className="input" type="number" placeholder="Min score" min={0} max={100}
          defaultValue={initial.min_score ?? ""} onBlur={e => update("min_score", e.target.value)}
        />
        <input
          className="input" type="number" placeholder="Min monthly vol" min={0}
          defaultValue={initial.min_vol ?? ""} onBlur={e => update("min_vol", e.target.value)}
        />
        <input
          className="input" type="number" placeholder="Max top-10 reviews" min={0}
          defaultValue={initial.max_reviews ?? ""} onBlur={e => update("max_reviews", e.target.value)}
        />
        <button className="btn" onClick={() => router.push("/app/dashboard")}>Clear filters</button>
      </div>

      <div className="flex items-center justify-end mt-2">
        <button
          type="button"
          onClick={toggleArchived}
          className={`btn text-xs ${showArchived ? "btn-primary" : ""}`}
          title={showArchived ? "Back to active" : "View archived opportunities"}
        >
          {showArchived
            ? "← Show active"
            : `Show archived${archivedCount ? ` (${archivedCount})` : ""}`}
        </button>
      </div>
    </div>
  );
}
