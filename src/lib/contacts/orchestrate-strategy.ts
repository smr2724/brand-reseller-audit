/**
 * Phase 69 — Contact Strategy orchestrator.
 *
 * `buildContactStrategy(brand)` pseudocode from the spec:
 *   1. Load the latest qualification row. Refuse unless
 *      hard_gate_verdict='pass' (Phase 68). Read controlling_entity
 *      from gate_a_corporate_hierarchy jsonb — never from the brand row.
 *   2. gatherSizeSignals + classifyTier.
 *   3. runContactStrategyLLM with verbatim prompt.
 *   4. apolloMixedPeopleSearch with primary titles.
 *   5. If thin, retry with secondary titles.
 *   6. Score + rank top 5.
 *   7. Hunter fallback when Apollo empty OR top score < 30.
 *   8. computeStrategyVerdict + persist row + flip brands.contact_strategy_id.
 *
 * Returns a `ContactStrategyResult`. Top-level catch mirrors the
 * Phase 67 qualification orchestrator — any unexpected throw lands as
 * verdict='error' on the persisted row rather than a silent 500.
 */
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { effectiveVerdict } from "@/lib/qualification/verdict";
import { classifyTier, gatherSizeSignals } from "./size-tier";
import { runContactStrategyLLM, computeStrategyVerdict } from "./strategy";
import { apolloMixedPeopleSearch } from "./apollo-mixed-search";
import { rankCandidates } from "./ranking";
import { runHunterFallback, runHunterDomainSearchMerge } from "./hunter-fallback";
import { substituteBrandName } from "./strategy-templates";
import {
  normalizeCompanySizeTier,
  normalizeStrategyVerdict,
} from "./normalize-strategy";
import type {
  ContactStrategyResult,
  ControllingEntityShape,
  ScoredCandidate,
  ContactStrategy,
  NamedCandidate,
  StrategyVerdict,
  ApolloPerson,
} from "./strategy-types";

export interface BrandForOrchestrate {
  id: string;
  name: string;
  resolved_owner_domain: string | null;
  trailing_12_months: number | null;
  confirmed_ttm_revenue_dollars: number | null;
  est_monthly_revenue: number | null;
}

/**
 * Test/dependency-injection hook. Production callers should not pass
 * `deps` — the defaults wire up the real Supabase admin client + real
 * Apollo/Hunter/LLM helpers.
 */
export interface BuildContactStrategyDeps {
  supabase?: ReturnType<typeof createSupabaseAdminClient> | null;
  runStrategyLLM?: typeof runContactStrategyLLM;
  apolloSearch?: typeof apolloMixedPeopleSearch;
  runHunterFallbackImpl?: typeof runHunterFallback;
  runHunterDomainSearchMergeImpl?: typeof runHunterDomainSearchMerge;
}

/**
 * Read the Phase 68 controlling entity from gate_a_corporate_hierarchy.
 * Falls back to the legacy `selected_entity` shape if Phase 68 hasn't
 * landed for this brand yet — defense-in-depth.
 */
export function extractControllingEntity(qual: any): ControllingEntityShape | null {
  const gateA = qual?.gate_a_corporate_hierarchy;
  if (gateA && typeof gateA === "object") {
    const ce = (gateA as any).controlling_entity;
    if (ce && typeof ce === "object") {
      const rawEmp = (ce as any).employees ?? (ce as any).employee_count ?? null;
      const employees =
        typeof rawEmp === "number" && Number.isFinite(rawEmp) && rawEmp > 0
          ? Math.round(rawEmp)
          : null;
      return {
        name: typeof ce.name === "string" ? ce.name : null,
        domain: typeof ce.domain === "string" ? ce.domain : null,
        type: typeof ce.type === "string" ? ce.type : null,
        country: typeof ce.country === "string" ? ce.country : null,
        employees,
      };
    }
  }
  const sel = qual?.selected_entity;
  if (sel && typeof sel === "object") {
    const rawEmp = (sel as any).employees ?? (sel as any).employee_count ?? null;
    const employees =
      typeof rawEmp === "number" && Number.isFinite(rawEmp) && rawEmp > 0
        ? Math.round(rawEmp)
        : null;
    return {
      name: typeof sel.name === "string" ? sel.name : null,
      domain: null,
      type: typeof sel.type === "string" ? sel.type : null,
      country: typeof sel.country === "string" ? sel.country : null,
      employees,
    };
  }
  return null;
}

