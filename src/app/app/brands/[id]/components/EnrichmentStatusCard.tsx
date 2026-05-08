"use client";
/**
 * Phase 51 — Live status feed for /app/brands/[id].
 *
 * Renders above the QualificationReview card. Polls
 * `/api/brands/[id]/status` every 3s while `is_busy=true`. The four
 * user-facing rows are derived from the server's step resolver:
 *
 *   1. Amazon seller data           (Keepa)
 *   2. Search trend data            (DataForSEO)
 *   3. Brand qualification          (disambiguation + ICP + narrative)
 *   4. Contact discovery            (Apollo + Hunter + MillionVerifier)
 *
 * Polling pauses while the tab is hidden and stops after `is_busy`
 * comes back false twice in a row, so a brand sitting in 'Done' state
 * does not drive needless requests.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";

interface StatusResponse {
  enrichment_state: "pending" | "queued" | "enriching" | "enriched" | "failed" | "deferred";
  qualification_state: "pending" | "running" | "complete" | "skipped" | "error";
  contacts_state: "pending" | "running" | "complete" | "skipped" | "error";
  current_step: string;
  current_step_detail: string | null;
  step_started_at: string;
  total_started_at: string;
  last_updated_at: string;
  error_message: string | null;
  is_busy: boolean;
  is_stale: boolean;
  expected_step_duration_seconds: number;
}

type DisplayState = "pending" | "running" | "done" | "error";
interface DisplayStep {
  key: "keepa" | "dataforseo" | "qualification" | "contacts";
  label: string;
  state: DisplayState;
  detail: string | null;
}

interface Props {
  brandId: string;
  /** Initial busy hint — set by the parent when the user hits Re-qualify
   * so the card appears immediately, before the first poll lands. */
  initiallyBusy?: boolean;
}

