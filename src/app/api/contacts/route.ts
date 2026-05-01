import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const brandId = url.searchParams.get("brand_id");
  const seniority = url.searchParams.get("seniority");
  const includeDisqualified = url.searchParams.get("include_disqualified") === "1";

  let q = supabase
    .from("contacts")
    .select("id, brand_id, supplier_id, full_name, first_name, last_name, title, seniority, department, departments, email, email_status, linkedin_url, phone, city, state, country, apollo_person_id, is_primary, disqualified, disqualified_reason, source, enriched_at, ai_priority_rank, ai_priority_reason, archived_at, created_at, updated_at")
    .eq("user_id", user.id)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);

  if (brandId) q = q.eq("brand_id", brandId);
  if (seniority) q = q.eq("seniority", seniority);
  if (!includeDisqualified) q = q.eq("disqualified", false);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ contacts: data ?? [] });
}