/**
 * Phase 72 — extract a NamedCandidate from
 * `brand_qualifications.gate_c_named_decision_maker.person`. Returns
 * null when Gate C did not pass or the person record is missing the
 * first+last+full identity fields. When set, the candidate is wired
 * with `can_sign_50k=true` + `personal_stake='equity_owner'` so the
 * downstream verdict path treats Gate C's person as the ready primary
 * (Gate C is, by construction, the named decision-maker at the
 * controlling entity).
 */
export function extractGateCSeed(raw: unknown): NamedCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const gateC = raw as {
    passed?: unknown;
    person?:
      | {
          full_name?: unknown;
          first_name?: unknown;
          last_name?: unknown;
          title?: unknown;
          linkedin_url?: unknown;
          evidence_sources?: unknown;
        }
      | null
      | undefined;
  };
  if (gateC.passed !== true) return null;
  const person = gateC.person;
  if (!person || typeof person !== "object") return null;
  const first =
    typeof person.first_name === "string" ? person.first_name.trim() : "";
  const last =
    typeof person.last_name === "string" ? person.last_name.trim() : "";
  const fullFromField =
    typeof person.full_name === "string" ? person.full_name.trim() : "";
  const full = fullFromField || `${first} ${last}`.trim();
  // Gate C is only useful as a seed when we have at least first+last
  // (or a clearly-multi-word full_name) to feed downstream Apollo / MV.
  if (!full || (!first && !last && !full.includes(" "))) {
    // Structured warning so we can see when Gate C technically "passed"
    // but didn't capture enough identity to seed strategy.
    console.warn(
      JSON.stringify({
        event: "phase72_gate_c_seed_missing_fields",
        full_name: fullFromField || null,
        first_name: first || null,
        last_name: last || null,
      }),
    );
    return null;
  }
  const title =
    typeof person.title === "string" && person.title.trim().length > 0
      ? person.title.trim()
      : null;
  const linkedin =
    typeof person.linkedin_url === "string" && person.linkedin_url.trim().length > 0
      ? person.linkedin_url.trim()
      : null;
  const evidence = Array.isArray(person.evidence_sources)
    ? (person.evidence_sources as unknown[])
        .filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  return {
    name: full,
    title,
    linkedin_url: linkedin,
    reason: `Identified at qualification Gate C as the controlling entity's named decision-maker${title ? ` (${title})` : ""}.`,
    can_sign_50k: true,
    personal_stake: "equity_owner",
    full_name: full,
    first_name: first || (full.split(/\s+/)[0] ?? null),
    last_name:
      last ||
      (full.split(/\s+/).length > 1
        ? full.split(/\s+/).slice(1).join(" ")
        : null),
    source: "gate_c",
    confidence_seed: "high",
    evidence_sources: evidence,
  };
}

function findTopNamedMatch(
  ranked: ScoredCandidate[],
  strategy: ContactStrategy,
): NamedCandidate | null {
  if (ranked.length === 0) return null;
  const top = ranked[0].candidate;
  const fullName = `${top.first_name ?? ""} ${top.last_name ?? ""}`.trim().toLowerCase();
  const apolloName = (top.name ?? "").trim().toLowerCase();
  return (
    strategy.named_candidates.find((n) => {
      const ln = n.name.trim().toLowerCase();
      return ln && (ln === fullName || ln === apolloName);
    }) ?? null
  );
}

