/**
 * Phase 68 — Seven-brand acceptance fixtures.
 *
 * Each fixture describes the expected hard-gate verdict + failure gate +
 * pattern for a known canonical brand. The hard-gates.test.ts harness
 * stubs prescreen / hierarchy / gate-c / rejection-sim with deterministic
 * responses keyed on brand name and verifies the sequential evaluator
 * routes correctly to the expected outcome.
 *
 * These are not live LLM tests — that would be both flaky and expensive
 * to run in CI. The fixtures encode what the system MUST produce when
 * the upstream LLM emits the canonical answer; live drift is caught by
 * the production cost + verdict telemetry.
 */
import type { GateAResult } from "../hierarchy";
import type { PrescreenHit } from "../prescreen";

export type ExpectedVerdict = "pass" | "hard_disqualify" | "needs_review";

export interface SevenBrandFixture {
  brand: string;
  description?: string;
  top_sellers: string[];
  brand_revenue_usd: number;
  recoverable_revenue_usd: number;
  prescreen_stub: PrescreenHit | null;
  gate_a_stub: GateAResult;
  // Stubbed Gate C person + stake outcome. Only consulted when Gate A/B pass.
  gate_c_passed: boolean;
  gate_c_person_name?: string | null;
  // Stubbed rejection sim. Only consulted when Gate C passes.
  rejection_verdict?: "pursue_ok" | "do_not_pursue";
  // Expected end-state.
  expected_verdict: ExpectedVerdict;
  expected_failure_gate?:
    | "pattern_prescreen"
    | "gate_a"
    | "gate_b"
    | "gate_c"
    | "rejection_sim"
    | null;
  expected_pattern?: string | null;
  expected_pattern_one_of?: string[];
  notes?: string;
}

