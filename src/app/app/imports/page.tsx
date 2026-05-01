import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatDateTime, formatNumber } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ImportsPage() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: imports } = await supabase
    .from("imports")
    .select("*")
    .eq("user_id", user!.id)
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <h1 className="text-2xl font-semibold mb-6">Imports</h1>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border)]">
              <th className="px-4 py-3 font-medium">Filename</th>
              <th className="px-4 py-3 font-medium">Source</th>
              <th className="px-4 py-3 font-medium text-right">Rows</th>
              <th className="px-4 py-3 font-medium text-right">Inserted</th>
              <th className="px-4 py-3 font-medium text-right">Updated</th>
              <th className="px-4 py-3 font-medium text-right">Skipped</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {(imports ?? []).map((i) => (
              <tr key={i.id} className="border-b border-[var(--border-soft)]">
                <td className="px-4 py-3">{i.filename}</td>
                <td className="px-4 py-3 text-[var(--text-muted)]">{i.source_type}</td>
                <td className="px-4 py-3 text-right">{formatNumber(i.row_count)}</td>
                <td className="px-4 py-3 text-right">{formatNumber(i.inserted_count)}</td>
                <td className="px-4 py-3 text-right">{formatNumber(i.updated_count)}</td>
                <td className="px-4 py-3 text-right">{formatNumber(i.skipped_count)}</td>
                <td className="px-4 py-3">
                  <span className="px-2 py-1 rounded text-xs bg-[var(--bg-3)] border border-[var(--border)]">
                    {i.status}
                  </span>
                  {i.error_message && (
                    <div className="text-xs text-[#f87171] mt-1">{i.error_message}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-[var(--text-muted)]">{formatDateTime(i.created_at)}</td>
              </tr>
            ))}
            {(!imports || imports.length === 0) && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-[var(--text-muted)]">
                  No imports yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