/**
 * Build opts for gatherSizeSignals. Today we rely on Phase 68's
 * resolution chain (controllingEntity.employees) — no live LinkedIn /
 * Wikipedia / Apollo helpers are wired here yet. Returning `undefined`
 * preserves the call signature; gatherSizeSignals already short-circuits
 * on controllingEntity.employees before reaching these helpers.
 */
function buildSizeSignalOpts():
  | {
      fetchLinkedinCount?: (domain: string) => Promise<number | null>;
      fetchWikipediaEmployees?: (name: string) => Promise<number | null>;
      fetchApolloEmployees?: (domain: string) => Promise<number | null>;
    }
  | undefined {
  return undefined;
}

/**
 * Apollo cost per call: prefer the parsed `cost_credits` (1 credit ≈
 * $0.05 in the credit-pool plan we run on) and fall back to the legacy
 * hardcoded $0.15 estimate only when Apollo omits the field entirely.
 */
function apolloCostFromResult(credits: number | undefined): number {
  if (typeof credits === "number" && Number.isFinite(credits) && credits > 0) {
    return credits;
  }
  return 0.15;
}

/**
 * Substitute `{brand_name}` in primary_titles, secondary_titles, and
 * each named_candidates entry's title. The template path already
 * handles this in `applyTemplate`, but the LLM-parse happy path returns
 * raw strings and {brand_name} would otherwise leak into Apollo.
 */
export function applyBrandNameSubstitution(
  strategy: ContactStrategy,
  brandName: string,
): ContactStrategy {
  return {
    ...strategy,
    primary_titles: substituteBrandName(strategy.primary_titles, brandName),
    secondary_titles: substituteBrandName(strategy.secondary_titles, brandName),
    named_candidates: strategy.named_candidates.map((c) => ({
      ...c,
      title:
        c.title && c.title.includes("{brand_name}")
          ? substituteBrandName([c.title], brandName)[0] ?? c.title
          : c.title,
    })),
  };
}

function computeRecoverableRevenueUsd(brand: BrandForOrchestrate): number {
  const ttm =
    brand.confirmed_ttm_revenue_dollars ??
    brand.trailing_12_months ??
    (brand.est_monthly_revenue ? brand.est_monthly_revenue * 12 : 0);
  return Math.round((ttm ?? 0) * 0.2); // recoverable slice; coarse proxy
}

export async function buildContactStrategy(
  brand: BrandForOrchestrate,
  deps?: BuildContactStrategyDeps,
): Promise<ContactStrategyResult> {
  try {
    return await buildContactStrategyInner(brand, deps);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const admin = deps?.supabase ?? createSupabaseAdminClient();
    if (admin) {
      try {
        const upsertResp = await admin
          .from("contact_strategies")
          .upsert(
            {
              brand_id: brand.id,
              company_size_tier: normalizeCompanySizeTier("small").value,
              primary_titles: [],
              verdict: normalizeStrategyVerdict("error").value,
              verdict_reason: reason.slice(0, 500),
              total_cost_usd: 0,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "brand_id" },
          )
          .select("id")
          .single();
        if (upsertResp.data?.id) {
          await admin
            .from("brands")
            .update({ contact_strategy_id: upsertResp.data.id })
            .eq("id", brand.id);
        }
      } catch {
        /* never block */
      }
    }
    return { ok: false, verdict: "error", strategy_id: null, reason };
  }
}

