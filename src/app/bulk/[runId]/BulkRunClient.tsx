"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

interface BrandRow {
  id: string;
  bulk_run_id: string;
  position: number;
  input_name: string;
  brand_id: string | null;
  status: string;
  progress_percent: number;
  current_step_label: string | null;
  qualified: boolean | null;
  disqualification_reason: string | null;
  selected_entity_name: string | null;
  resolved_owner_domain: string | null;
  contact_name: string | null;
  contact_email: string | null;
  email_verifier: string | null;
  email_status: string | null;
  outlook_draft_id: string | null;
  outlook_draft_web_link: string | null;
  brand_seven_x_value: number | null;
  legion_opportunity: number | null;
  error_message: string | null;
  error_step: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface RunRow {
  id: string;
  user_id: string;
  status: string;
  total_brands: number;
  brands_completed: number;
  current_brand_id: string | null;
  current_brand_name: string | null;
  started_at: string | null;
  completed_at: string | null;
  report_email_sent_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

function fmtTs(s: string | null): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

function fmtMoney(n: number | null): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `$${Math.round(v / 1_000).toLocaleString()}K`;
  return `$${Math.round(v).toLocaleString()}`;
}

function statusBadgeForBrand(b: BrandRow): { label: string; bg: string; fg: string } {
  if (b.status === "completed" && b.qualified && b.outlook_draft_id) {
    return { label: "Draft Created", bg: "#dcf5e3", fg: "#0a6b2f" };
  }
  if (b.status === "completed" && b.qualified) {
    return { label: "Qualified — No Contact", bg: "#fff4cc", fg: "#8a6a00" };
  }
  if (b.status === "disqualified") {
    return {
      label: `Disqualified${b.disqualification_reason ? ` (${b.disqualification_reason})` : ""}`,
      bg: "#eaeaea",
      fg: "#555",
    };
  }
  if (b.status === "keepa_not_found") {
    return { label: "Not Found on Keepa", bg: "#eaeaea", fg: "#555" };
  }
  if (b.status === "error") {
    return {
      label: `Error: ${b.error_step ?? "unknown"}`,
      bg: "#ffe1e1",
      fg: "#a02020",
    };
  }
  if (b.status === "queued") {
    return { label: "Queued", bg: "#f0ede5", fg: "#666" };
  }
  return { label: "Running", bg: "#dbe7ff", fg: "#1a3a8a" };
}

function runStatusColor(status: string): { bg: string; fg: string; label: string } {
  switch (status) {
    case "completed":
      return { bg: "#dcf5e3", fg: "#0a6b2f", label: "Completed" };
    case "running":
      return { bg: "#dbe7ff", fg: "#1a3a8a", label: "Running" };
    case "pending":
      return { bg: "#fff4cc", fg: "#8a6a00", label: "Pending" };
    case "failed":
      return { bg: "#ffe1e1", fg: "#a02020", label: "Failed" };
    case "cancelled":
      return { bg: "#eaeaea", fg: "#555", label: "Cancelled" };
    default:
      return { bg: "#eaeaea", fg: "#555", label: status };
  }
}

function rankedBrands(brands: BrandRow[]): BrandRow[] {
  function tier(b: BrandRow): number {
    if (b.status === "completed" && b.qualified && b.outlook_draft_id) return 0;
    if (b.status === "completed" && b.qualified) return 1;
    if (b.status === "disqualified") return 2;
    if (b.status === "keepa_not_found") return 3;
    if (b.status === "error") return 4;
    return 5;
  }
  return [...brands].sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    const sa = a.brand_seven_x_value == null ? -Infinity : Number(a.brand_seven_x_value);
    const sb = b.brand_seven_x_value == null ? -Infinity : Number(b.brand_seven_x_value);
    if (sb !== sa) return sb - sa;
    return a.position - b.position;
  });
}

