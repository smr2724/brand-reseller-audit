import { createSupabaseServerClient } from "@/lib/supabase/server";
import Link from "next/link";
import { formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface ReportRow {
  id: string;
  brand_id: string | null;
  title: string | null;
  kind: string;
  status: string;
  generated_at: string | null;
  created_at: string;
  error_message: string | null;
  brands: { name: string } | { name: string }[] | null;
}

interface Search {
  brand_id?: string;
  status?: string;
}

export default async function ReportsIndex({ searchParams }: { searchParams: Search }) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let q = supabase
    .from("reports")
    .select(
      "id, brand_id, title, kind, status, generated_at, created_at, error_message, brands:brand_id(name)"
    )
    .eq("user_id", user!.id)
    .eq("kind", "channel_ownership_audit")
    .order("created_at", { ascending: false })
    .limit(200);

  if (searchParams.brand_id) q = q.eq("brand_id", searchParams.brand_id);
  if (searchParams.status) q = q.eq("status", searchParams.status);

  const { data: reports } = await q;
  const list = (reports ?? []) as ReportRow[];

  // Brand filter dropdown options
  const { data: brandOpts } = await supabase
    .from("brands")
    .select("id, name")
    .eq("user_id", user!.id)
    .order("name");

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-2xl font-semibold">Reports</h1>
        <span className="text-sm text-[var(--text-muted)]">
          {list.length} report{list.length === 1 ? "" : "s"}
        </span>
      </div>

      <form
        method="GET"
        className="flex flex-wrap items-center gap-2 mb-4"
      >
        <select
          name="brand_id"
          defaultValue={searchParams.brand_id ?? ""}
          className="select w-auto"
        >
          <option value="">All brands</option>
          {(brandOpts ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <select
          name="status"
          defaultValue={searchParams.status ?? ""}
          className="select w-auto"
        >
          <option value="">All statuses</option>
          <option value="generating">Generating</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>
        <button className="btn" type="submit">
          Filter
        </button>
        {(searchParams.brand_id || searchParams.status) && (
          <Link href="/app/reports" className="text-sm text-[var(--text-muted)] hover:text-[var(--text)]">
            Clear
          </Link>
        )}
      </form>

      {list.length === 0 ? (
        <div className="card p-8 text-center text-[var(--text-muted)]">
          No reports yet. Generate a Channel Ownership Audit from any brand&apos;s detail page.
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border)]">
                <th className="px-4 py-3 font-medium">Brand</th>
                <th className="px-4 py-3 font-medium">Kind</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Generated</th>
                <th className="px-4 py-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const brandName = brandNameFrom(r);
                return (
                  <tr
                    key={r.id}
                    className="border-b border-[var(--border-soft)] hover:bg-[var(--bg-3)] transition-colors"
                  >
                    <td className="px-4 py-3">
                      <Link href={`/app/reports/${r.id}`} className="font-medium hover:text-[var(--accent)]">
                        {brandName ?? r.title ?? "—"}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-[var(--text-muted)]">Channel Ownership Audit</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-4 py-3 text-[var(--text-muted)]">
                      {formatDateTime(r.generated_at ?? r.created_at)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.status === "completed" ? (
                        <a className="btn btn-ghost text-xs" href={`/api/reports/${r.id}/download`}>
                          Download
                        </a>
                      ) : (
                        <Link className="btn btn-ghost text-xs" href={`/app/reports/${r.id}`}>
                          View
                        </Link>
                      )}
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

function brandNameFrom(r: ReportRow): string | null {
  if (!r.brands) return null;
  if (Array.isArray(r.brands)) return r.brands[0]?.name ?? null;
  return r.brands.name ?? null;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    generating: "bg-[#2a2410] text-[#facc15] border-[#4a3e1e]",
    completed: "bg-[#102a14] text-[#4ade80] border-[#1e4a28]",
    failed: "bg-[#2a1415] text-[#f87171] border-[#4a1e21]",
  };
  const cls = styles[status] ?? "bg-[var(--bg-3)] text-[var(--text-muted)] border-[var(--border)]";
  return <span className={`px-2 py-1 rounded text-xs border ${cls}`}>{status}</span>;
}
