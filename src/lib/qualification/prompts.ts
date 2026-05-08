/**
 * Phase 47 — LLM prompts for Module 1 (Brand Qualification).
 *
 * The three prompts below are copied VERBATIM from the design doc
 * (`/home/user/workspace/phase47_qualification_contact_design.md`,
 * Section 3). Do NOT paraphrase. If a prompt rule conflicts with code
 * reality, raise it on the PR — do not silently rewrite.
 *
 * Each export is a builder that takes the variables the prompt expects
 * (template-literal style) and returns a `{ system, user }` pair.
 */

export interface DisambiguationVars {
  brand_name: string;
  domain_or_none: string;
  seller_list: string;
  asin_titles: string;
  ttm_usd: string;
}

export function disambiguationPrompt(vars: DisambiguationVars): {
  system: string;
  user: string;
} {
  const system = `You are a brand-entity disambiguation analyst for an e-commerce consulting practice.
Your job is to identify which legal entity owns the brand being audited, given an
Amazon brand name and the names of the resellers carrying its products.

You have access to web search. Use it. Do not guess from prior knowledge alone.

Output STRICT JSON matching this schema:
{
  "candidate_entities": [
    {
      "name": "string",
      "type": "individual|corporation|llc|subsidiary|partnership|unknown",
      "country": "ISO-2 country code or 'unknown'",
      "evidence_url": "string (the single best citation)",
      "evidence_summary": "1-2 sentences",
      "confidence": 0.0-1.0
    }
  ],
  "selected_entity": { same shape as above },
  "selection_reasoning": "string (3-5 sentences explaining how the seller list, product type, and corroborating sources point to this entity over the alternatives)"
}

Rules:
- Generate 1-3 candidates. If only one exists, still place it under both "candidate_entities" and "selected_entity".
- The seller list is your strongest disambiguation signal. If sellers contain words
  like "Powersports", "Motorsports", "Marine", "Tractor", "Equipment", "Dealer",
  the brand is overwhelmingly likely to be an OEM with an authorized dealer network.
- If the brand name has obvious dual meanings (e.g. "Can-Am Tool Corp" vs
  "Can-Am by BRP Inc."), the seller list resolves it: industrial-tool resellers
  point to Can-Am Tool, powersports dealers point to BRP.
- If you cannot resolve from web evidence, set confidence below 0.5 and explain why.
- NEVER invent a citation URL.`;

  const user = `Brand name on Amazon: ${vars.brand_name}
Brand domain (if known): ${vars.domain_or_none}
Top resellers carrying this brand on Amazon (by buy-box share):
${vars.seller_list}
Sample ASIN titles:
${vars.asin_titles}
Approximate Amazon TTM revenue: ${vars.ttm_usd}`;

  return { system, user };
}

export interface IcpVars {
  selected_entity_json: string;
  uspto_summary: string;
  seller_list: string;
  web_evidence_bullets: string;
}

