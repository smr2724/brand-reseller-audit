import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const brandId = url.searchParams.get("brand_id");
  const status = url.searchParams.get("status");
  const kind = url.searchParams.get("kind") ?? "channel_ownership_audit";

  let q = supabase
    .from("reports")
    .select(
      "id, brand_id, title, kind, status, generated_at, created_at, error_message, pdf_storage_path, token, brands:brand_id(name)"
    )
    .eq("user_id", user.id)
    .eq("kind", kind)
    .order("created_at", { ascending: false })
    .limit(200);

  if (brandId) q = q.eq("brand_id", brandId);
  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ reports: data ?? [] });
}
