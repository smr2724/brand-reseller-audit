import { redirect } from "next/navigation";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import NewBulkRunForm from "./NewBulkRunForm";

export const dynamic = "force-dynamic";

interface BulkRunRow {
  id: string;
  status: string;
  total_brands: number;
  brands_completed: number;
  started_at: string | null;
  completed_at: string | null;
  report_email_sent_at: string | null;
  created_at: string;
}

function fmtTs(s: string | null): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

function statusColor(status: string): { bg: string; fg: string; label: string } {
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

export default async function BulkIndexPage() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: runs } = await supabase
    .from("bulk_runs")
    .select(
      "id, status, total_brands, brands_completed, started_at, completed_at, report_email_sent_at, created_at",
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  const rows = (runs ?? []) as BulkRunRow[];

  return (
    <div style={{ padding: "32px 16px", maxWidth: 1040, margin: "0 auto" }}>
      <div style={{ marginBottom: 24 }}>
        <Link
          href="/app/dashboard"
          style={{ color: "#666", fontSize: 13, textDecoration: "none" }}
        >
          ← Back to dashboard
        </Link>
      </div>

      <h1 style={{ fontSize: 24, fontWeight: 600, margin: "0 0 6px" }}>
        Bulk Brand Pipeline
      </h1>
      <p style={{ color: "#666", margin: "0 0 24px", fontSize: 14 }}>
        Paste a list of brand names — we&rsquo;ll search Keepa, enrich,
        qualify, find decision-maker contacts, and draft outreach for every
        brand that qualifies. A ranked report is emailed when the run finishes.
      </p>

      <NewBulkRunForm />

      <h2 style={{ fontSize: 18, fontWeight: 600, margin: "40px 0 12px" }}>
        Past runs
      </h2>
      {rows.length === 0 ? (
        <p style={{ color: "#888", fontSize: 13 }}>No bulk runs yet.</p>
      ) : (
        <div style={{ border: "1px solid #e5e1d8", borderRadius: 4, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f7f6f3" }}>
                <th style={th}>Started</th>
                <th style={th}>Status</th>
                <th style={th}>Brands</th>
                <th style={th}>Completed</th>
                <th style={th}>Report Emailed</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const sc = statusColor(r.status);
                return (
                  <tr key={r.id} style={{ borderTop: "1px solid #eee" }}>
                    <td style={td}>{fmtTs(r.started_at ?? r.created_at)}</td>
                    <td style={td}>
                      <span
                        style={{
                          display: "inline-block",
                          background: sc.bg,
                          color: sc.fg,
                          padding: "2px 8px",
                          borderRadius: 3,
                          fontSize: 11,
                          textTransform: "uppercase",
                          letterSpacing: 0.04,
                        }}
                      >
                        {sc.label}
                      </span>
                    </td>
                    <td style={td}>{r.total_brands}</td>
                    <td style={td}>
                      {r.brands_completed}/{r.total_brands}
                    </td>
                    <td style={td}>{fmtTs(r.report_email_sent_at)}</td>
                    <td style={{ ...td, textAlign: "right" }}>
                      <Link
                        href={`/bulk/${r.id}`}
                        style={{ color: "#1a55a3", textDecoration: "none", fontSize: 13 }}
                      >
                        Open →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = {
  padding: "10px 12px",
  textAlign: "left",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.04,
  color: "#666",
};

const td: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: 13,
  verticalAlign: "top",
};