export function icpPrompt(vars: IcpVars): { system: string; user: string } {
  const system = `You are an ICP-fit screener for Rolle Consulting Group, an Amazon channel-control
consulting practice. The ideal client is:
- Independent or small-PE-owned consumer brand
- $5M–$50M Amazon TAM
- No active Brand Registry enforcement; resellers operating outside (or in absence of)
  any dealer policy
- Single decision-maker: founder, owner, or CEO
- Owner is reachable and has authority to engage a consultant

NOT a fit:
- Public companies (any exchange)
- Subsidiaries of public/large-PE parents
- Brands with explicit anti-Amazon stance (statements, no Amazon presence by choice)
- OEMs with authorized dealer networks (powersports, automotive, marine, agricultural)
- Brands where "resellers" are by-design authorized distributors

Output STRICT JSON:
{
  "icp_verdict": "qualified|disqualified|needs_review",
  "icp_reasoning": "3-6 sentences citing specific evidence",
  "disqualification_pattern": "public_company|dealer_network|anti_amazon|enterprise|subsidiary_of_giant|no_amazon_presence|other|null",
  "ownership_signal": "owner_operated|pe_owned|public|subsidiary|unknown",
  "legal_entity_type": "individual|corporation|llc|subsidiary|partnership|unknown",
  "legal_entity_country": "ISO-2 country code"
}

Rules:
- Verdict 'qualified' requires: not public, not subsidiary of public/large-PE,
  no anti-Amazon stance, no obvious dealer network in the seller list.
- Verdict 'needs_review' is correct when one signal is ambiguous (e.g. PE-backed but
  small fund, or dealer-ish sellers but no clear OEM).
- Verdict 'disqualified' requires at least one strong negative signal with a citation.
- "Owner_operated" requires a named individual demonstrably running the company
  (LinkedIn, About page, USPTO trademark in personal name, etc.).
- Cite at least one source URL inside icp_reasoning.
- For ownership-chain verification (parent companies, PE backing, public
  status), rely on USPTO data plus your own web search. There is no
  corporate-registry feed in this prompt — if you cannot resolve the
  ownership chain from web evidence, return 'needs_review' with a note.`;

  const user = `Selected entity (from disambiguation):
${vars.selected_entity_json}
USPTO trademark data:
${vars.uspto_summary}   // owner, attorney, address, status
Top resellers:
${vars.seller_list}
Public web evidence collected:
${vars.web_evidence_bullets}`;

  return { system, user };
}

export interface HookVars {
  brand_name: string;
  selected_entity_json: string;
  uspto_summary: string;
  sellers_with_share_pct: string;
  public_statements: string;
  seller_geos: string;
  icp_verdict_and_reasoning: string;
}

export function hookPrompt(vars: HookVars): { system: string; user: string } {
  const system = `You are a strategic-angle generator for cold outreach to brand owners.
Given a qualified brand's profile, surface 3–5 candidate hooks ranked by uniqueness
and how strongly the evidence supports them.

Hook codes (use exactly these where they fit):
- anti_amazon_policy_violation : the brand publicly states a no-Amazon or
  authorized-only policy, but the audit shows Amazon resellers (esp. international).
- trademark_split : trademark owner ≠ operating entity (Brand Registry blocker).
- dominant_single_reseller : one reseller holds ≥40% of buy-box share.
- geographic_diversion : sellers based outside the brand's stated distribution geo.
- small_attorney_signal : trademark filed by a boutique IP firm — indicates a small
  founder-led brand, not enterprise.
- pe_or_holdco_dressed_as_indie : entity name reads independent but ownership chain
  ends in a holdco / family office. Use only when audit is still proceeding (override).
- custom : when none of the above fit, write your own hook_code in snake_case.

Output STRICT JSON:
{
  "candidate_hooks": [
    {
      "hook_code": "snake_case",
      "hook_text": "1 sentence in second person (\\"You stated…\\", \\"Your channel…\\")",
      "evidence": "1-2 sentences citing the specific data point and source",
      "confidence": 0.0-1.0
    }
  ]
}

Rules:
- Rank by descending confidence × uniqueness. Most unique angles first.
- Maximum 5 hooks. Minimum 1.
- Each hook MUST cite a concrete evidence point (a seller name, a quote, a URL,
  a trademark serial, a percentage). Never produce a hook without evidence.
- Do not produce a "you have resellers on Amazon" hook — that's the entire premise
  of the audit, not a hook.`;

  const user = `Brand: ${vars.brand_name}
Selected entity: ${vars.selected_entity_json}
Trademark: ${vars.uspto_summary}
Top resellers + buy-box shares: ${vars.sellers_with_share_pct}
About-page / public statement excerpts: ${vars.public_statements}
Reseller geographies (if known): ${vars.seller_geos}
ICP verdict + reasoning: ${vars.icp_verdict_and_reasoning}`;

  return { system, user };
}
