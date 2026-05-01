import { cn } from "@/lib/utils";

export function LegionScore({ value, size = "md" }: { value?: number | null; size?: "sm" | "md" | "lg" | "xl" }) {
  const v = Math.round(Number(value ?? 0));
  const cls = v >= 80 ? "score-high" : v >= 65 ? "score-mid" : v >= 50 ? "" : "score-low";
  const px = size === "xl" ? "text-5xl" : size === "lg" ? "text-3xl" : size === "md" ? "text-xl" : "text-base";
  return <span className={cn("score-lg", cls, px)}>{v}</span>;
}

const LABEL: Record<string, string> = {
  new: "New",
  deep_dive: "Deep Dive",
  review: "Review",
  watchlist: "Watchlist",
  reject: "Reject",
  find_manufacturers: "Find Mfrs",
  outreach_ready: "Outreach Ready",
  active_deal: "Active Deal",
  partner: "Partner",
  launch: "Launch",
  acquire: "Acquire",
  avoid: "Avoid",
};

export function StatusPill({ value }: { value?: string | null }) {
  if (!value) return <span className="pill pill-new">New</span>;
  const label = LABEL[value] ?? value;
  return <span className={`pill pill-${value}`}>{label}</span>;
}

export function PathPill({ value }: { value?: string | null }) {
  if (!value) return <span className="text-[var(--text-muted)] text-xs">—</span>;
  const label = LABEL[value] ?? value;
  return <span className={`pill pill-${value}`}>{label}</span>;
}

export function ScoreBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const color = pct >= 75 ? "#86efac" : pct >= 50 ? "#fde047" : pct >= 25 ? "#fdba74" : "#fca5a5";
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-[var(--text-muted)]">{label}</span>
        <span className="text-xs font-semibold">{value}<span className="text-[var(--text-muted)]">/{max}</span></span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-[var(--bg-3)] overflow-hidden">
        <div style={{ width: `${pct}%`, background: color, transition: "width 0.3s" }} className="h-full" />
      </div>
    </div>
  );
}
