/**
 * Phase 69 — Company size tier classification.
 *
 * Inputs (in order of preference per spec):
 *   1. LinkedIn company page employee count
 *   2. Wikipedia infobox num_employees
 *   3. Apollo organization API employee count
 *   4. LLM estimate (last resort)
 */
import type { CompanySizeTier, SizeSignals, ControllingEntityShape } from "./strategy-types";

export function classifyTier(
  employees: number | null,
  _revenueUsd: number | null,
): CompanySizeTier {
  // Spec thresholds:
  //   < 10        → micro
  //   < 50        → small
  //   < 500       → mid
  //   500+        → enterprise
  const e = typeof employees === "number" && Number.isFinite(employees) ? employees : 0;
  if (e < 10) return "micro";
  if (e < 50) return "small";
  if (e < 500) return "mid";
  return "enterprise";
}

interface BrandLite {
  id?: string;
  name?: string | null;
  resolved_owner_domain?: string | null;
}

/**
 * Gather size signals for a brand. Reads Phase 68's controlling_entity
 * (gate_a_corporate_hierarchy.controlling_entity) so we use the audited
 * parent entity, not the brand row. Calls are best-effort; if a source
 * is unavailable we skip and try the next.
 */
export async function gatherSizeSignals(
  brand: BrandLite,
  controllingEntity: ControllingEntityShape | null,
  opts?: {
    fetchLinkedinCount?: (domain: string) => Promise<number | null>;
    fetchWikipediaEmployees?: (name: string) => Promise<number | null>;
    fetchApolloEmployees?: (domain: string) => Promise<number | null>;
  },
): Promise<SizeSignals> {
  const domain = controllingEntity?.domain ?? brand.resolved_owner_domain ?? null;
  const name = controllingEntity?.name ?? brand.name ?? null;

  const out: SizeSignals = {
    employees: null,
    revenue_usd: null,
    linkedin_count: null,
    wikipedia_employees: null,
    apollo_employees: null,
    source: "unknown",
  };

  if (domain && opts?.fetchLinkedinCount) {
    try {
      const n = await opts.fetchLinkedinCount(domain);
      if (typeof n === "number" && n > 0) {
        out.linkedin_count = n;
        out.employees = n;
        out.source = "linkedin";
        return out;
      }
    } catch {
      /* fall through */
    }
  }
  if (name && opts?.fetchWikipediaEmployees) {
    try {
      const n = await opts.fetchWikipediaEmployees(name);
      if (typeof n === "number" && n > 0) {
        out.wikipedia_employees = n;
        out.employees = n;
        out.source = "wikipedia";
        return out;
      }
    } catch {
      /* fall through */
    }
  }
  if (domain && opts?.fetchApolloEmployees) {
    try {
      const n = await opts.fetchApolloEmployees(domain);
      if (typeof n === "number" && n > 0) {
        out.apollo_employees = n;
        out.employees = n;
        out.source = "apollo";
        return out;
      }
    } catch {
      /* fall through */
    }
  }

  return out;
}
