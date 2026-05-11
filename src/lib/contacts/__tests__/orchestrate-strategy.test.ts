/**
 * Phase 69 follow-up — orchestrate-strategy regression tests.
 *
 * Covers the four reviewer blockers:
 *   1. Mid-tier classification: controlling_entity.employees=240 → tier='mid'
 *      and the strategy LLM is invoked with the mid template — NOT defaulted
 *      to 'micro' (the original bug, where gatherSizeSignals was called
 *      without opts and always returned employees=null).
 *   2. {brand_name} placeholders are substituted in primary_titles,
 *      secondary_titles, and named_candidates titles BEFORE Apollo is
 *      called — verified by inspecting the body passed to the Apollo
 *      mock.
 *   3. Strict hard-gate check: a brand with hard_gate_verdict=null gets a
 *      clear "must be re-qualified" error.
 *   4. Upsert path: orchestrator calls `.upsert(..., { onConflict:
 *      'brand_id' })`, not plain `.insert()`.
 *
 * Run directly:
 *   npx tsx src/lib/contacts/__tests__/orchestrate-strategy.test.ts
 */
import {
  buildContactStrategy,
  applyBrandNameSubstitution,
  extractControllingEntity,
  type BuildContactStrategyDeps,
} from "../orchestrate-strategy";
import type {
  ApolloMixedSearchInput,
  ApolloMixedSearchResult,
  ContactStrategy,
} from "../strategy-types";

