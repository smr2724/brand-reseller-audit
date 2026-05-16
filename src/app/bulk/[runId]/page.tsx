import { redirect } from "next/navigation";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import BulkRunClient from "./BulkRunClient";

export const dynamic = "force-dynamic";

export default async function BulkRunPage({
  params,
}: {
  params: { runId: string };
}) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: run } = await supabase
    .from("bulk_runs")
    .select("id, user_id")
    .eq("id", params.runId)
    .maybeSingle();
  if (!run || run.user_id !== user.id) {
    return (
      <div style={{ padding: 32, maxWidth: 640, margin: "0 auto" }}>
        <Link
          href="/bulk"
          style={{ color: "#666", fontSize: 13, textDecoration: "none" }}
        >
          ← Back to bulk runs
        </Link>
        <h1 style={{ fontSize: 22, marginTop: 24 }}>Run not found</h1>
        <p style={{ color: "#888", fontSize: 14 }}>
          This bulk run doesn&rsquo;t exist or belongs to another account.
        </p>
      </div>
    );
  }

  return <BulkRunClient runId={params.runId} />;
}
