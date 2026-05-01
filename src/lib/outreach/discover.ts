/**
 * Phase 6 contact discovery pipeline.
 *
 *   brand → domain → Apollo organization → Apollo people →
 *   contact rows (one is_primary) → discovery_run row updated.
 *
 * No email is ever sent here — we only persist contact records the user can
 * later reference when generating drafts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { searchOrganizations, searchPeople, PHASE6_DECISION_MAKER_TITLES, type ApolloOrganization, type ApolloPerson } from "@/lib/apollo";
import { deriveDomain, nameSimilarity } from "./domain";

export interface DiscoverInput {
  userId: string;
  brand: BrandSummary;
}

export interface BrandSummary {
  id: string;
  name: string;
  name_normalized?: string | null;
  website?: string | null;
  disqualifier_tags?: string[] | null;
}

export interface DiscoverResult {
  ok: boolean;
  run_id: string;
  status: "completed" | "failed" | "no_match";
  organization?: ApolloOrganization | null;
  contacts_found: number;
  primary_contact_id?: string | null;
  domain_used?: string;
  domain_confidence?: "high" | "low";
  error?: string;
}

const SENIORITY_RANK: Record<string, number> = {
  owner: 100,
  founder: 100,
  c_suite: 95,
  president: 90,
  partner: 80,
  vp: 70,
  head: 65,
  director: 55,
  manager: 40,
};

function inferSeniority(person: ApolloPerson): string | null {
  if (person.seniority) return person.seniority;
  const t = (person.title ?? "").toLowerCase();
  if (/\b(ceo|chief executive|founder|co-?founder|owner)\b/.test(t)) return "c_suite";
  if (/\bpresident\b/.test(t)) return "c_suite";
  if (/\bcoo|chief operating\b/.test(t)) return "c_suite";
  if (/\bvp|vice president\b/.test(t)) return "vp";
  if (/\bhead of\b/.test(t)) return "head";
  if (/\bdirector\b/.test(t)) return "director";
  if (/\bmanager\b/.test(t)) return "manager";
  return null;
}

function inferDepartment(person: ApolloPerson): string | null {
  const t = (person.title ?? "").toLowerCase();
  if (/\b(ceo|chief executive|founder|co-?founder|owner|president|coo|chief operating)\b/.test(t)) return "executive";
  if (/\b(ecommerce|e-commerce|amazon|digital)\b/.test(t)) return "ecommerce";
  if (/\b(marketing|brand)\b/.test(t)) return "marketing";
  if (/\b(operation|ops|supply)\b/.test(t)) return "operations";
  return "other";
}

function rankPerson(p: ApolloPerson): number {
  const sen = (inferSeniority(p) ?? "").toLowerCase();
  const base = SENIORITY_RANK[sen] ?? 0;
  // Title-based bumps for our explicit title list.
  const t = (p.title ?? "").toLowerCase();
  let bonus = 0;
  if (/\bowner\b/.test(t)) bonus += 5;
  if (/\bfounder\b/.test(t)) bonus += 5;
  if (/\bceo\b/.test(t)) bonus += 4;
  if (/\bpresident\b/.test(t)) bonus += 3;
  if (/\bcoo\b/.test(t)) bonus += 2;
  if (/\bhead of (e-?commerce|amazon)\b/.test(t)) bonus += 2;
  return base + bonus;
}

export async function discoverContactsForBrand(
  supabase: SupabaseClient,
  input: DiscoverInput
): Promise<DiscoverResult> {
  const { userId, brand } = input;

  // 1) Insert running run row.
  const { data: run, error: runErr } = await supabase
    .from("contact_discovery_runs")
    .insert({
      user_id: userId,
      brand_id: brand.id,
      source: "apollo",
      status: "running",
    })
    .select("id")
    .maybeSingle();
  if (runErr || !run) {
    return {
      ok: false,
      run_id: "",
      status: "failed",
      contacts_found: 0,
      error: runErr?.message ?? "could not create discovery run",
    };
  }
  const runId = run.id as string;

  async function finishRun(patch: Record<string, unknown>) {
    await supabase
      .from("contact_discovery_runs")
      .update({ ...patch, completed_at: new Date().toISOString() })
      .eq("id", runId)
      .eq("user_id", userId);
  }

  // 2) Derive a domain.
  const derived = deriveDomain(brand);
  if (!derived) {
    await finishRun({ status: "failed", error_message: "no domain derivable" });
    await tagBrandNoContact(supabase, userId, brand);
    return { ok: false, run_id: runId, status: "failed", contacts_found: 0, error: "no domain derivable" };
  }

  // 3) Apollo organization search.
  const orgRes = await searchOrganizations(derived.domain);
  if (!orgRes.ok) {
    await finishRun({ status: "failed", error_message: orgRes.error });
    return { ok: false, run_id: runId, status: "failed", contacts_found: 0, domain_used: derived.domain, domain_confidence: derived.confidence, error: orgRes.error };
  }

  const candidates = orgRes.organizations;
  if (!candidates.length) {
    await finishRun({ status: "no_match", contacts_found: 0 });
    await tagBrandNoContact(supabase, userId, brand);
    return { ok: true, run_id: runId, status: "no_match", contacts_found: 0, organization: null, domain_used: derived.domain, domain_confidence: derived.confidence };
  }

  // Pick best org by name similarity, fall back to first result.
  const best = pickBestOrg(candidates, brand.name);

  // 4) People search.
  const peopleRes = await searchPeople({ organizationId: best.id, titles: PHASE6_DECISION_MAKER_TITLES, perPage: 10 });
  if (!peopleRes.ok) {
    await finishRun({ status: "failed", error_message: peopleRes.error });
    return { ok: false, run_id: runId, status: "failed", contacts_found: 0, organization: best, domain_used: derived.domain, domain_confidence: derived.confidence, error: peopleRes.error };
  }

  const people = peopleRes.people;
  if (!people.length) {
    await finishRun({ status: "no_match", contacts_found: 0 });
    await tagBrandNoContact(supabase, userId, brand);
    return { ok: true, run_id: runId, status: "no_match", contacts_found: 0, organization: best, domain_used: derived.domain, domain_confidence: derived.confidence };
  }

  // 5) Pick the highest-ranked C-suite person as primary.
  const ranked = [...people].map(p => ({ p, score: rankPerson(p) })).sort((a, b) => b.score - a.score);
  const primaryApolloId = ranked[0]?.p.id ?? null;

  // 6) Upsert contacts.
  let primaryContactId: string | null = null;
  let inserted = 0;
  for (const { p } of ranked) {
    const fullName = (p.name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim()) || "(unknown)";
    const seniority = inferSeniority(p);
    const department = inferDepartment(p);
    const isPrimary = p.id === primaryApolloId;

    // Match on apollo_person_id (unique). If the row exists for a different
    // brand or supplier, update the brand_id and primary flag.
    const { data: existing } = await supabase
      .from("contacts")
      .select("id")
      .eq("apollo_person_id", p.id)
      .eq("user_id", userId)
      .maybeSingle();

    const payload: Record<string, unknown> = {
      user_id: userId,
      brand_id: brand.id,
      full_name: fullName,
      first_name: p.first_name ?? null,
      last_name: p.last_name ?? null,
      title: p.title ?? null,
      seniority,
      department,
      departments: p.departments ?? null,
      email: p.email ?? null,
      email_status: p.email_status ?? null,
      linkedin_url: p.linkedin_url ?? null,
      city: p.city ?? null,
      state: p.state ?? null,
      country: p.country ?? null,
      apollo_person_id: p.id,
      apollo_raw: p as any,
      source: "apollo",
      enriched_at: p.email ? new Date().toISOString() : null,
      is_primary: isPrimary,
    };

    if (existing?.id) {
      await supabase
        .from("contacts")
        .update(payload)
        .eq("id", existing.id)
        .eq("user_id", userId);
      if (isPrimary) primaryContactId = existing.id as string;
    } else {
      const { data: ins } = await supabase
        .from("contacts")
        .insert(payload)
        .select("id")
        .maybeSingle();
      if (ins?.id) {
        if (isPrimary) primaryContactId = ins.id as string;
        inserted++;
      }
    }
  }

  // Make sure no other contact for this brand is is_primary.
  if (primaryContactId) {
    await supabase
      .from("contacts")
      .update({ is_primary: false })
      .eq("user_id", userId)
      .eq("brand_id", brand.id)
      .neq("id", primaryContactId);
  }

  await finishRun({
    status: "completed",
    contacts_found: people.length,
    credits_used: people.filter(p => !!p.email).length,
  });

  return {
    ok: true,
    run_id: runId,
    status: "completed",
    organization: best,
    contacts_found: people.length,
    primary_contact_id: primaryContactId,
    domain_used: derived.domain,
    domain_confidence: derived.confidence,
  };
}

function pickBestOrg(orgs: ApolloOrganization[], brandName: string): ApolloOrganization {
  let best = orgs[0];
  let bestScore = -1;
  for (const o of orgs) {
    const score = nameSimilarity(brandName, o.name ?? "");
    if (score > bestScore) {
      best = o;
      bestScore = score;
    }
  }
  return best;
}

async function tagBrandNoContact(
  supabase: SupabaseClient,
  userId: string,
  brand: BrandSummary
) {
  const tags = new Set<string>(brand.disqualifier_tags ?? []);
  if (tags.has("no_contact_path")) return;
  tags.add("no_contact_path");
  await supabase
    .from("brands")
    .update({ disqualifier_tags: Array.from(tags), updated_at: new Date().toISOString() })
    .eq("id", brand.id)
    .eq("user_id", userId);
}
