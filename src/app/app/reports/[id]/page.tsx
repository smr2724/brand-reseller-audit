import { createSupabaseServerClient } from "@/lib/supabase/server";
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
    </div>
  );
}
