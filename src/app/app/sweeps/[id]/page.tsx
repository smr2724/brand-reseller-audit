import { createSupabaseServerClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import SweepProgress from "./SweepProgress";

export const dynamic = "force-dynamic";

export default async function SweepPage({ params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const { data: sweep } = await supabase.from("sweeps").select("*").eq("id", params.id).single();
  if (!sweep) notFound();

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="mb-3">
        <Link href="/app/scan/batch" className="text-xs text-[var(--text-muted)] hover:underline">← New batch scan</Link>
      </div>
      <div className="card p-4 md:p-5 mb-4">
        <div className="flex items-start justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-xl md:text-2xl font-semibold tracking-tight">{sweep.name ?? "Sweep"}</h1>
            <div className="text-xs text-[var(--text-muted)] mt-1">
              Started {new Date(sweep.started_at ?? sweep.created_at).toLocaleString()} · {sweep.total_jobs} seeds
            </div>
          </div>
        </div>
      </div>
      <SweepProgress sweepId={params.id} />
    </div>
  );
}
