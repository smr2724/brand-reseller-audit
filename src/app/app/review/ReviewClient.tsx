"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { formatMoney, formatNumber } from "@/lib/utils";

type Brand = {
  id: string;
  name: string;
  category: string | null;
  brand_score: number | null;
  est_monthly_revenue: number | null;
  trailing_12_months: number | null;
  avg_sellers: number | null;
  avg_fba_sellers: number | null;
  dominant_seller_sales_pct: number | null;
  dominant_seller_country: string | null;
  dominant_seller_name: string | null;
  has_storefront: boolean | null;
  total_products: number | null;
  manual_notes: string | null;
  outreach_activity: string | null;
  current_profit: number | null;
  additional_profit: number | null;
  rcg_fees: number | null;
  new_profit: number | null;
  seven_x_multiple_value: number | null;
  disqualifier_tags: string[];
  status: string;
  priority_score?: number;
};

type Decision = "qualified" | "disqualified" | "needs_research" | "skip";

type Toast = { id: number; kind: "ok" | "err"; msg: string };

const DISQ_REASONS: { code: string; label: string }[] = [
  { code: "foreign_hq", label: "Foreign HQ" },
  { code: "chinese_drop_shipper", label: "Chinese drop-shipper" },
  { code: "amazon_owned", label: "Amazon-owned brand" },
  { code: "amazon_1p_vendor", label: "Amazon 1P vendor" },
  { code: "too_generic", label: "Too generic" },
  { code: "too_large", label: "Too large" },
  { code: "no_contact_path", label: "No contact path" },
  { code: "bad_website", label: "Bad website" },
  { code: "already_client", label: "Already a client" },
  { code: "other", label: "Other (specify)" },
];

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All open" },
  { value: "new", label: "New" },
  { value: "needs_research", label: "Needs research" },
];