export default function EnrichmentStatusCard({
  brandId,
  initiallyBusy = false,
}: Props) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [optimisticBusy, setOptimisticBusy] = useState<boolean>(initiallyBusy);
  const [tick, setTick] = useState(0); // re-render once a second for live elapsed
  const consecutiveDoneRef = useRef(0);
  const stoppedRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/brands/${brandId}/status`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as StatusResponse;
      setStatus(data);
      // Once we have a real status, drop the optimistic flag.
      if (optimisticBusy) setOptimisticBusy(false);
      if (!data.is_busy) {
        consecutiveDoneRef.current += 1;
        if (consecutiveDoneRef.current >= 2) {
          stoppedRef.current = true;
        }
      } else {
        consecutiveDoneRef.current = 0;
      }
    } catch {
      // Swallow — next tick retries.
    }
  }, [brandId, optimisticBusy]);

  useEffect(() => {
    void fetchStatus();
    const interval = setInterval(() => {
      if (stoppedRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void fetchStatus();
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Resume polling on visibility change.
  useEffect(() => {
    function onVis() {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        !stoppedRef.current
      ) {
        void fetchStatus();
      }
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVis);
      return () => document.removeEventListener("visibilitychange", onVis);
    }
  }, [fetchStatus]);

  // 1Hz tick so the running step's elapsed timer ticks live.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const isBusy = status?.is_busy ?? optimisticBusy;
  if (!isBusy && !status?.error_message) return null;
  // Reference tick so React's lint doesn't strip the dependency. The
  // running-row elapsed-seconds calculation already reads it implicitly
  // through Date.now(), but mention it here to make the intent obvious.
  void tick;

  const steps: DisplayStep[] = buildDisplaySteps(status);
  const runningStep = steps.find((s) => s.state === "running") ?? null;

  return (
    <div
      className={`card p-4 mb-4 ${status?.is_stale ? "border-amber-600/70" : ""}`}
      data-testid="enrichment-status-card"
    >
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-base font-semibold">Working on this brand…</h2>
        <span className="text-xs text-[var(--text-muted)]">
          {status?.total_started_at
            ? `Started ${formatDuration(secondsSince(status.total_started_at))} ago`
            : ""}
        </span>
      </div>
      <ol className="space-y-2 text-sm">
        {steps.map((step) => (
          <li key={step.key} className="flex items-start gap-3">
            <StateIcon state={step.state} />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className={
                    step.state === "running"
                      ? "font-medium"
                      : step.state === "done"
                        ? "text-[var(--text-muted)]"
                        : ""
                  }
                >
                  {step.label}
                </span>
                <StepTiming step={step} status={status} />
              </div>
              {step.detail ? (
                <div className="text-xs text-[var(--text-muted)] mt-0.5">{step.detail}</div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {status?.is_stale && runningStep ? (
        <div className="mt-3 text-xs text-amber-300">
          Taking longer than usual — this is normal for large brands. Refreshing every 3 seconds.
        </div>
      ) : null}
      {status?.error_message ? (
        <div className="mt-3 rounded border border-red-700 bg-red-900/30 p-3 text-sm text-red-200">
          <div className="font-medium">{status.current_step}</div>
          <div className="mt-1 text-xs">Try the Re-qualify button below.</div>
        </div>
      ) : null}
    </div>
  );
}

function StateIcon({ state }: { state: DisplayState }) {
  if (state === "done") {
    return (
      <span
        aria-hidden
        className="inline-block w-4 h-4 mt-0.5 rounded-full bg-green-600/40 border border-green-600/70 text-[10px] leading-[14px] text-center text-green-200"
      >
        ✓
      </span>
    );
  }
  if (state === "running") {
    return (
      <span
        aria-hidden
        className="inline-block w-4 h-4 mt-0.5 rounded-full border-2 border-[var(--accent,#60a5fa)] border-t-transparent animate-spin"
      />
    );
  }
  if (state === "error") {
    return (
      <span
        aria-hidden
        className="inline-block w-4 h-4 mt-0.5 rounded-full bg-red-700/40 border border-red-700 text-[10px] leading-[14px] text-center text-red-200"
      >
        ✕
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="inline-block w-4 h-4 mt-0.5 rounded-full bg-[var(--surface-2,rgba(255,255,255,0.06))] border border-[var(--border-soft,rgba(255,255,255,0.12))] text-[10px] leading-[14px] text-center text-[var(--text-muted)]"
    >
      ·
    </span>
  );
}

function StepTiming({
  step,
  status,
}: {
  step: DisplayStep;
  status: StatusResponse | null;
}) {
  if (!status) return null;
  if (step.state === "running") {
    const elapsed = secondsSince(status.step_started_at);
    return (
      <span className="text-xs text-[var(--text-muted)] tabular-nums">
        {formatDuration(elapsed)}
      </span>
    );
  }
  if (step.state === "done") {
    return <span className="text-xs text-[var(--text-muted)]">Done</span>;
  }
  return null;
}

function buildDisplaySteps(status: StatusResponse | null): DisplayStep[] {
  // Order matches the four user-facing pipeline phases.
  const enr = status?.enrichment_state ?? "pending";
  const qual = status?.qualification_state ?? "pending";
  const contacts = status?.contacts_state ?? "pending";
  const enrFailed = enr === "failed";
  const qualFailed = qual === "error";
  const contactsFailed = contacts === "error";

  // Keepa
  let keepaState: DisplayState;
  if (enrFailed && !status?.qualification_state) keepaState = "error";
  else if (
    enr === "enriched" ||
    qual !== "pending" ||
    contacts !== "pending" ||
    !!status?.last_updated_at && enr !== "enriching" && enr !== "pending" && enr !== "queued"
  ) {
    keepaState = "done";
  } else if (
    enr === "enriching" &&
    !status?.current_step.toLowerCase().includes("dataforseo") &&
    !status?.current_step.toLowerCase().includes("search trend")
  ) {
    keepaState = "running";
  } else if (enr === "enriching") {
    // Currently in DataForSEO sub-step → Keepa is done.
    keepaState = "done";
  } else if (enr === "pending" || enr === "queued") {
    keepaState = status?.is_busy ? "running" : "pending";
  } else {
    keepaState = "pending";
  }

  // DataForSEO
  let dfsState: DisplayState;
  if (
    enr === "enriching" &&
    (status?.current_step.toLowerCase().includes("dataforseo") ||
      status?.current_step.toLowerCase().includes("search trend"))
  ) {
    dfsState = "running";
  } else if (
    enr === "enriched" ||
    qual !== "pending" ||
    contacts !== "pending"
  ) {
    dfsState = "done";
  } else if (enrFailed) {
    dfsState = "error";
  } else {
    dfsState = "pending";
  }

  // Brand qualification (collapsed)
  let qualDispState: DisplayState;
  let qualDetail: string | null = null;
  if (qualFailed) {
    qualDispState = "error";
  } else if (qual === "complete" || qual === "skipped") {
    qualDispState = "done";
  } else if (qual === "running") {
    qualDispState = "running";
    qualDetail = subStepFromCurrent(status?.current_step ?? "");
  } else if (qual === "pending" && enr === "enriched") {
    qualDispState = "running";
    qualDetail = "Queued";
  } else {
    qualDispState = "pending";
  }

  // Contact discovery
  let contactsDispState: DisplayState;
  if (contactsFailed) {
    contactsDispState = "error";
  } else if (contacts === "complete" || contacts === "skipped") {
    contactsDispState = "done";
  } else if (contacts === "running") {
    contactsDispState = "running";
  } else if (contacts === "pending" && qual === "complete") {
    contactsDispState = "running";
    return [
      { key: "keepa", label: "Amazon seller data", state: keepaState, detail: null },
      { key: "dataforseo", label: "Search trend data", state: dfsState, detail: null },
      { key: "qualification", label: "Brand qualification", state: qualDispState, detail: qualDetail },
      { key: "contacts", label: "Contact discovery", state: "running", detail: "Queued" },
    ];
  } else {
    contactsDispState = "pending";
  }

  return [
    { key: "keepa", label: "Amazon seller data", state: keepaState, detail: null },
    { key: "dataforseo", label: "Search trend data", state: dfsState, detail: null },
    { key: "qualification", label: "Brand qualification", state: qualDispState, detail: qualDetail },
    { key: "contacts", label: "Contact discovery", state: contactsDispState, detail: null },
  ];
}

function subStepFromCurrent(currentStep: string): string | null {
  const s = currentStep.toLowerCase();
  if (s.includes("disambiguat")) return "Disambiguating legal entity";
  if (s.includes("icp")) return "Running ICP analysis";
  if (s.includes("narrative") || s.includes("analyst-memo")) {
    return "Generating analyst-memo narrative";
  }
  if (s.includes("queued for brand qualification")) return "Queued";
  if (s.includes("wrapping up qualification")) return "Wrapping up";
  return null;
}

function secondsSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm.toString().padStart(2, "0")}m`;
}
