import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { searchPeopleByCompany } from "@/lib/apollo";

/**
 * POST /api/contacts/find
 * Body: { supplier_id: string }
 *
 * Step 1 of CRM enrichment. Searches Apollo for people at the supplier's
 * company. Does NOT consume enrich credits or insert anything into the DB.
 * Returns { total, candidates } so the UI can preview before enriching.
 */
export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { supplier_id } = await req.json().catch(() => ({}));
  if (!supplier_id) return NextResponse.json({ error: "supplier_id required" }, { status: 400 });

  const { data: supplier } = await supabase
    .from("suppliers")
    .select("id, company_name, domain, website")
    .eq("id", supplier_id)
    .eq("user_id", user.id)
    .single();
  if (!supplier) return NextResponse.json({ error: "Supplier not found" }, { status: 404 });

  const result = await searchPeopleByCompany({
    domain: supplier.domain ?? undefined,
    companyName: supplier.domain ? undefined : (supplier.company_name ?? undefined),
    perPage: 25,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  // Return a slim preview — don't leak full Apollo payload.
  return NextResponse.json({
    total: result.total,
    candidates: result.people.map(p => ({
      id: p.id,
      name: p.name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(),
      title: p.title,
      seniority: p.seniority,
      departments: p.departments,
      city: p.city,
      state: p.state,
      country: p.country,
      linkedin_url: p.linkedin_url,
    })),
  });
}