async function buildContactStrategyInner(
  brand: BrandForOrchestrate,
  deps?: BuildContactStrategyDeps,
): Promise<ContactStrategyResult> {
  const admin = deps?.supabase ?? createSupabaseAdminClient();
  if (!admin) {
    return { ok: false, verdict: "error", strategy_id: null, reason: "supabase admin missing" };
  }
  const runLLM = deps?.runStrategyLLM ?? runContactStrategyLLM;
  const runApollo = deps?.apolloSearch ?? apolloMixedPeopleSearch;
  const runHunter = deps?.runHunterFallbackImpl ?? runHunterFallback;
  const runHunterDomain =
    deps?.runHunterDomainSearchMergeImpl ?? runHunterDomainSearchMerge;

  const { data: qual } = await admin
    .from("brand_qualifications")
    .select("*")
    .eq("brand_id", brand.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!qual) {
    return {
      ok: false,
      verdict: "error",
      strategy_id: null,
      reason: "Brand not qualified — no brand_qualifications row found.",
    };
  }

  // Phase 71 — read the EFFECTIVE verdict so a manual override propagates
  // through to Contact Strategy. Preserves the Phase 69 server-side hard
  // gate bypass safety: we still refuse when the effective
  // hard_gate_verdict isn't 'pass'. The override path forces
  // hard_gate_verdict='pass'; raw 'qualified' icp_verdict alone cannot
  // bypass a 'hard_disqualify' hard gate.
  const rawHardGate = (qual as any).hard_gate_verdict ?? null;
  const eff = effectiveVerdict({
    icp_verdict: (qual as any).icp_verdict ?? null,
    hard_gate_verdict: rawHardGate,
    manual_override: (qual as any).manual_override === true,
  });
  if (eff.hard_gate_verdict !== "pass") {
    const reason =
      rawHardGate == null
        ? "Brand must be re-qualified under Phase 68 hard gates before contact strategy can run. Re-trigger qualification first."
        : 'Brand not qualified — hard_gate_verdict is not "pass".';
    return {
      ok: false,
      verdict: "error",
      strategy_id: null,
      reason,
    };
  }

  const controlling = extractControllingEntity(qual);
  if (!controlling) {
    return {
      ok: false,
      verdict: "error",
      strategy_id: null,
      reason: "Phase 68 controlling_entity is missing from gate_a_corporate_hierarchy.",
    };
  }

  // 1. Size classification. Pass opts so gatherSizeSignals can resolve
  // employee counts when Phase 68 didn't already capture one. The
  // controllingEntity.employees path inside gatherSizeSignals is the
  // authoritative shortcut when Phase 68 has it.
  const sizeSignals = await gatherSizeSignals(
    { id: brand.id, name: brand.name, resolved_owner_domain: brand.resolved_owner_domain },
    controlling,
    buildSizeSignalOpts(),
  );

  if (sizeSignals.employees == null) {
    console.warn(
      JSON.stringify({
        event: "phase69_size_signals_empty",
        brand_id: brand.id,
        brand_name: brand.name,
        controlling_entity: controlling?.name ?? null,
        message: "size signals empty — defaulting to micro",
      }),
    );
  }
  const tier = classifyTier(sizeSignals.employees, sizeSignals.revenue_usd);

  if (tier === "enterprise") {
    console.warn(
      JSON.stringify({
        event: "phase69_enterprise_post_qualification",
        brand_id: brand.id,
        brand_name: brand.name,
        controlling_entity: controlling,
        employees: sizeSignals.employees,
      }),
    );
    return await persist(admin, {
      brand_id: brand.id,
      qualification_id: qual.id ?? null,
      size_tier: tier,
      employees_estimate: sizeSignals.employees,
      revenue_estimate_usd: sizeSignals.revenue_usd,
      size_signals: sizeSignals,
      strategy: emptyStrategy(),
      ranked: [],
      verdict: "needs_human_review",
      verdict_reason:
        "Tier classified as enterprise post-qualification — possible Phase 68 data-quality bug.",
      llm_cost_usd: 0,
      apollo_cost_usd: 0,
      hunter_cost_usd: 0,
    });
  }

  // 2. Strategy LLM.
  //
  // Phase 72 — read Gate C decision-maker BEFORE the LLM step. When
  // Gate C named a real human, that person seeds named_candidates
  // directly with verdict='ready' and we skip the LLM "name candidates
  // from public signals" step entirely (it hallucinates names too
  // often — see Carna4's `maria-ringo-4a6b1b16` bogus slug). We still
  // run the full LLM call for the size-tier classification + Profile /
  // Avoid / rationale, then overwrite named_candidates with the Gate C
  // seed and force the verdict.
  const recoverable = computeRecoverableRevenueUsd(brand);
  const gateCName = ((qual as any).gate_c_person_name as string | undefined) ?? null;
  const gateCTitle = ((qual as any).gate_c_person_title as string | undefined) ?? null;
  const gateCSeed = extractGateCSeed((qual as any).gate_c_named_decision_maker);

  const rawStrategy = await runLLM({
    brand: { id: brand.id, name: brand.name },
    controllingEntity: controlling,
    tier,
    sizeSignals,
    recoverableRevenueUsd: recoverable,
    gateCPersonName: gateCName,
    gateCPersonTitle: gateCTitle,
  });

  // Replace `{brand_name}` placeholders in every title list BEFORE we
  // hand them to Apollo. Without this, the literal `{brand_name}` string
  // leaks into person_titles[] on the LLM-parse happy path.
  let strategy = applyBrandNameSubstitution(rawStrategy, brand.name);

  // Phase 72 — overwrite LLM named_candidates with the Gate C person
  // when Gate C passed and produced a usable person. Verdict path
  // below is also forced to 'ready' in computeStrategyVerdict by way
  // of the seeded can_sign_50k=true + personal_stake!='none' shape.
  let gateCForcedVerdict = false;
  if (gateCSeed) {
    strategy = {
      ...strategy,
      named_candidates: [gateCSeed],
      outreach_order: [gateCSeed.name],
    };
    gateCForcedVerdict = true;
  }

  // 3. Apollo primary titles.
  let apolloCost = 0;
  const primaryResp = await runApollo({
    q_organization_domains: controlling.domain ? [controlling.domain] : [],
    person_titles: strategy.primary_titles,
    person_seniorities: strategy.seniorities,
    person_departments: strategy.departments,
    per_page: 25,
  });
  apolloCost += apolloCostFromResult(primaryResp.cost_credits);
  let allCandidates: ApolloPerson[] = primaryResp.candidates;

  // 4. If thin, retry with secondary titles.
  if (allCandidates.length < 3 && strategy.secondary_titles.length > 0) {
    const secResp = await runApollo({
      q_organization_domains: controlling.domain ? [controlling.domain] : [],
      person_titles: strategy.secondary_titles,
      person_seniorities: strategy.seniorities,
      person_departments: strategy.departments,
      per_page: 25,
    });
    apolloCost += apolloCostFromResult(secResp.cost_credits);
    allCandidates = [...allCandidates, ...secResp.candidates];
  }

  // 5. Score + rank top 5.
  let ranked = rankCandidates(allCandidates, strategy, { name: brand.name });

  // 6. Hunter fallback if empty or top low-confidence.
  let hunterCost = 0;
  if (ranked.length === 0 || (ranked[0]?.score ?? 0) < 30) {
    const hunter = await runHunter(controlling.domain, strategy);
    hunterCost = hunter.cost_usd;
    if (hunter.candidates.length > 0) {
      const merged = [...allCandidates, ...hunter.candidates];
      ranked = rankCandidates(merged, strategy, { name: brand.name });
    }
  }

  // 6b. Phase 69 follow-up — Hunter domain-search merge for the
  // zero-LLM-named + zero-Apollo blind spot. Pulls the org's public
  // people list and filters by primary titles before merging into the
  // ranking pool.
  if (
    strategy.named_candidates.length === 0 &&
    allCandidates.length === 0 &&
    controlling.domain
  ) {
    const merge = await runHunterDomain(controlling.domain, strategy);
    hunterCost += merge.cost_usd;
    if (merge.candidates.length > 0) {
      const merged = [...allCandidates, ...merge.candidates];
      ranked = rankCandidates(merged, strategy, { name: brand.name });
    }
  }

  // 7. Verdict.
  const topNamed = findTopNamedMatch(ranked, strategy);
  const scores = ranked.map((r) => r.score);
  let { verdict, reason } = computeStrategyVerdict(strategy, scores, topNamed);

  // Phase 72 — Gate C produced a named decision-maker before this run.
  // That person IS the contact target; we don't need Apollo/Hunter to
  // confirm them. Force verdict='ready' so the UI doesn't display
  // 'needs_human_review' for a brand where qualification already named
  // the decision-maker.
  if (gateCForcedVerdict) {
    verdict = "ready";
    reason = "";
  }

  return await persist(admin, {
    brand_id: brand.id,
    qualification_id: qual.id ?? null,
    size_tier: tier,
    employees_estimate: sizeSignals.employees,
    revenue_estimate_usd: sizeSignals.revenue_usd,
    size_signals: sizeSignals,
    strategy,
    ranked,
    verdict,
    verdict_reason: reason,
    llm_cost_usd: strategy.cost_usd,
    apollo_cost_usd: apolloCost,
    hunter_cost_usd: hunterCost,
  });
}

