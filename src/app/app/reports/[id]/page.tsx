import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { freshSignedUrl } from "@/lib/report/storage";
import { formatDateTime } from "@/lib/utils";
import ReportDetailClient from "./ReportDetailClient";
import AuditProgress from "@/components/marketing/AuditProgress";

export const dynamic = "force-dynamic";

export default async function ReportDetail({ params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: report } = await supabase
    .from("reports")
    .select(
      "id, brand_id, title, kind, status, generated_at, created_at, error_message, pdf_storage_path, token, brands:brand_id(name)"
    )
    .eq("id", params.id)
    .eq("user_id", user!.id)
    .maybeSingle();
  if (!report) notFound();

  let signedUrl: string | null = null;
  if (report.status === "completed" && report.pdf_storage_path) {
    try {
      signedUrl = await freshSignedUrl(report.pdf_storage_path);
    } catch (e) {
      console.warn("[reports/:id] signed url err", e);
    }
  }

  const brandName = Array.isArray(report.brands)
    ? report.brands[0]?.name
    : (report.brands as { name?: string } | null)?.name;

  return (
    <div className="p-6 max-w-[1100px] mx-auto">
      <div className="mb-4">
        <Link href="/app/reports" className="text-sm text-[var(--text-muted)] hover:text-[var(--text)]">
          ← All reports
        </Link>
      </div>

      <div className="flex items-start justify-between mb-4 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">{brandName ?? report.title ?? "Report"}</h1>
          <div className="text-sm text-[var(--text-muted)] mt-1">
            Channel Ownership Audit · {formatDateTime(report.generated_at ?? report.created_at)}
          </div>
        </div>
        <ReportDetailClient
          reportId={report.id}
          brandId={report.brand_id}
          status={report.status}
          downloadHref={`/api/reports/${report.id}/download`}
        />
      </div>

      {report.status === "failed" && (
        <div className="card p-4 mb-4 border-[#4a1e21] bg-[#2a1415]">
          <div className="text-sm font-medium text-[#f87171]">Generation failed</div>
          <div className="text-xs text-[var(--text-muted)] mt-1">{report.error_message ?? "Unknown error"}</div>
        </div>
      )}

      {report.status === "generating" && report.token && (
        <div className="mb-4">
          <AuditProgress
            token={report.token}
            contactEmail={user?.email ?? null}
            readyHref={`/app/reports/${report.id}`}
            variant="dashboard"
          />
        </div>
      )}
      {report.status === "generating" && !report.token && (
        <div className="card p-4 mb-4">
          <div className="text-sm">Generating report…</div>
          <div className="text-xs text-[var(--text-muted)] mt-1">
            This usually takes 2–3 minutes. The page will update automatically.
          </div>
        </div>
      )}

      {report.status === "completed" && signedUrl && (
        <div className="card overflow-hidden">
          <iframe
            src={signedUrl}
            style={{ width: "100%", height: 900, border: 0 }}
            title="Channel Ownership Audit"
          />
        </div>
      )}

      <ViewsSection reportId={report.id} />
    </div>
  );
}

// Phase 53 — last 50 entries from report_views. Internal/bot rows are
// labelled but still listed so the operator can see crawler traffic.
async function ViewsSection({ reportId }: { reportId: string }) {
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data: rows, error } = await admin
    .from("report_views")
    .select("id, viewed_at, ip_address, user_agent, referrer, country, city, region, is_internal")
    .eq("report_id", reportId)
    .order("viewed_at", { ascending: false })
    .limit(50);
  if (error) {
    // table missing in dev DB / migration not run — silently skip.
    return null;
  }
  const list = (rows ?? []) as Array<{
    id: string;
    viewed_at: string;
    ip_address: string | null;
    user_agent: string | null;
    referrer: string | null;
    country: string | null;
    city: string | null;
    region: string | null;
    is_internal: boolean;
  }>;
  if (list.length === 0) return null;

  return (
    <details className="card p-4 mt-6">
      <summary className="cursor-pointer text-sm font-medium">
        Views <span className="text-[var(--text-muted)] font-normal">({list.length})</span>
      </summary>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-[var(--text-muted)]">
            <tr className="text-left">
              <th className="py-1 pr-3 font-medium">When</th>
              <th className="py-1 pr-3 font-medium">Location</th>
              <th className="py-1 pr-3 font-medium">IP</th>
              <th className="py-1 pr-3 font-medium">User-agent</th>
              <th className="py-1 pr-3 font-medium">Tag</th>
            </tr>
          </thead>
          <tbody>
            {list.map((v) => {
              const loc = [v.city, v.region, v.country].filter(Boolean).join(", ");
              return (
                <tr key={v.id} className="border-t border-[var(--border)]">
                  <td className="py-1 pr-3 whitespace-nowrap" title={v.viewed_at}>
                    {relativeTime(v.viewed_at)}
                  </td>
                  <td className="py-1 pr-3">{loc || "—"}</td>
                  <td className="py-1 pr-3 font-mono">{v.ip_address ?? "—"}</td>
                  <td className="py-1 pr-3 max-w-[360px] truncate" title={v.user_agent ?? ""}>
                    {v.user_agent ?? "—"}
                  </td>
                  <td className="py-1 pr-3">
                    {v.is_internal ? (
                      <span className="inline-block px-1.5 py-0.5 text-[10px] rounded bg-[#1f2937] text-[#9ca3af] border border-[#374151]">
                        internal
                      </span>
                    ) : (
                      <span className="inline-block px-1.5 py-0.5 text-[10px] rounded bg-[#0f2a1a] text-[#86efac] border border-[#14532d]">
                        customer
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