const passing = (
  name: string,
  ownership:
    | "private_independent"
    | "family_office"
    | "holding_co_private"
    | "pe_owned",
  revenue: number,
  employees = 50,
): GateAResult => ({
  passed: true,
  verdict: "pass",
  controlling_entity: {
    name,
    ticker: null,
    exchange: null,
    revenue_usd: revenue,
    employees,
    ownership_type: ownership,
    parent_chain: [name],
  },
  verdict_reason: `Controlling entity ${name} is ${ownership.replace(/_/g, " ")}.`,
  sources: [
    {
      type: "wikipedia",
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/\s+/g, "_"))}`,
      excerpt: "Stubbed Wikipedia source for fixture.",
    },
  ],
  pattern: null,
  resolution_trace: {
    uspto_called: true,
    uspto_owner: name,
    wikipedia_called: true,
    wikipedia_hit: true,
    edgar_called: false,
    edgar_hit: false,
    llm_called: true,
  },
  cost_usd: 0.001,
});

const publicParent = (
  name: string,
  ticker: string,
  exchange: string,
  revenue: number,
  employees: number,
  brand: string,
): GateAResult => ({
  passed: false,
  verdict: "hard_disqualify",
  controlling_entity: {
    name,
    ticker,
    exchange,
    revenue_usd: revenue,
    employees,
    ownership_type: "public",
    parent_chain: [brand, name],
  },
  verdict_reason: `Controlling entity ${name} (${exchange}: ${ticker}) is publicly traded with $${Math.round(revenue / 1_000_000_000)}B revenue.`,
  sources: [
    {
      type: "wikipedia",
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/\s+/g, "_"))}`,
      excerpt: "Stubbed Wikipedia source for fixture.",
    },
    {
      type: "sec_edgar",
      url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000${ticker.padStart(6, "0")}&type=10-K`,
      excerpt: `Exhibit 21 lists ${brand} as subsidiary.`,
    },
  ],
  pattern: "subsidiary_of_public",
  resolution_trace: {
    uspto_called: true,
    uspto_owner: name,
    wikipedia_called: true,
    wikipedia_hit: true,
    edgar_called: true,
    edgar_hit: true,
    llm_called: true,
  },
  cost_usd: 0.001,
});

export const SEVEN_BRAND_FIXTURES: SevenBrandFixture[] = [
  {
    brand: "Alexander Home",
    description: "Home goods brand owned by Ferro Holdings.",
    top_sellers: ["Alexander Home Direct", "Bayside Living"],
    brand_revenue_usd: 3_000_000,
    recoverable_revenue_usd: 300_000,
    prescreen_stub: null,
    gate_a_stub: passing("Ferro Holdings", "private_independent", 3_000_000, 25),
    gate_c_passed: true,
    gate_c_person_name: "Kevin Ferro",
    rejection_verdict: "pursue_ok",
    expected_verdict: "pass",
    expected_failure_gate: null,
    expected_pattern: null,
  },
  {
    brand: "Carna4",
    description: "Hand-crafted pet food brand, co-founder owned.",
    top_sellers: ["Carna4 USA", "Pet Food Direct"],
    brand_revenue_usd: 3_000_000,
    recoverable_revenue_usd: 250_000,
    prescreen_stub: null,
    gate_a_stub: passing("Carna4", "private_independent", 3_000_000, 12),
    gate_c_passed: true,
    gate_c_person_name: "Maria Ringo",
    rejection_verdict: "pursue_ok",
    expected_verdict: "pass",
    expected_failure_gate: null,
    expected_pattern: null,
  },
  {
    brand: "C.O. Bigelow",
    description: "Apothecary brand, family principal owned.",
    top_sellers: ["C.O. Bigelow Apothecary", "Bigelow Pharmacy"],
    brand_revenue_usd: 5_000_000,
    recoverable_revenue_usd: 400_000,
    prescreen_stub: null,
    gate_a_stub: passing("C.O. Bigelow Apothecary", "family_office", 5_000_000, 30),
    gate_c_passed: true,
    gate_c_person_name: "Ian Ginsberg",
    rejection_verdict: "pursue_ok",
    expected_verdict: "pass",
    expected_failure_gate: null,
    expected_pattern: null,
  },
  {
    brand: "Beauty Secrets",
    description: "Salon-supply brand owned by Sally Beauty Holdings (NYSE: SBH).",
    top_sellers: ["Sally Beauty", "Cosmoprof"],
    brand_revenue_usd: 50_000_000,
    recoverable_revenue_usd: 2_000_000,
    prescreen_stub: null,
    gate_a_stub: publicParent(
      "Sally Beauty Holdings",
      "SBH",
      "NYSE",
      3_700_000_000,
      26000,
      "Beauty Secrets",
    ),
    gate_c_passed: false,
    expected_verdict: "hard_disqualify",
    expected_failure_gate: "gate_a",
    expected_pattern: "subsidiary_of_public",
  },
  {
    brand: "Bombas",
    description:
      "Socks/apparel brand with documented anti-Amazon stance — pulled off Amazon in 2018.",
    top_sellers: ["Bombas Direct"],
    brand_revenue_usd: 100_000_000,
    recoverable_revenue_usd: 5_000_000,
    prescreen_stub: {
      pattern: "anti_amazon",
      verdict: "hard_disqualify",
      reason:
        "Bombas has a documented anti-Amazon stance and intentionally avoids the platform.",
      evidence: [
        {
          source: "press_release",
          url: "https://bombas.com/press",
          excerpt: "We chose to leave Amazon to control our brand experience.",
        },
      ],
    },
    gate_a_stub: passing("Bombas", "private_independent", 100_000_000, 200),
    gate_c_passed: false,
    expected_verdict: "hard_disqualify",
    expected_failure_gate: "pattern_prescreen",
    expected_pattern: "anti_amazon",
  },
  {
    brand: "Can-Am by BRP",
    description: "Powersports OEM operating with mandatory authorized dealer network.",
    top_sellers: ["Can-Am Dealer Network", "Sea-Doo Authorized"],
    brand_revenue_usd: 500_000_000,
    recoverable_revenue_usd: 20_000_000,
    prescreen_stub: {
      pattern: "dealer_network",
      verdict: "hard_disqualify",
      reason:
        "Powersports OEM with mandatory authorized dealer network — third-party Amazon resellers are by design.",
      evidence: [
        {
          source: "trade_pub",
          url: "https://www.powersportsbusiness.com/can-am",
          excerpt: "Can-Am sells exclusively through authorized dealers.",
        },
      ],
    },
    gate_a_stub: publicParent(
      "BRP Inc.",
      "DOO",
      "TSX",
      8_600_000_000,
      14500,
      "Can-Am by BRP",
    ),
    gate_c_passed: false,
    expected_verdict: "hard_disqualify",
    expected_failure_gate: "pattern_prescreen",
    expected_pattern_one_of: ["subsidiary_of_public", "dealer_network"],
  },
  {
    brand: "Realspace",
    description:
      "Office furniture private-label brand owned by ODP Corporation (NASDAQ: ODP).",
    top_sellers: ["Office Depot", "OfficeMax", "ODP Business Solutions"],
    brand_revenue_usd: 1_200_000,
    recoverable_revenue_usd: 100_000,
    prescreen_stub: null,
    gate_a_stub: publicParent(
      "ODP Corporation",
      "ODP",
      "NASDAQ",
      7_700_000_000,
      25000,
      "Realspace",
    ),
    gate_c_passed: false,
    expected_verdict: "hard_disqualify",
    expected_failure_gate: "gate_a",
    expected_pattern: "subsidiary_of_public",
  },
];
