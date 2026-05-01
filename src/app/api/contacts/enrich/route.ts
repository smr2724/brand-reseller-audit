import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { searchPeopleByCompany, enrichPerson } from "@/lib/apollo";
import { rankContacts } from "@/lib/openai";

/**
 * POST /api/contacts/enrich
 * Body: { supplier_id: string }
 *
 * 1) Search Apollo for candidates
 * 2) Send candidate list to OpenAI -> pick top 3 with reasons
 * 3) Apollo enrich those 3 only -> unlocks email
 * 4) Insert/upsert into `contacts` table
 *
 * Returns the saved contacts (with emails when Apollo provided them).
 */
export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { supplier_id } = await req.json().catch(() => ({}));
  if (!supplier_id) return NextResponse.json({ error: "supplier_id required" }, { status: 400 });

  // Pull supplier + a representative opportunity for product context.
  const { data: supplier } = await supabase
    .from("suppliers")
    .select("id, company_name, domain")
    .eq("id", supplier_id)
    .eq("user_id", user.id)
    .single();
  if (!supplier) return NextResponse.json({ error: "Supplier not found" }, { status: 404 });

  const { data: pair } = await supabase
    .from("opportunity_suppliers")
    .select("opportunity_id, opportunities ( name, main_keyword, recommended_path, legion_score )")
    .eq("supplier_id", supplier_id)
    .order("supplier_score", { ascending: false })
    .limit(1)
    .maybeSingle();

  const opp: any = pair?.opportunities ?? null;
  const productContext = opp
    ? `${opp.name ?? opp.main_keyword} (legion_score ${opp.legion_score}, path ${opp.recommended_path})`
    : "Amazon partnership opportunity";

  // 1) Search
  const search = await searchPeopleByCompany({
    domain: supplier.domain ?? undefined,
    companyName: supplier.domain ? undefined : (supplier.company_name ?? undefined),
    perPage: 25,
  });
  if (!search.ok) return NextResponse.json({ error: search.error }, { status: 500 });
  if (!search.people.length) {
    return NextResponse.json({ contacts: [], total: 0, note: "No candidates returned by Apollo." });
  }

  // 2) AI ranking
  const picks = await rankContacts({
    companyName: supplier.company_name ?? "this company",
    productContext,
    candidates: search.people.map(p => ({
      id: p.id,
      name: p.name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(),
      title: p.title,
      seniority: p.seniority,
      departments: p.departments,
    })),
  });

  // 3) Enrich each top pick
  const candidatesById = new Map(search.people.map(p => [p.id, p]));
  const saved: any[] = [];

  for (const pick of picks) {
    const candidate = candidatesById.get(pick.apollo_id);
    if (!candidate) continue;

    const e = await enrichPerson({
      apolloPersonId: candidate.id,
      firstName: candidate.first_name,
      lastName: candidate.last_name,
      organizationName: supplier.company_name ?? candidate.organization?.name,
      domain: supplier.domain ?? candidate.organization?.primary_domain,
      linkedinUrl: candidate.linkedin_url,
    });

    const enriched = e.ok ? e.person : candidate;

    // 4) Upsert contact
    const row = {
      user_id: user.id,
      supplier_id: supplier.id,
      apollo_person_id: enriched.id,
      full_name: enriched.name ?? `${enriched.first_name ?? ""} ${enriched.last_name ?? ""}`.trim(),
      first_name: enriched.first_name,
      last_name: enriched.last_name,
      title: enriched.title,
      seniority: enriched.seniority,
      departments: enriched.departments,
      email: enriched.email,
      email_status: enriched.email_status,
      linkedin_url: enriched.linkedin_url,
      city: enriched.city,
      state: enriched.state,
      country: enriched.country,
      source: "apollo",
      enriched_at: e.ok ? new Date().toISOString() : null,
      ai_priority_rank: pick.rank,
      ai_priority_reason: pick.reason,
    };

    const { data: upserted, error } = await supabase
      .from("contacts")
      .upsert(row, { onConflict: "apollo_person_id" })
      .select()
      .single();

    if (error) {
      // If upsert collided in a way that's invisible (no apollo_person_id), insert plain.
      const { data: inserted } = await supabase.from("contacts").insert(row).select().single();
      if (inserted) saved.push(inserted);
    } else if (upserted) {
      saved.push(upserted);
    }
  }

  return NextResponse.json({ contacts: saved, total: search.total });
}
