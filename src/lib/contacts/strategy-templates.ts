/**
 * Phase 69 — Tier-keyed ideal contact profile templates.
 *
 * VERBATIM from phase69_contact_strategy_spec.md §"Tier → ideal contact
 * profile mapping". The LLM step adjusts these per-brand (e.g.
 * substitutes `{brand_name}` slots and may promote/demote titles based
 * on visible org structure).
 */
import type { CompanySizeTier, ContactProfileTemplate } from "./strategy-types";

export const TIER_PROFILES: Record<CompanySizeTier, ContactProfileTemplate> = {
  micro: {
    primary_titles: ["Founder", "Co-Founder", "Owner", "CEO", "President"],
    secondary_titles: ["Managing Director", "Principal"],
    titles_to_avoid: ["CMO", "CFO", "CTO", "PR", "Legal", "HR"],
    seniorities: ["owner", "founder", "c_suite"],
    departments: ["founder", "executive"],
    rationale_template:
      "Micro brands (under 10 employees) are owner-operated. Pitch the founder directly.",
  },
  small: {
    primary_titles: ["Founder", "Co-Founder", "CEO", "President", "COO", "GM"],
    secondary_titles: ["VP Operations", "VP Sales", "Head of E-commerce"],
    titles_to_avoid: ["CMO", "CFO", "CTO", "PR", "Legal", "HR"],
    seniorities: ["owner", "founder", "c_suite"],
    departments: ["founder", "executive", "operations"],
    rationale_template:
      "Small brands (10–50 employees) are founder-led with operations leadership. Founder ratifies; operator decides. Pitch both.",
  },
  mid: {
    primary_titles: [
      "VP Amazon",
      "VP E-commerce",
      "VP Digital",
      "Director of Amazon",
      "Director of E-commerce",
      "Director Marketplace",
      "Head of Amazon",
      "Head of Digital",
      "Head of E-commerce",
      "GM, {brand_name}",
      "President, {brand_name}",
      "Brand Manager, {brand_name}",
    ],
    secondary_titles: [
      "Senior Manager Amazon",
      "Senior Manager E-commerce",
      "Director Online Sales",
    ],
    titles_to_avoid: ["CEO", "CMO", "CFO", "CTO", "Holding Co.", "PR", "Legal"],
    seniorities: ["director", "vp", "head"],
    departments: ["sales", "marketing", "operations"],
    rationale_template:
      "Mid-tier ($25M–$500M) delegates channel ownership to a functional leader. Pitch the person whose comp/bonus depends on the Amazon P&L, NOT the holding-co CEO.",
  },
  enterprise: {
    primary_titles: [],
    secondary_titles: [],
    titles_to_avoid: [],
    seniorities: [],
    departments: [],
    rationale_template:
      "Enterprise (500+) should be disqualified at Gate A. If you see this profile, treat as data-quality bug.",
  },
};

/**
 * Replace `{brand_name}` slots in a list of titles with the actual brand
 * name. Empty/null brand name falls back to dropping the placeholder so
 * we don't emit literal `{brand_name}` strings.
 */
export function substituteBrandName(
  titles: string[],
  brandName: string | null,
): string[] {
  if (!brandName) {
    return titles.map((t) => t.replace(/,\s*\{brand_name\}/g, "").trim());
  }
  return titles.map((t) => t.replace(/\{brand_name\}/g, brandName));
}

export function applyTemplate(
  tier: CompanySizeTier,
  brandName: string | null,
): ContactProfileTemplate {
  const base = TIER_PROFILES[tier];
  return {
    ...base,
    primary_titles: substituteBrandName(base.primary_titles, brandName),
    secondary_titles: substituteBrandName(base.secondary_titles, brandName),
  };
}
