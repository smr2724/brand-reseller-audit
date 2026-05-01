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
    .select(
      "id, brand_id, title, kind, status, generated_at, created_at, error_message, pdf_storage_path, narrative_json, brands:brand_id(name)"
    )
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let signed_url: string | null = null;
  if (report.status === "completed" && report.pdf_storage_path) {
    try {
      signed_url = await freshSignedUrl(report.pdf_storage_path);
    } catch (e) {
      console.warn("[api/reports/:id] signed url failed:", e);
    }
  }

  return NextResponse.json({ report, signed_url });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { error } = await supabase
    .from("reports")
    .delete()
    .eq("id", params.id)
    .eq("user_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
