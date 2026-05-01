import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { freshSignedUrl } from "@/lib/report/storage";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: report, error } = await supabase
    .from("reports")
    .select("id, status, pdf_storage_path")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (report.status !== "completed" || !report.pdf_storage_path) {
    return NextResponse.json({ error: `Report not ready (${report.status})` }, { status: 409 });
  }

  try {
    const url = await freshSignedUrl(report.pdf_storage_path);
    return NextResponse.redirect(url, 302);
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message ?? e) }, { status: 500 });
  }
}
