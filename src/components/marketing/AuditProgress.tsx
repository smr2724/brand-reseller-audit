"use client";

/**
 * Phase 21 — Live audit progress UI.
 *
 * Polls /api/public/report-status?token=... every 4s and renders a step
 * checklist + percent bar. Used on:
 *   - /audit-request/verify (after the prospect clicks the email link)
 *   - /app/reports/[id]    (Steve's dashboard, when status='generating')
 *
 * No prop drilling — pass the public token (or null if we only have the
 * authenticated reportId, in which case `reportLookupHref` is shown as a
 * "view when ready" link). Self-stops polling on completed/failed.
 */

import { useEffect, useState, useRef } from "react";

type Step =
  | "queued"
  | "fetching_asins"
  | "analyzing_sellers"
  | "keywords_competitors"
  | "generating_report"
  | "ready"
  | "failed";

interface StatusResponse {
  step: Step;
  percent: number;
  status: string;
  created_at: string;
  keepa_last_enriched_at: string | null;
  dataforseo_last_enriched_at: string | null;
  narrative_ready: boolean;
  error_message: string | null;
  elapsed_seconds: number;
  estimated_total_seconds: number;
  report_url: string | null;
}

interface Props {
  token: string;
  contactEmail?: string | null;
  // When set and step === ready, we use this href instead of the public
  // /r/<token> URL — for the authenticated dashboard link.
  readyHref?: string | null;
  variant?: "marketing" | "dashboard";
}

const STEPS: Array<{ key: Step; label: string }> = [
  { key: "queued", label: "Request received" },
  { key: "fetching_asins", label: "Fetching ASINs from Amazon (Keepa)" },
  { key: "analyzing_sellers", label: "Analyzing seller landscape" },
  { key: "keywords_competitors", label: "Pulling keyword + competitor data" },
  { key: "generating_report", label: "Generating report" },
  { key: "ready", label: "Done — view report" },
];

const STEP_ORDER: Record<Step, number> = {
  queued: 0,
  fetching_asins: 1,
  analyzing_sellers: 2,
  keywords_competitors: 3,
  generating_report: 4,
  ready: 5,
  failed: 5,
};

