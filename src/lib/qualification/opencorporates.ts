/**
 * Phase 47 — OpenCorporates lookup for qualification.
 *
 * Free tier without key for low volume; key bumps quota
 * (`OPENCORPORATES_API_KEY`). Used to confirm legal entity type and
 * parent-company chain (catches "indie brand owned by holdco" cases).
 * Failure mode: degrade to LLM-only entity selection.
 */
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export interface OpenCorporatesSummary {
  called: boolean;
  found: boolean;
  legal_name: string | null;
  company_type: string | null;
  jurisdiction: string | null;
  inactive: boolean | null;
  parent_company: string | null;
  source_url: string | null;
  raw: unknown;
  error: string | null;
}

async function logApi(
  endpoint: string,
  status: number | string,
  summary: string,
): Promise<void> {
  try {
    const admin = createSupabaseAdminClient();
    if (!admin) return;
    await admin.from("api_logs").insert({
      provider: "opencorporates",
      endpoint,
      request_summary: summary.slice(0, 500),
      response_status: String(status),
      cost_estimate: 0,
    });
  } catch {
    /* never block on log */
  }
}

export async function lookupEntity(
  name: string,
  country?: string,
): Promise<OpenCorporatesSummary> {
  const empty: OpenCorporatesSummary = {
    called: false,
    found: false,
    legal_name: null,
    company_type: null,
    jurisdiction: null,
    inactive: null,
    parent_company: null,
    source_url: null,
    raw: null,
    error: null,
  };
  if (!name || !name.trim()) return empty;

  const params = new URLSearchParams();
  params.set("q", name.trim());
  params.set("per_page", "5");
  params.set("order", "score");
  if (country && country.length === 2) {
    params.set("country_code", country.toLowerCase());
  }
  const apiKey = process.env.OPENCORPORATES_API_KEY;
  if (apiKey) params.set("api_token", apiKey);
  const url = `https://api.opencorporates.com/v0.4/companies/search?${params.toString()}`;
  let resp: Response;
  try {
    resp = await fetch(url, { method: "GET" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logApi("/companies/search", "error", `name=${name} err=${msg}`);
    return { ...empty, called: true, error: msg };
  }
  if (!resp.ok) {
    await logApi("/companies/search", resp.status, `name=${name} non-ok`);
    return { ...empty, called: true, error: `oc_${resp.status}` };
  }
  const json = (await resp.json().catch(() => ({}))) as {
    results?: {
      companies?: Array<{
        company?: {
          name?: string;
          company_type?: string;
          jurisdiction_code?: string;
          inactive?: boolean;
          opencorporates_url?: string;
          parent_name?: string;
          ownership_summary?: string;
        };
      }>;
    };
  };
  await logApi("/companies/search", resp.status, `name=${name}`);
  const top = json?.results?.companies?.[0]?.company ?? null;
  if (!top) {
    return { ...empty, called: true, raw: json };
  }
  return {
    called: true,
    found: true,
    legal_name: top.name ?? null,
    company_type: top.company_type ?? null,
    jurisdiction: top.jurisdiction_code ?? null,
    inactive: typeof top.inactive === "boolean" ? top.inactive : null,
    parent_company: top.parent_name ?? null,
    source_url: top.opencorporates_url ?? null,
    raw: json,
    error: null,
  };
}

export function summarizeOpenCorporates(s: OpenCorporatesSummary): string {
  if (!s.called) return "OpenCorporates: not called";
  if (s.error) return `OpenCorporates: error — ${s.error}`;
  if (!s.found) return "OpenCorporates: no record found";
  const parts: string[] = [];
  if (s.legal_name) parts.push(`Legal: ${s.legal_name}`);
  if (s.company_type) parts.push(`Type: ${s.company_type}`);
  if (s.jurisdiction) parts.push(`Jurisdiction: ${s.jurisdiction}`);
  if (s.inactive != null) parts.push(`Inactive: ${s.inactive ? "yes" : "no"}`);
  if (s.parent_company) parts.push(`Parent: ${s.parent_company}`);
  if (s.source_url) parts.push(`Source: ${s.source_url}`);
  return parts.join(" | ");
}