export default function BulkRunClient({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunRow | null>(null);
  const [brands, setBrands] = useState<BrandRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function load() {
      try {
        const res = await fetch(`/api/bulk/${runId}/status`, { cache: "no-store" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          if (!cancelled) setErr(data?.error ?? `HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as { run: RunRow; brands: BrandRow[] };
        if (cancelled) return;
        setRun(data.run);
        setBrands(data.brands);
        setErr(null);
        if (data.run.status === "pending" || data.run.status === "running") {
          timer = setTimeout(load, 2000);
        }
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message ?? e));
      }
    }

    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  const ranked = useMemo(() => rankedBrands(brands), [brands]);

  if (err) {
    return (
      <div style={{ padding: 32, maxWidth: 640, margin: "0 auto" }}>
        <Link
          href="/bulk"
          style={{ color: "#666", fontSize: 13, textDecoration: "none" }}
        >
          ← Back to bulk runs
        </Link>
        <h1 style={{ fontSize: 22, marginTop: 24, color: "#a02020" }}>Error</h1>
        <p style={{ color: "#888", fontSize: 14 }}>{err}</p>
      </div>
    );
  }
  if (!run) {
    return (
      <div style={{ padding: 32, color: "#888", fontSize: 14 }}>Loading…</div>
    );
  }

  const sc = runStatusColor(run.status);
  const showReport = run.status === "completed";

  return (
    <div style={{ padding: "32px 16px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ marginBottom: 12 }}>
        <Link
          href="/bulk"
          style={{ color: "#666", fontSize: 13, textDecoration: "none" }}
        >
          ← Back to bulk runs
        </Link>
      </div>

      <div
        style={{
          display: "flex",
          gap: 14,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 6,
        }}
      >
        <h1 style={{ fontSize: 22, margin: 0, fontWeight: 600 }}>Bulk run</h1>
        <span
          style={{
            display: "inline-block",
            background: sc.bg,
            color: sc.fg,
            padding: "3px 10px",
            borderRadius: 3,
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.04,
          }}
        >
          {sc.label}
        </span>
        <span style={{ color: "#666", fontSize: 13 }}>
          {run.brands_completed} / {run.total_brands} completed
        </span>
      </div>
      <p style={{ color: "#888", fontSize: 12, margin: "0 0 24px" }}>
        Started {fmtTs(run.started_at)} · run id <code>{run.id}</code>
        {run.current_brand_name ? (
          <>
            {" "}· now processing <strong>{run.current_brand_name}</strong>
          </>
        ) : null}
      </p>

      {showReport ? (
        <div
          style={{
            background: "#dcf5e3",
            border: "1px solid #b6e6c2",
            borderRadius: 3,
            padding: "10px 14px",
            fontSize: 13,
            color: "#0a6b2f",
            marginBottom: 18,
          }}
        >
          {run.report_email_sent_at
            ? `Report emailed to steve@rollemanagementgroup.com at ${fmtTs(run.report_email_sent_at)}.`
            : "Report email pending — will land in steve@rollemanagementgroup.com shortly."}
        </div>
      ) : null}

      <h2 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 12px" }}>
        {showReport ? "Ranked report" : "Per-brand progress"}
      </h2>

      <div
        style={{
          border: "1px solid #e5e1d8",
          borderRadius: 4,
          overflowX: "auto",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
          <thead style={{ background: "#f7f6f3" }}>
            <tr>
              <th style={th}>#</th>
              <th style={th}>Brand</th>
              <th style={th}>Status</th>
              <th style={th}>Progress</th>
              <th style={th}>Owner</th>
              <th style={th}>Contact</th>
              <th style={th}>Email</th>
              <th style={th}>Verifier</th>
              <th style={th}>Draft</th>
              <th style={{ ...th, textAlign: "right" }}>7x Opportunity ($)</th>
              <th style={{ ...th, textAlign: "right" }}>Opportunity</th>
            </tr>
          </thead>
          <tbody>
            {(showReport ? ranked : brands).map((b, idx) => {
              const badge = statusBadgeForBrand(b);
              return (
                <tr key={b.id} style={{ borderTop: "1px solid #eee" }}>
                  <td style={td}>{showReport ? idx + 1 : b.position}</td>
                  <td style={td}>
                    <strong>{b.input_name}</strong>
                    {b.selected_entity_name && b.selected_entity_name !== b.input_name ? (
                      <div style={{ color: "#888", fontSize: 11 }}>
                        {b.selected_entity_name}
                      </div>
                    ) : null}
                  </td>
                  <td style={td}>
                    <span
                      style={{
                        display: "inline-block",
                        background: badge.bg,
                        color: badge.fg,
                        padding: "2px 8px",
                        borderRadius: 3,
                        fontSize: 11,
                      }}
                    >
                      {badge.label}
                    </span>
                    {b.error_message ? (
                      <div
                        style={{
                          color: "#a02020",
                          fontSize: 11,
                          marginTop: 4,
                          maxWidth: 220,
                        }}
                      >
                        {b.error_message}
                      </div>
                    ) : null}
                  </td>
                  <td style={td}>
                    <div
                      style={{
                        width: 120,
                        background: "#eee",
                        borderRadius: 3,
                        height: 8,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.max(0, Math.min(100, b.progress_percent))}%`,
                          background:
                            b.status === "error"
                              ? "#c44"
                              : b.status === "completed"
                                ? "#3a8a4a"
                                : "#1a55a3",
                          height: "100%",
                          transition: "width 0.4s",
                        }}
                      />
                    </div>
                    <div style={{ fontSize: 11, color: "#666", marginTop: 4 }}>
                      {b.current_step_label ?? ""}
                    </div>
                  </td>
                  <td style={td}>{b.resolved_owner_domain ?? "—"}</td>
                  <td style={td}>{b.contact_name ?? "—"}</td>
                  <td style={td}>
                    {b.contact_email ? (
                      <span style={{ fontFamily: "monospace", fontSize: 12 }}>
                        {b.contact_email}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={td}>{b.email_verifier ?? "—"}</td>
                  <td style={td}>
                    {b.outlook_draft_web_link ? (
                      <a
                        href={b.outlook_draft_web_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "#1a55a3", textDecoration: "underline", fontSize: 12 }}
                      >
                        Open
                      </a>
                    ) : b.outlook_draft_id ? (
                      "Created"
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    {fmtMoney(b.brand_seven_x_value)}
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    {fmtMoney(b.legion_opportunity)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th: React.CSSProperties = {
  padding: "10px 10px",
  textAlign: "left",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.04,
  color: "#666",
};

const td: React.CSSProperties = {
  padding: "10px 10px",
  fontSize: 13,
  verticalAlign: "top",
};