function fmtClock(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function AuditProgress({
  token,
  contactEmail,
  readyHref,
  variant = "marketing",
}: Props) {
  const [state, setState] = useState<StatusResponse | null>(null);
  const [pollErrors, setPollErrors] = useState(0);
  const stopRef = useRef(false);

  useEffect(() => {
    stopRef.current = false;
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch(
          `/api/public/report-status?token=${encodeURIComponent(token)}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          setPollErrors((n) => n + 1);
          return;
        }
        const json = (await res.json()) as StatusResponse;
        if (cancelled) return;
        setState(json);
        setPollErrors(0);
        if (json.step === "ready" || json.step === "failed") {
          stopRef.current = true;
        }
      } catch {
        if (!cancelled) setPollErrors((n) => n + 1);
      }
    }
    tick();
    const id = setInterval(() => {
      if (stopRef.current) {
        clearInterval(id);
        return;
      }
      tick();
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token]);

  const isMarketing = variant === "marketing";
  const cardStyle: React.CSSProperties = isMarketing
    ? {
        background: "#fff",
        border: "1px solid var(--color-rule)",
        padding: 28,
        borderRadius: 2,
      }
    : {
        background: "var(--surface-elevated, #1a1a1a)",
        border: "1px solid var(--border, #333)",
        padding: 20,
        borderRadius: 6,
      };

  const labelColor = isMarketing ? "var(--color-ink-soft)" : "var(--text-muted, #aaa)";
  const headingColor = isMarketing ? "var(--color-ink, #111)" : "var(--text, #f5f5f5)";

  const currentStep: Step = state?.step ?? "queued";
  const currentPercent = state?.percent ?? 5;
  const currentOrder = STEP_ORDER[currentStep];
  const elapsed = state?.elapsed_seconds ?? 0;

  if (currentStep === "failed") {
    return (
      <div style={cardStyle}>
        <div className="eyebrow" style={{ color: "#c0392b" }}>Generation failed</div>
        <h3 style={{ marginTop: 12, fontSize: "1.2rem", color: headingColor, fontWeight: 500 }}>
          We hit a snag.
        </h3>
        <p style={{ marginTop: 12, color: labelColor, lineHeight: 1.6, fontSize: 14 }}>
          We&rsquo;ll fix this and re-run automatically. You&rsquo;ll get an
          email at <strong>{contactEmail || "the address on file"}</strong>{" "}
          when the report is ready.
        </p>
        {state?.error_message && (
          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: "pointer", fontSize: 12, color: labelColor }}>Technical details</summary>
            <pre style={{
              marginTop: 8,
              fontSize: 11,
              color: labelColor,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}>{state.error_message}</pre>
          </details>
        )}
      </div>
    );
  }

  if (currentStep === "ready") {
    const href = readyHref ?? state?.report_url ?? null;
    return (
      <div style={cardStyle}>
        <div className="eyebrow" style={{ color: isMarketing ? "var(--color-accent-ink)" : "#10b981" }}>Done</div>
        <h3 style={{ marginTop: 12, fontSize: "1.4rem", color: headingColor, fontWeight: 500 }}>
          Your audit is ready.
        </h3>
        {href && (
          <p style={{ marginTop: 14 }}>
            <a
              href={href}
              style={{
                display: "inline-block",
                padding: "10px 18px",
                background: isMarketing ? "var(--color-accent, #1a1a1a)" : "#2563eb",
                color: "#fff",
                textDecoration: "none",
                borderRadius: 4,
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              View report →
            </a>
          </p>
        )}
      </div>
    );
  }

  const eta = Math.max(
    0,
    (state?.estimated_total_seconds ?? 180) - elapsed,
  );

  return (
    <div style={cardStyle}>
      <div className="eyebrow" style={{ color: isMarketing ? "var(--color-accent-ink)" : "#facc15" }}>
        In progress · {fmtClock(elapsed)} elapsed
      </div>
      <h3 style={{ marginTop: 10, fontSize: "1.2rem", color: headingColor, fontWeight: 500 }}>
        Building your Channel Ownership Audit…
      </h3>
      <p style={{ marginTop: 8, fontSize: 13, color: labelColor }}>
        This typically takes <strong>2–3 minutes</strong> for most brands and up
        to ~15 minutes for very large catalogs.
        {eta > 0 && currentStep !== "queued" && (
          <> Estimated time remaining: <strong>~{fmtClock(eta)}</strong>.</>
        )}
      </p>

      {/* Percent bar */}
      <div
        aria-hidden
        style={{
          marginTop: 16,
          height: 6,
          width: "100%",
          background: isMarketing ? "var(--color-rule, #e5e5e5)" : "#262626",
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${currentPercent}%`,
            height: "100%",
            background: isMarketing ? "var(--color-accent-ink, #111)" : "#2563eb",
            transition: "width 600ms ease",
          }}
        />
      </div>

      {/* Step list */}
      <ul style={{ marginTop: 18, display: "grid", gap: 10, listStyle: "none", padding: 0 }}>
        {STEPS.filter((s) => s.key !== "ready").map((s) => {
          const order = STEP_ORDER[s.key];
          const done = order < currentOrder;
          const active = order === currentOrder;
          return (
            <li
              key={s.key}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                gap: 10,
                alignItems: "center",
                fontSize: 14,
                color: done || active ? headingColor : labelColor,
              }}
            >
              <span
                aria-hidden
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: done
                    ? isMarketing
                      ? "var(--color-accent-ink, #111)"
                      : "#10b981"
                    : active
                      ? "transparent"
                      : "transparent",
                  border: done
                    ? "none"
                    : active
                      ? `2px solid ${isMarketing ? "var(--color-accent-ink, #111)" : "#facc15"}`
                      : `1px solid ${isMarketing ? "var(--color-rule, #ccc)" : "#444"}`,
                  color: "#fff",
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {done ? "✓" : active ? <Spinner /> : ""}
              </span>
              <span style={{ fontWeight: active ? 500 : 400 }}>{s.label}</span>
            </li>
          );
        })}
      </ul>

      {/* Email-when-ready / close-tab fallback */}
      {contactEmail && (
        <div
          style={{
            marginTop: 22,
            padding: 14,
            background: isMarketing ? "#fafaf7" : "rgba(255,255,255,0.03)",
            border: `1px dashed ${isMarketing ? "var(--color-rule, #e5e5e5)" : "#333"}`,
            borderRadius: 4,
            fontSize: 13,
            color: labelColor,
            lineHeight: 1.55,
          }}
        >
          <strong style={{ color: headingColor }}>Don&rsquo;t want to wait?</strong>{" "}
          We&rsquo;ll email the finished report to{" "}
          <strong style={{ color: headingColor }}>{contactEmail}</strong>. You
          can close this tab — it&rsquo;ll arrive in your inbox when the audit
          finishes.
        </div>
      )}

      {pollErrors > 3 && (
        <p style={{ marginTop: 14, fontSize: 12, color: "#c0392b" }}>
          Connection hiccup — retrying in the background.
        </p>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "50%",
        border: "2px solid currentColor",
        borderTopColor: "transparent",
        animation: "audit-spin 0.7s linear infinite",
      }}
    >
      <style>{`@keyframes audit-spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}