function emptyStrategy(): ContactStrategy {
  return {
    company_size_tier: "enterprise",
    primary_titles: [],
    secondary_titles: [],
    titles_to_avoid: [],
    seniorities: [],
    departments: [],
    profile_rationale: "",
    named_candidates: [],
    outreach_order: [],
    llm_verdict: "needs_human_review",
    llm_model: "",
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
  };
}

async function persist(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  input: {
    brand_id: string;
    qualification_id: string | null;
    size_tier: ContactStrategy["company_size_tier"];
    employees_estimate: number | null;
    revenue_estimate_usd: number | null;
    size_signals: unknown;
    strategy: ContactStrategy;
    ranked: ScoredCandidate[];
    verdict: StrategyVerdict;
    verdict_reason: string;
    llm_cost_usd: number;
    apollo_cost_usd: number;
    hunter_cost_usd: number;
  },
): Promise<ContactStrategyResult> {
  if (!admin) {
    return { ok: false, verdict: "error", strategy_id: null, reason: "supabase admin missing" };
  }

  // Phase 67 normalize.ts pattern — clamp enums before INSERT.
  const tier = normalizeCompanySizeTier(input.size_tier).value;
  const verdict = normalizeStrategyVerdict(input.verdict).value;

  const totalCost =
    input.llm_cost_usd + input.apollo_cost_usd + input.hunter_cost_usd;

  const row = {
    brand_id: input.brand_id,
    qualification_id: input.qualification_id,
    company_size_tier: tier,
    employees_estimate: input.employees_estimate,
    revenue_estimate_usd: input.revenue_estimate_usd,
    size_signals: input.size_signals,
    primary_titles: input.strategy.primary_titles,
    secondary_titles: input.strategy.secondary_titles,
    titles_to_avoid: input.strategy.titles_to_avoid,
    seniorities: input.strategy.seniorities,
    departments: input.strategy.departments,
    profile_rationale: input.strategy.profile_rationale,
    named_candidates: input.strategy.named_candidates,
    outreach_order: input.strategy.outreach_order,
    verdict,
    verdict_reason: input.verdict_reason,
    llm_model: input.strategy.llm_model,
    llm_tokens_in: input.strategy.tokens_in,
    llm_tokens_out: input.strategy.tokens_out,
    llm_cost_usd: input.llm_cost_usd,
    apollo_cost_usd: input.apollo_cost_usd,
    hunter_cost_usd: input.hunter_cost_usd,
    total_cost_usd: totalCost,
    updated_at: new Date().toISOString(),
  };

  const ins = await admin
    .from("contact_strategies")
    .upsert(row, { onConflict: "brand_id" })
    .select("id")
    .single();

  if (ins.error || !ins.data?.id) {
    return {
      ok: false,
      verdict: "error",
      strategy_id: null,
      reason: ins.error?.message ?? "upsert returned no id",
    };
  }

  await admin
    .from("brands")
    .update({ contact_strategy_id: ins.data.id })
    .eq("id", input.brand_id);

  return {
    ok: verdict !== "error",
    verdict,
    strategy_id: ins.data.id,
    reason: input.verdict_reason,
    ranked: input.ranked,
  };
}