export default function ReviewClient() {
  const [queue, setQueue] = useState<Brand[]>([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [includeRecent, setIncludeRecent] = useState(false);
  const [search, setSearch] = useState("");
  const [note, setNote] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalReason, setModalReason] = useState<string>("foreign_hq");
  const [otherReasonText, setOtherReasonText] = useState("");
  const [stats, setStats] = useState<StatsShape | null>(null);
  const [undo, setUndo] = useState<{ reviewId: string; expiresAt: number } | null>(null);
  const [, force] = useState(0);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  const current: Brand | undefined = queue[idx];

  const filteredQueue = useMemo(() => {
    if (!search.trim()) return queue;
    const s = search.trim().toLowerCase();
    return queue.filter((b) => b.name.toLowerCase().includes(s));
  }, [queue, search]);

  // Re-anchor idx when filteredQueue changes.
  useEffect(() => {
    if (idx >= filteredQueue.length) setIdx(Math.max(0, filteredQueue.length - 1));
  }, [filteredQueue.length, idx]);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (includeRecent) params.set("include_recent", "1");
      const res = await fetch(`/api/brands/queue?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error("queue fetch failed");
      const data = await res.json();
      setQueue(data.brands ?? []);
      setIdx(0);
    } catch (e) {
      pushToast("err", "Failed to load queue");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, includeRecent]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/reviews/stats", { cache: "no-store" });
      if (!res.ok) return;
      setStats(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // Reset note input when card changes.
  useEffect(() => {
    setNote("");
  }, [current?.id]);

  // Tick for undo countdown.
  useEffect(() => {
    if (!undo) return;
    const t = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [undo]);

  // Drop expired undo.
  useEffect(() => {
    if (undo && undo.expiresAt < Date.now()) setUndo(null);
  });

  const pushToast = useCallback((kind: "ok" | "err", msg: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  const submitDecision = useCallback(
    async (decision: Decision, opts?: { reason?: string; explicitNote?: string }) => {
      const brand = filteredQueue[idx];
      if (!brand) return;

      // Optimistic: drop card from local queue immediately, idx stays put → next card slides in.
      const submittedNote = opts?.explicitNote ?? note;
      setQueue((q) => q.filter((b) => b.id !== brand.id));
      setNote("");

      try {
        const res = await fetch("/api/reviews", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            brand_id: brand.id,
            decision,
            disqualifier_reason: opts?.reason ?? null,
            note: submittedNote || null,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "Save failed");
        }
        const data = await res.json();
        pushToast("ok", `${labelForDecision(decision)}: ${brand.name}`);
        if (decision !== "skip") {
          setUndo({ reviewId: data.review.id, expiresAt: Date.now() + 10_000 });
        }
        fetchStats();
      } catch {
        pushToast("err", `Save failed for ${brand.name} — reload to retry`);
      }
    },
    [filteredQueue, idx, note, pushToast, fetchStats]
  );

  const handleUndo = useCallback(async () => {
    if (!undo) return;
    const reviewId = undo.reviewId;
    setUndo(null);
    try {
      const res = await fetch(`/api/reviews?id=${reviewId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("undo failed");
      pushToast("ok", "Undone — reloading queue");
      await fetchQueue();
      await fetchStats();
    } catch {
      pushToast("err", "Undo failed");
    }
  }, [undo, fetchQueue, fetchStats, pushToast]);

  const openDisqualifierModal = useCallback(() => {
    setModalReason("foreign_hq");
    setOtherReasonText("");
    setModalOpen(true);
  }, []);

  const confirmDisqualifier = useCallback(() => {
    let reason = modalReason;
    if (reason === "other") {
      // Server only accepts the fixed code; freeform text goes into the note.
      reason = "other";
    }
    setModalOpen(false);
    const otherNote = modalReason === "other" && otherReasonText.trim()
      ? `[other] ${otherReasonText.trim()}`
      : "";
    submitDecision("disqualified", {
      reason,
      explicitNote: otherNote ? (note ? `${note}\n\n${otherNote}` : otherNote) : undefined,
    });
  }, [modalReason, otherReasonText, submitDecision, note]);

  // Hotkeys.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName?.toLowerCase();
      const isInput = tag === "input" || tag === "textarea" || tgt?.isContentEditable;

      if (modalOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setModalOpen(false);
        }
        if (e.key === "Enter" && !isInput) {
          e.preventDefault();
          confirmDisqualifier();
        }
        return;
      }

      if (isInput) {
        if (e.key === "Escape") {
          (tgt as HTMLElement).blur();
        }
        return;
      }

      const k = e.key.toLowerCase();
      if (k === "q") { e.preventDefault(); submitDecision("qualified"); }
      else if (k === "d") { e.preventDefault(); openDisqualifierModal(); }
      else if (k === "r") { e.preventDefault(); submitDecision("needs_research"); }
      else if (k === "s") { e.preventDefault(); submitDecision("skip"); }
      else if (k === "j" || e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault(); setIdx((i) => Math.min(i + 1, filteredQueue.length - 1));
      } else if (k === "k" || e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault(); setIdx((i) => Math.max(i - 1, 0));
      } else if (k === "n") {
        e.preventDefault();
        noteRef.current?.focus();
      } else if (k === "u") {
        if (undo && undo.expiresAt > Date.now()) {
          e.preventDefault();
          handleUndo();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDisqualifier, filteredQueue.length, handleUndo, modalOpen, openDisqualifierModal, submitDecision, undo]);

  const undoSecondsLeft = undo ? Math.max(0, Math.ceil((undo.expiresAt - Date.now()) / 1000)) : 0;

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto">
      <div className="flex items-baseline justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Brand Review</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">Q qualify · D disqualify · R research · S skip · J/K prev/next · N note</p>
        </div>
        <StatsStrip stats={stats} />
      </div>

      <div className="card p-3 flex items-center gap-3 flex-wrap mb-4">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-[var(--bg-3)] border border-[var(--border)] rounded px-2 py-1 text-sm"
        >
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
        <label className="text-sm flex items-center gap-2 text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={includeRecent}
            onChange={(e) => setIncludeRecent(e.target.checked)}
          />
          Include recently reviewed
        </label>
        <input
          type="text"
          placeholder="Quick filter…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-[var(--bg-3)] border border-[var(--border)] rounded px-2 py-1 text-sm flex-1 min-w-[200px]"
        />
        <div className="text-xs text-[var(--text-muted)] ml-auto">
          {loading ? "Loading…" : `Brand ${Math.min(idx + 1, filteredQueue.length)} of ${filteredQueue.length} in queue`}
        </div>
      </div>

      {!loading && filteredQueue.length === 0 && (
        <EmptyState />
      )}

      {current && (
        <BrandCard brand={current} note={note} setNote={setNote} noteRef={noteRef} />
      )}

      {/* Bottom action bar */}
      {current && (
        <div className="sticky bottom-0 bg-[var(--bg)] border-t border-[var(--border)] mt-4 pt-3 pb-3 -mx-4 md:-mx-6 px-4 md:px-6">
          <div className="flex flex-wrap gap-2">
            <ActionBtn label="Qualified" hotkey="Q" tone="green" onClick={() => submitDecision("qualified")} />
            <ActionBtn label="Disqualified" hotkey="D" tone="red" onClick={openDisqualifierModal} />
            <ActionBtn label="Needs research" hotkey="R" tone="yellow" onClick={() => submitDecision("needs_research")} />
            <ActionBtn label="Skip" hotkey="S" tone="gray" onClick={() => submitDecision("skip")} />
            <div className="flex-1" />
            <button
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              className="btn btn-ghost text-sm"
              type="button"
            >← Prev (K)</button>
            <button
              onClick={() => setIdx((i) => Math.min(filteredQueue.length - 1, i + 1))}
              className="btn btn-ghost text-sm"
              type="button"
            >Next (J) →</button>
            {undo && undoSecondsLeft > 0 && (
              <button
                onClick={handleUndo}
                className="btn text-sm"
                style={{ background: "#3a2a10", color: "#fbbf24", border: "1px solid #5b3f1a" }}
                type="button"
              >
                Undo last ({undoSecondsLeft}s)
              </button>
            )}
          </div>
        </div>
      )}

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="rounded px-3 py-2 text-sm shadow-md"
            style={{
              background: t.kind === "err" ? "#3a1416" : "#10271b",
              color: t.kind === "err" ? "#fca5a5" : "#86efac",
              border: `1px solid ${t.kind === "err" ? "#5b1e23" : "#1e4a35"}`,
            }}
          >
            {t.msg}
          </div>
        ))}
      </div>

      {/* Disqualifier modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setModalOpen(false)}>
          <div
            className="card p-5 w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-base font-semibold mb-2">Disqualify {current?.name}</div>
            <div className="text-xs text-[var(--text-muted)] mb-3">Pick the primary reason — Enter to confirm.</div>
            <div className="space-y-1 mb-3">
              {DISQ_REASONS.map((r) => (
                <label key={r.code} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-[var(--bg-3)] rounded px-2 py-1">
                  <input
                    type="radio"
                    name="reason"
                    value={r.code}
                    checked={modalReason === r.code}
                    onChange={() => setModalReason(r.code)}
                  />
                  <span>{r.label}</span>
                </label>
              ))}
            </div>
            {modalReason === "other" && (
              <input
                autoFocus
                type="text"
                placeholder="Brief reason…"
                value={otherReasonText}
                onChange={(e) => setOtherReasonText(e.target.value)}
                className="bg-[var(--bg-3)] border border-[var(--border)] rounded px-2 py-1 text-sm w-full mb-3"
              />
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setModalOpen(false)} className="btn btn-ghost text-sm" type="button">Cancel</button>
              <button onClick={confirmDisqualifier} className="btn text-sm" style={{ background: "#3a1416", color: "#fca5a5", border: "1px solid #5b1e23" }} type="button">Confirm (Enter)</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function labelForDecision(d: Decision) {
  switch (d) {
    case "qualified": return "Qualified";
    case "disqualified": return "Disqualified";
    case "needs_research": return "Needs research";
    case "skip": return "Skipped";
  }
}

function ActionBtn({ label, hotkey, tone, onClick }: { label: string; hotkey: string; tone: "green" | "red" | "yellow" | "gray"; onClick: () => void }) {
  const palette: Record<string, { bg: string; fg: string; border: string }> = {
    green: { bg: "#10271b", fg: "#86efac", border: "#1e4a35" },
    red: { bg: "#3a1416", fg: "#fca5a5", border: "#5b1e23" },
    yellow: { bg: "#3a2a10", fg: "#fbbf24", border: "#5b3f1a" },
    gray: { bg: "var(--bg-3)", fg: "var(--text)", border: "var(--border)" },
  };
  const p = palette[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-4 py-2 rounded text-sm font-medium flex items-center gap-2"
      style={{ background: p.bg, color: p.fg, border: `1px solid ${p.border}` }}
    >
      <span>{label}</span>
      <kbd
        className="px-1.5 py-0.5 rounded text-[10px] font-mono"
        style={{ background: "rgba(0,0,0,0.3)", color: p.fg, border: `1px solid ${p.border}` }}
      >{hotkey}</kbd>
    </button>
  );
}

function BrandCard({ brand, note, setNote, noteRef }: { brand: Brand; note: string; setNote: (v: string) => void; noteRef: React.RefObject<HTMLTextAreaElement> }) {
  const dom = Number(brand.dominant_seller_sales_pct ?? 0);
  const domHigh = dom > 0.5;

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-2xl font-semibold tracking-tight">{brand.name}</h2>
            <span className="px-2 py-0.5 rounded text-xs bg-[var(--bg-3)] border border-[var(--border)]">{brand.status}</span>
            {brand.priority_score !== undefined && (
              <span className="text-xs text-[var(--text-muted)]" title="Priority score (higher = more important)">
                priority {brand.priority_score.toFixed(1)}
              </span>
            )}
          </div>
          <div className="text-sm text-[var(--text-muted)] mt-1">{brand.category ?? "—"}</div>
          {brand.disqualifier_tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {brand.disqualifier_tags.map((t) => (
                <span key={t} className="px-1.5 py-0.5 rounded text-[10px] bg-[#2a1415] text-[#f87171] border border-[#4a1e21]">{t}</span>
              ))}
            </div>
          )}
        </div>
        <Link href={`/app/brands/${brand.id}`} target="_blank" className="text-xs text-[var(--text-muted)] underline">
          Open detail ↗
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Left column: signals */}
        <div className="space-y-3">
          <Stat label="Brand Score">
            <ScoreGauge value={brand.brand_score} />
          </Stat>
          <Stat label="Est Monthly Revenue">{formatMoney(brand.est_monthly_revenue)}</Stat>
          <Stat label="Trailing 12 Months">{formatMoney(brand.trailing_12_months)}</Stat>
          <Stat label="Dominant Seller %">
            <DomBar value={dom} high={domHigh} />
          </Stat>
          <Stat label="Dominant Seller">
            {brand.dominant_seller_name ?? "—"}
            {brand.dominant_seller_country ? <span className="text-[var(--text-muted)]"> · {brand.dominant_seller_country}</span> : null}
          </Stat>
          <Stat label="Avg Sellers / FBA">
            {formatNumber(brand.avg_sellers, { decimals: 1 })} <span className="text-[var(--text-muted)]">/</span> {formatNumber(brand.avg_fba_sellers, { decimals: 1 })}
          </Stat>
          <Stat label="Has Storefront">{brand.has_storefront == null ? "—" : brand.has_storefront ? "Yes" : "No"}</Stat>
          <Stat label="Total Products">{formatNumber(brand.total_products)}</Stat>
        </div>

        {/* Right column: notes + financial model */}
        <div className="space-y-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-2">Analyst notes</div>
            <div
              className="card-soft p-3 text-sm whitespace-pre-wrap min-h-[80px] max-h-[200px] overflow-auto"
              style={{ color: brand.manual_notes ? "var(--text)" : "var(--text-muted)" }}
            >
              {brand.manual_notes ?? "No analyst notes"}
            </div>
          </div>

          {brand.outreach_activity && (
            <div>
              <div className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-2">Outreach activity</div>
              <div className="card-soft p-3 text-sm whitespace-pre-wrap">{brand.outreach_activity}</div>
            </div>
          )}

          <div>
            <div className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-2">Financial model</div>
            <div className="card-soft p-3 text-sm grid grid-cols-2 gap-2">
              <Mini label="Current profit" value={formatMoney(brand.current_profit)} />
              <Mini label="Additional profit" value={formatMoney(brand.additional_profit)} />
              <Mini label="RCG fees" value={formatMoney(brand.rcg_fees)} />
              <Mini label="New profit" value={formatMoney(brand.new_profit)} />
              <Mini label="7× multiple" value={formatMoney(brand.seven_x_multiple_value)} />
            </div>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-2">Note (saved with decision)</div>
            <textarea
              ref={noteRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional — press N to focus, Esc to blur"
              rows={3}
              className="bg-[var(--bg-3)] border border-[var(--border)] rounded px-2 py-1 text-sm w-full"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center gap-3 border-b border-[var(--border-soft)] pb-2">
      <div className="text-xs uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
      <div className="text-sm font-medium text-right max-w-[60%]">{children}</div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

function ScoreGauge({ value }: { value: number | null }) {
  const v = Number(value ?? 0);
  const pct = Math.max(0, Math.min(100, (v / 10) * 100));
  return (
    <div className="flex items-center gap-2 min-w-[160px]">
      <div className="flex-1 h-2 rounded bg-[var(--bg-3)] overflow-hidden border border-[var(--border)]">
        <div style={{ width: `${pct}%`, background: "var(--accent)", height: "100%" }} />
      </div>
      <div className="font-mono text-sm">{value == null ? "—" : v.toFixed(1)}</div>
    </div>
  );
}

function DomBar({ value, high }: { value: number; high: boolean }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div className="flex items-center gap-2 min-w-[160px]">
      <div className="flex-1 h-2 rounded bg-[var(--bg-3)] overflow-hidden border border-[var(--border)]">
        <div
          style={{ width: `${pct}%`, background: high ? "#f87171" : "var(--accent)", height: "100%" }}
        />
      </div>
      <div className="font-mono text-sm" style={{ color: high ? "#f87171" : "var(--text)" }}>{pct.toFixed(0)}%</div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="card p-8 text-center">
      <div className="text-base font-medium mb-1">Queue is clear.</div>
      <div className="text-sm text-[var(--text-muted)] mb-4">
        You&apos;ve cleared the queue. Come back tomorrow, or include recently-reviewed brands above.
      </div>
      <Link href="/app/brands" className="btn btn-ghost text-sm inline-block">Go to Brands</Link>
    </div>
  );
}

type StatsShape = {
  total_brands: number;
  by_status: Record<string, number>;
  queue_remaining: number;
  reviewed_last_7d: number;
  decisions_last_7d: Record<string, number>;
  disqualifier_breakdown: Record<string, number>;
};

function StatsStrip({ stats }: { stats: StatsShape | null }) {
  if (!stats) return null;
  const items: { label: string; value: string | number }[] = [
    { label: "In queue", value: stats.queue_remaining },
    { label: "Reviewed 7d", value: stats.reviewed_last_7d },
    { label: "Qualified", value: stats.by_status.qualified ?? 0 },
    { label: "Disqualified", value: stats.by_status.disqualified ?? 0 },
    { label: "Needs research", value: stats.by_status.needs_research ?? 0 },
  ];
  return (
    <div className="flex gap-3 flex-wrap">
      {items.map((i) => (
        <div key={i.label} className="card-soft px-3 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{i.label}</div>
          <div className="text-sm font-semibold">{i.value}</div>
        </div>
      ))}
    </div>
  );
}