let failures = 0;
let passes = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passes += 1;
  } else {
    failures += 1;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ────────────────────────────────────────────────────────────────
// Mock Supabase that captures every query/insert/upsert it sees.
// ────────────────────────────────────────────────────────────────
interface CapturedCall {
  table: string;
  method: string;
  payload?: any;
  options?: any;
}

interface QualFixture {
  hard_gate_verdict: string | null;
  gate_a_corporate_hierarchy: any;
}

function makeFakeSupabase(qual: QualFixture | null) {
  const calls: CapturedCall[] = [];
  const api: any = {
    _calls: calls,
    from(table: string) {
      let query: any;
      query = {
        _table: table,
        _filter: null as null | { col: string; val: any },
        select() {
          return query;
        },
        eq(col: string, val: any) {
          query._filter = { col, val };
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        async maybeSingle() {
          if (table === "brand_qualifications") {
            return { data: qual, error: null };
          }
          return { data: null, error: null };
        },
        insert(payload: any) {
          calls.push({ table, method: "insert", payload });
          return {
            select() {
              return {
                async single() {
                  return { data: { id: `${table}-id` }, error: null };
                },
              };
            },
          };
        },
        upsert(payload: any, options?: any) {
          calls.push({ table, method: "upsert", payload, options });
          return {
            select() {
              return {
                async single() {
                  return { data: { id: `${table}-id` }, error: null };
                },
              };
            },
          };
        },
        update(payload: any) {
          calls.push({ table, method: "update", payload });
          return {
            eq() {
              return { error: null };
            },
          };
        },
      };
      return query;
    },
  };
  return api;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────
function makeBrand(name = "Acme") {
  return {
    id: "brand-1",
    name,
    resolved_owner_domain: "acme.com",
    trailing_12_months: 80_000_000,
    confirmed_ttm_revenue_dollars: 80_000_000,
    est_monthly_revenue: 6_666_666,
  };
}

function emptyApolloResult(): ApolloMixedSearchResult {
  return {
    ok: true,
    candidates: [],
    total_entries: 0,
    pagination: { page: 1, per_page: 25, total_pages: 0 },
    cost_credits: 0.05,
  };
}

function stubStrategy(overrides?: Partial<ContactStrategy>): ContactStrategy {
  return {
    company_size_tier: "mid",
    primary_titles: ["Director of Amazon"],
    secondary_titles: ["Senior Manager E-commerce"],
    titles_to_avoid: ["CEO"],
    seniorities: ["director"],
    departments: ["sales"],
    profile_rationale: "stub",
    named_candidates: [],
    outreach_order: [],
    llm_verdict: "needs_human_review",
    llm_model: "stub",
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────
// BLOCKER 1: mid-tier classification when controlling_entity.employees=240
// ────────────────────────────────────────────────────────────────
(async () => {
  const supabase = makeFakeSupabase({
    hard_gate_verdict: "pass",
    gate_a_corporate_hierarchy: {
      controlling_entity: {
        name: "Acme Holdings",
        domain: "acme.com",
        employees: 240,
      },
    },
  });

  let observedTier: string | null = null;
  const deps: BuildContactStrategyDeps = {
    supabase,
    runStrategyLLM: async (input) => {
      observedTier = input.tier;
      return stubStrategy({ company_size_tier: input.tier });
    },
    apolloSearch: async () => emptyApolloResult(),
    runHunterFallbackImpl: async () => ({ candidates: [], cost_usd: 0, used: false }),
    runHunterDomainSearchMergeImpl: async () => ({ candidates: [], cost_usd: 0 }),
  };
  await buildContactStrategy(makeBrand(), deps);

  check(
    "BLOCKER 1: controlling_entity.employees=240 produces tier='mid'",
    observedTier === "mid",
    `observed tier: ${observedTier}`,
  );

  // Verify employees survived through to the persisted row
  const upsertContactStrategy = supabase._calls.find(
    (c: CapturedCall) => c.table === "contact_strategies" && c.method === "upsert",
  );
  check(
    "BLOCKER 1: persisted row has employees_estimate=240",
    !!upsertContactStrategy &&
      upsertContactStrategy.payload?.employees_estimate === 240,
    `payload.employees_estimate=${upsertContactStrategy?.payload?.employees_estimate}`,
  );
  check(
    "BLOCKER 1: persisted row has company_size_tier='mid'",
    upsertContactStrategy?.payload?.company_size_tier === "mid",
  );
})();

// ────────────────────────────────────────────────────────────────
// BLOCKER 1b: extractControllingEntity picks up employees from gateA
// ────────────────────────────────────────────────────────────────
{
  const ce = extractControllingEntity({
    gate_a_corporate_hierarchy: {
      controlling_entity: { name: "X", domain: "x.com", employees: 320 },
    },
  });
  check(
    "BLOCKER 1: extractControllingEntity threads employees",
    ce?.employees === 320,
  );
}

// ────────────────────────────────────────────────────────────────
// BLOCKER 2: substituteBrandName before Apollo call
// ────────────────────────────────────────────────────────────────
{
  const strategy = stubStrategy({
    primary_titles: ["GM, {brand_name}", "Director of Amazon"],
    secondary_titles: ["Brand Manager, {brand_name}"],
    named_candidates: [
      {
        name: "Jane Doe",
        title: "GM, {brand_name}",
        linkedin_url: null,
        reason: "",
        can_sign_50k: true,
        personal_stake: "p_and_l_owner",
      },
    ],
  });
  const substituted = applyBrandNameSubstitution(strategy, "Acme");
  check(
    "BLOCKER 2: primary_titles get {brand_name} replaced",
    substituted.primary_titles[0] === "GM, Acme",
    JSON.stringify(substituted.primary_titles),
  );
  check(
    "BLOCKER 2: secondary_titles get {brand_name} replaced",
    substituted.secondary_titles[0] === "Brand Manager, Acme",
  );
  check(
    "BLOCKER 2: named_candidates titles get {brand_name} replaced",
    substituted.named_candidates[0].title === "GM, Acme",
  );
}

// Integration: full orchestrator pipes {brand_name} through to Apollo.
(async () => {
  const supabase = makeFakeSupabase({
    hard_gate_verdict: "pass",
    gate_a_corporate_hierarchy: {
      controlling_entity: {
        name: "Acme Holdings",
        domain: "acme.com",
        employees: 240,
      },
    },
  });

  const capturedApolloInputs: ApolloMixedSearchInput[] = [];
  const deps: BuildContactStrategyDeps = {
    supabase,
    runStrategyLLM: async () =>
      stubStrategy({
        primary_titles: ["GM, {brand_name}", "Director of Amazon"],
        secondary_titles: [],
      }),
    apolloSearch: async (input) => {
      capturedApolloInputs.push(input);
      return emptyApolloResult();
    },
    runHunterFallbackImpl: async () => ({ candidates: [], cost_usd: 0, used: false }),
    runHunterDomainSearchMergeImpl: async () => ({ candidates: [], cost_usd: 0 }),
  };
  await buildContactStrategy(makeBrand("Acme"), deps);
  const firstCall = capturedApolloInputs[0];
  check(
    "BLOCKER 2: Apollo receives substituted titles (no {brand_name} literal)",
    !!firstCall &&
      firstCall.person_titles.includes("GM, Acme") &&
      !firstCall.person_titles.includes("GM, {brand_name}"),
    JSON.stringify(firstCall?.person_titles),
  );
})();

// ────────────────────────────────────────────────────────────────
// BLOCKER 3: upsert (not insert) on persist
// ────────────────────────────────────────────────────────────────
(async () => {
  const supabase = makeFakeSupabase({
    hard_gate_verdict: "pass",
    gate_a_corporate_hierarchy: {
      controlling_entity: {
        name: "Acme Holdings",
        domain: "acme.com",
        employees: 240,
      },
    },
  });
  const deps: BuildContactStrategyDeps = {
    supabase,
    runStrategyLLM: async () => stubStrategy(),
    apolloSearch: async () => emptyApolloResult(),
    runHunterFallbackImpl: async () => ({ candidates: [], cost_usd: 0, used: false }),
    runHunterDomainSearchMergeImpl: async () => ({ candidates: [], cost_usd: 0 }),
  };
  await buildContactStrategy(makeBrand(), deps);
  const upsert = supabase._calls.find(
    (c: CapturedCall) =>
      c.table === "contact_strategies" && c.method === "upsert",
  );
  const insert = supabase._calls.find(
    (c: CapturedCall) =>
      c.table === "contact_strategies" && c.method === "insert",
  );
  check(
    "BLOCKER 3: persist uses upsert, not insert",
    !!upsert && !insert,
    `upsert=${!!upsert} insert=${!!insert}`,
  );
  check(
    "BLOCKER 3: upsert specifies onConflict=brand_id",
    upsert?.options?.onConflict === "brand_id",
    JSON.stringify(upsert?.options),
  );
})();

// ────────────────────────────────────────────────────────────────
// BLOCKER 4: strict hard-gate check
// ────────────────────────────────────────────────────────────────
(async () => {
  // Case A: hard_gate_verdict is null → must refuse with re-qualify message
  const supabaseNull = makeFakeSupabase({
    hard_gate_verdict: null,
    gate_a_corporate_hierarchy: {
      controlling_entity: { name: "X", domain: "x.com", employees: 240 },
    },
  });
  const resultNull = await buildContactStrategy(makeBrand(), {
    supabase: supabaseNull,
    runStrategyLLM: async () => stubStrategy(),
    apolloSearch: async () => emptyApolloResult(),
    runHunterFallbackImpl: async () => ({ candidates: [], cost_usd: 0, used: false }),
    runHunterDomainSearchMergeImpl: async () => ({ candidates: [], cost_usd: 0 }),
  });
  check(
    "BLOCKER 4: hard_gate=null → error verdict",
    resultNull.verdict === "error",
    JSON.stringify(resultNull),
  );
  check(
    "BLOCKER 4: hard_gate=null → 're-qualified' reason",
    !!resultNull.reason && resultNull.reason.includes("re-qualified"),
    resultNull.reason ?? "",
  );

  // Case B: hard_gate_verdict='fail' → must refuse
  const supabaseFail = makeFakeSupabase({
    hard_gate_verdict: "fail",
    gate_a_corporate_hierarchy: {
      controlling_entity: { name: "X", domain: "x.com", employees: 240 },
    },
  });
  const resultFail = await buildContactStrategy(makeBrand(), {
    supabase: supabaseFail,
    runStrategyLLM: async () => stubStrategy(),
    apolloSearch: async () => emptyApolloResult(),
    runHunterFallbackImpl: async () => ({ candidates: [], cost_usd: 0, used: false }),
    runHunterDomainSearchMergeImpl: async () => ({ candidates: [], cost_usd: 0 }),
  });
  check(
    "BLOCKER 4: hard_gate='fail' → error verdict",
    resultFail.verdict === "error",
  );

  // Case C: hard_gate_verdict='pass' but no controlling_entity → still errors
  // (sanity — pre-existing behavior preserved)
  const supabasePass = makeFakeSupabase({
    hard_gate_verdict: "pass",
    gate_a_corporate_hierarchy: {},
  });
  const resultMissing = await buildContactStrategy(makeBrand(), {
    supabase: supabasePass,
    runStrategyLLM: async () => stubStrategy(),
    apolloSearch: async () => emptyApolloResult(),
    runHunterFallbackImpl: async () => ({ candidates: [], cost_usd: 0, used: false }),
    runHunterDomainSearchMergeImpl: async () => ({ candidates: [], cost_usd: 0 }),
  });
  check(
    "BLOCKER 4: hard_gate=pass + missing controlling_entity → error",
    resultMissing.verdict === "error",
  );
})();

// ────────────────────────────────────────────────────────────────
// Apollo cost from response
// ────────────────────────────────────────────────────────────────
(async () => {
  const supabase = makeFakeSupabase({
    hard_gate_verdict: "pass",
    gate_a_corporate_hierarchy: {
      controlling_entity: { name: "X", domain: "x.com", employees: 240 },
    },
  });
  const deps: BuildContactStrategyDeps = {
    supabase,
    runStrategyLLM: async () => stubStrategy(),
    apolloSearch: async () => ({
      ok: true,
      candidates: [],
      total_entries: 0,
      pagination: { page: 1, per_page: 25, total_pages: 0 },
      cost_credits: 0.07,
    }),
    runHunterFallbackImpl: async () => ({ candidates: [], cost_usd: 0, used: false }),
    runHunterDomainSearchMergeImpl: async () => ({ candidates: [], cost_usd: 0 }),
  };
  await buildContactStrategy(makeBrand(), deps);
  const upsert = supabase._calls.find(
    (c: CapturedCall) =>
      c.table === "contact_strategies" && c.method === "upsert",
  );
  // primary + secondary call each return cost_credits=0.07
  const reported = upsert?.payload?.apollo_cost_usd ?? 0;
  check(
    "Apollo cost uses parsed cost_credits (not hardcoded 0.15)",
    reported === 0.14,
    `reported=${reported}`,
  );
})();

// Wait for async chains to settle then print summary.
setTimeout(() => {
  console.log(`\norchestrate-strategy.test.ts: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}, 250);
