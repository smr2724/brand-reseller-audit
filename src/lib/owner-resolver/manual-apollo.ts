/**
 * Phase 34.1 — Manual Apollo override helpers.
 *
 * Pulled out of the route module so we can unit-test the Apollo-search +
 * row-building logic without spinning up Next's request/response stack.
 * The route in `src/app/api/owner-resolver/manual-apollo-search/route.ts`
 * is the user-facing entry point — it owns auth, rate-limiting, and DB
 * persistence; this file owns the Apollo-call mechanics.
 */
import type {
  ApolloClient,
  ApolloOrganization,
  ApolloSearchTier,
} from "./apollo-client";

export interface ManualApolloRow {
  brand_id: string;
  resolution_run_id: string;
  candidate_company_name: string;
  candidate_domain: string | null;
  candidate_source: "apollo_manual" | "apollo_manual_crm";
  evidence_text: string | null;
  evidence_url: string | null;
  match_reason: string;
  trademark_serial_number: null;
  trademark_status: null;
  trademark_registration_date: null;
  trademark_owner_address: null;
  goods_services_text: null;
  heuristic_score: number;
  heuristic_label: string;
  needs_manual_review: boolean;
  is_manual_apollo: boolean;
  raw_payload: unknown;
  apollo_organization_id: string | null;
  apollo_organization_name: string | null;
  apollo_domain: string | null;
  apollo_employee_count: number | null;
  apollo_total_contacts: number | null;
  /** Phase 38 — fallback proxy when contact count is unavailable. */
  apollo_estimated_employees: number | null;
  apollo_hq_city: string | null;
  apollo_hq_country: string | null;
  apollo_industry: string | null;
  extractor_confidence: number | null;
  extractor_reasoning: string | null;
  evidence_urls: string[] | null;
}

export function buildManualRow(
  brandId: string,
  runId: string,
  companyName: string,
  org: ApolloOrganization,
  totalContacts: number | null,
  tierUsed: ApolloSearchTier | null,
): ManualApolloRow {
  const sourceSuffix =
    org.apollo_source === "crm" ? " [Your Apollo CRM]" : "";
  // Phase 34.4 — Distinct `candidate_source` for manual CRM hits so the
  // unique index doesn't reject the second insert when the same manual
  // search surfaces an org from both endpoints.
  const candidateSource: "apollo_manual" | "apollo_manual_crm" =
    org.apollo_source === "crm" ? "apollo_manual_crm" : "apollo_manual";
  return {
    brand_id: brandId,
    resolution_run_id: runId,
    candidate_company_name: org.name,
    candidate_domain: org.primary_domain,
    candidate_source: candidateSource,
    evidence_text: `Manual Apollo search for "${companyName}"`,
    evidence_url: null,
    match_reason: tierUsed
      ? `Manual Apollo match (tier=${tierUsed}) for "${companyName}"${sourceSuffix}`
      : `Manual Apollo match for "${companyName}"${sourceSuffix}`,
    trademark_serial_number: null,
    trademark_status: null,
    trademark_registration_date: null,
    trademark_owner_address: null,
    goods_services_text: null,
    heuristic_score: 0,
    heuristic_label: "unscored",
    needs_manual_review: false,
    is_manual_apollo: true,
    // Phase 34.3 — `apollo_source` rides in raw_payload so the UI can
    // render the right "Your Apollo CRM" / "Apollo Public" badge.
    raw_payload: {
      manual_query: companyName,
      apollo: org,
      apollo_source: org.apollo_source,
      tier: tierUsed,
    },
    apollo_organization_id: org.id,
    apollo_organization_name: org.name,
    apollo_domain: org.primary_domain,
    apollo_employee_count: org.estimated_num_employees,
    apollo_total_contacts: totalContacts,
    // Phase 38 — surface estimated_num_employees as a "~N employees"
    // proxy when mixed_people/search returned null. Never mixed with
    // apollo_total_contacts.
    apollo_estimated_employees:
      totalContacts == null ? org.estimated_num_employees ?? null : null,
    apollo_hq_city: org.organization_city,
    apollo_hq_country: org.organization_country,
    apollo_industry: org.industry,
    extractor_confidence: null,
    extractor_reasoning: null,
    evidence_urls: null,
  };
}

export function buildManualNoMatchRow(
  brandId: string,
  runId: string,
  companyName: string,
): ManualApolloRow {
  return {
    brand_id: brandId,
    resolution_run_id: runId,
    candidate_company_name: companyName,
    candidate_domain: null,
    candidate_source: "apollo_manual",
    evidence_text: `Manual Apollo search for "${companyName}" — no match`,
    evidence_url: null,
    match_reason: `Manual Apollo search for "${companyName}" — no match`,
    trademark_serial_number: null,
    trademark_status: null,
    trademark_registration_date: null,
    trademark_owner_address: null,
    goods_services_text: null,
    heuristic_score: 0,
    heuristic_label: "unscored",
    needs_manual_review: true,
    is_manual_apollo: true,
    raw_payload: { manual_query: companyName, no_match: true },
    apollo_organization_id: null,
    apollo_organization_name: null,
    apollo_domain: null,
    apollo_employee_count: null,
    apollo_total_contacts: null,
    apollo_estimated_employees: null,
    apollo_hq_city: null,
    apollo_hq_country: null,
    apollo_industry: null,
    extractor_confidence: null,
    extractor_reasoning: null,
    evidence_urls: null,
  };
}

/**
 * Run the Apollo 3-tier search for a user-supplied company name and
 * package the resulting orgs as `apollo_manual` candidate rows. Resolves
 * to `{ rows: [], no_match: true }` when Apollo found nothing — the route
 * decides whether to persist a no-match row in that case.
 *
 * Returned rows still carry a `__pending__` placeholder for
 * `resolution_run_id`; the route fills it in once it has the latest run.
 */
export async function runManualApolloSearch(
  brandId: string,
  companyName: string,
  apollo: ApolloClient | null,
): Promise<{
  rows: ManualApolloRow[];
  tier_used: ApolloSearchTier | null;
  no_match: boolean;
}> {
  if (!apollo) {
    return { rows: [], tier_used: null, no_match: true };
  }
  const tiered = await apollo.searchOrganizationsTiered(companyName, null);
  if (tiered.orgs.length === 0) {
    return { rows: [], tier_used: null, no_match: true };
  }
  const rows: ManualApolloRow[] = [];
  // Phase 34.3 — Dedup on id+source so the same company surfacing as
  // both CRM account and public org yields two rows.
  const seenIds = new Set<string>();
  for (const org of tiered.orgs) {
    const k = `${org.id}|${org.apollo_source}`;
    if (seenIds.has(k)) continue;
    seenIds.add(k);
    const total = await apollo.countContacts(org.id);
    rows.push(
      buildManualRow(brandId, "__pending__", companyName, org, total, tiered.tier_used),
    );
  }
  return { rows, tier_used: tiered.tier_used, no_match: false };
}
