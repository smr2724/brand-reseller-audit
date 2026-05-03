/**
 * Phase 8 — Assemble the v2 narrative_json from a brand row +
 * enrichment + LLM section calls.
 *
 * Pure orchestration: validates inputs, runs computes, fans out to the
 * narrative.ts per-section LLM functions in parallel, packs the
 * resulting NarrativeV2 plus auxiliary jsonb (assumptions, dossier,
 * benchmark, cx_audit) for the generator to persist.
 */
import type { BrandEnrichmentBundle } from "@/lib/enrichment";
import type { BrandForReport } from "@/lib/report/narrative";
import {
  computeCompetitorBenchmark,
  computeCxAuditBase,
  computeDossierBase,
  computeMath,
  computeResellerReality,
} from "./compute";
import type { CompetitorSnapshot, KeepaAsinDetail } from "./enrich";
import type { RevenueEstimate } from "@/lib/enrichment/revenue-estimator";
import type { SpApiTrailingResult } from "@/lib/enrichment/sp-api-override";
import {
  llmCompetitorLine,
  llmCoverHeadline,
  llmCxBroken,
  llmDossierRisk,
  llmFiveStepPlan,
  llmMathNotes,
  llmPlan,
  llmResellerRealityLine,
} from "./narrative";
import { withTiming } from "@/lib/util/timing";
import {
  DEFAULT_ASSUMPTIONS,
  type DiyStep,
  type NarrativeCompetitorBenchmark,
  type NarrativeCxAudit,
  type NarrativeMath,
  type NarrativeResellerDossier,
  type NarrativeResellerReality,
  type NarrativeV2,
  type ReportAssumptions,
  type ReportMode,
} from "./types";

/**
 * Phase 24 — Recoverable-revenue floor for the high_fit pitch. Below this
 * we render `diy_fit` mode (friendly self-serve advice) instead of the
 * full RCG capture plan, because the residual reseller margin isn't
 * enough to justify RCG's fees. Configurable via env so Steve can tune
 * without a deploy.
 */
function diyFitMinRecoverableRevenue(): number {
  const raw = process.env.RCG_FIT_MIN_RECOVERABLE_REVENUE;
  if (!raw) return 500_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 500_000;
}

/**
 * Phase 24 — Decide whether the brand is a DIY-fit (running a tight
 * channel already; residual recoverable margin too small to justify RCG
 * fees). Returns the chosen mode + the inputs that drove the decision so
 * the caller can persist them on narrative_json for auditability.
 */
function decideReportMode(args: {
  trailing12: number | null;
  brandControlledPct: number | null;
}): {
  mode: ReportMode;
  recoverable_revenue_dollars: number | null;
  brand_controlled_pct: number | null;
} {
  const { trailing12, brandControlledPct } = args;
  let recoverable: number | null = null;
  if (trailing12 != null && brandControlledPct != null) {
    const pct = Math.max(0, Math.min(1, brandControlledPct));
    recoverable = Math.max(0, trailing12 * (1 - pct));
  }
  const tightChannel =
    brandControlledPct != null && brandControlledPct >= 0.5;
  const lowRecoverable =
    recoverable != null && recoverable < diyFitMinRecoverableRevenue();
  const mode: ReportMode = tightChannel && lowRecoverable ? "diy_fit" : "high_fit";
  return {
    mode,
    recoverable_revenue_dollars: recoverable,
    brand_controlled_pct: brandControlledPct,
  };
}

export interface AssembleInput {
  brand: BrandForReport;
  bundle: BrandEnrichmentBundle;
  competitors: CompetitorSnapshot[];
  contactEmail: string;
  calendlyUrl: string | null;
  generatedAt: Date;
  assumptions?: ReportAssumptions;
  asinDetails?: KeepaAsinDetail[];
  revenueEstimate?: RevenueEstimate | null;
  /** Real SP-API trailing-12mo pull (override path). When non-null,
   * supersedes both `revenueEstimate` and any imported revenue. */
  spApiTrailing?: SpApiTrailingResult | null;
  productCategoryHints?: string[];
}

export interface AssembleOutput {
  narrative: NarrativeV2;
  assumptions: ReportAssumptions;
  resellerDossierJson: NarrativeResellerDossier | null;
  competitorBenchmarkJson: NarrativeCompetitorBenchmark;
  cxAuditJson: NarrativeCxAudit;
}

export async function assembleV2(input: AssembleInput): Promise<AssembleOutput> {
  const { brand, bundle, competitors, contactEmail, calendlyUrl, generatedAt } = input;
  const assumptions: ReportAssumptions = { ...DEFAULT_ASSUMPTIONS, ...(input.assumptions ?? {}) };
  const asinDetails = input.asinDetails ?? [];
  const revenueEstimate = input.revenueEstimate ?? null;
  const spApiTrailing = input.spApiTrailing ?? null;

  // 1. Pure compute (no I/O).
  const reality = computeResellerReality(bundle);
  const dossierBase = computeDossierBase(bundle);
  const cxBase = computeCxAuditBase(bundle, asinDetails, revenueEstimate);
  const benchmarkBase = computeCompetitorBenchmark(brand, bundle, competitors, cxBase);

  // 2. Math — uses assumptions + brand row + Keepa freshness.
  // Revenue precedence:
  //   1. SP-API trailing-12mo pull (real seller data, override path)
  //   2. brand.trailing_12_months    (from upload / deal terms)
  //   3. brand.est_monthly_revenue × 12 (legacy import field)
  //   4. revenueEstimate.total_ttm_revenue (Keepa BSR + price)
  // This way real numbers always win over the estimator. The estimator
  // also supplies the source string + footnote when it is the basis.
  const importedTrailing12 =
    brand.trailing_12_months ??
    (brand.est_monthly_revenue != null ? Number(brand.est_monthly_revenue) * 12 : null);

  // revenue_kind drives the badge (Actual vs Estimate) and the footnote.
  // "spapi" → green Actual badge, no estimator footnote
  // "imported" → green Actual badge, no estimator footnote
  // "estimate" → amber Estimate badge + diligence-replacement footnote
  // "missing" → no badge, "— not measured"
  type RevenueKind = "spapi" | "imported" | "estimate" | "missing";
  let trailing12: number | null = null;
  let revenueKind: RevenueKind = "missing";
  let revenueSource = "Keepa";

  if (spApiTrailing && spApiTrailing.trailing_12mo_revenue > 0) {
    trailing12 = spApiTrailing.trailing_12mo_revenue;
    revenueKind = "spapi";
    revenueSource = spApiTrailing.source_note;
  } else if (importedTrailing12 != null) {
    trailing12 = importedTrailing12;
    revenueKind = "imported";
    revenueSource = "Imported / deal terms";
  } else if (revenueEstimate?.total_ttm_revenue != null) {
    trailing12 = revenueEstimate.total_ttm_revenue;
    revenueKind = "estimate";
    revenueSource = revenueEstimate.source_note ?? "Keepa BSR + price · 365-day avg";
  } else {
    revenueSource = bundle.keepa.last_enriched_at
      ? `Keepa, ${bundle.keepa.last_enriched_at.slice(0, 10)}`
      : "Keepa";
  }

  const usingEstimate = revenueKind === "estimate";

  const revenueBadge: "actual" | "estimate" | null =
    revenueKind === "spapi" || revenueKind === "imported"
      ? "actual"
      : revenueKind === "estimate"
      ? "estimate"
      : null;

  const math: NarrativeMath = computeMath({
    trailing_12mo_revenue: trailing12,
    brand_controlled_pct: bundle.keepa.brand_controlled_pct,
    current_profit: brand.current_profit,
    keepaDate: bundle.keepa.last_enriched_at,
    assumptions,
    revenueSource,
    revenueFootnote:
      usingEstimate
        ? revenueEstimate?.methodology_footnote ??
          "Directional estimate from Keepa BSR + buy-box price. Replace with seller's actual TTM during diligence."
        : null,
    revenueBadge,
  });

  // Headline economics for the cover — Δ profit and 7× exit lift.
  const deltaLine = math.lines.find((l) => l.key === "delta_profit");
  const exitLine = math.lines.find((l) => l.key === "exit_lift");
  const annualLeak = deltaLine?.value ?? null;
  const exitLift = exitLine?.value ?? null;

  // Phase 24 — pick high_fit vs diy_fit. We base the decision on the
  // brand-controlled share (already in the bundle) and trailing-12 mo
  // revenue (the same number that drives the math). When we land in
  // diy_fit we still compute math/plan above (cheap), but the renderer
  // suppresses the math + capture-plan + WHY-RCG sections in favor of a
  // friendly 3-step self-serve list. The cover headline + hero numbers
  // are also reframed.
  const fitDecision = decideReportMode({
    trailing12,
    brandControlledPct: bundle.keepa.brand_controlled_pct ?? null,
  });

  // 3. LLM section calls — fanned out in parallel where possible.
  // Phase 22 — wrap each in withTiming so we get one log line per
  // section per scan, and they all run concurrently inside Promise.all.
  const [
    coverHeadline,
    realityLine,
    dossierRisk,
    cxBroken,
    competitorLine,
    mathNotes,
    plan,
    fiveStep,
  ] = await Promise.all([
    withTiming("llm/coverHeadline", () =>
      llmCoverHeadline({
        brandName: brand.name,
        topReseller: bundle.keepa.top_seller ?? null,
        topResellerSharePct: bundle.keepa.top_seller_share_pct ?? null,
        annualLeak,
        exitLift,
        brandedSearchVolume: bundle.dataforseo?.branded_search_volume ?? null,
      }),
    ),
    withTiming("llm/resellerRealityLine", () =>
      llmResellerRealityLine(reality, bundle),
    ),
    dossierBase.dossier
      ? withTiming("llm/dossierRisk", () =>
          llmDossierRisk(dossierBase.dossier!, brand),
        )
      : Promise.resolve(""),
    withTiming("llm/cxBroken", () => llmCxBroken(cxBase, brand)),
    withTiming("llm/competitorLine", () =>
      llmCompetitorLine(benchmarkBase, brand),
    ),
    withTiming("llm/mathNotes", () => llmMathNotes(math)),
    withTiming("llm/plan", () =>
      llmPlan({
        brandName: brand.name,
        topReseller: bundle.keepa.top_seller ?? null,
        uniqueSellerCount: bundle.keepa.unique_seller_count,
        brandedSearchVolume: bundle.dataforseo?.branded_search_volume ?? null,
      }),
    ),
    withTiming("llm/fiveStepPlan", () =>
      llmFiveStepPlan({
        brandName: brand.name,
        topReseller: bundle.keepa.top_seller ?? null,
        topResellerSharePct: bundle.keepa.top_seller_share_pct ?? null,
        uniqueSellerCount: bundle.keepa.unique_seller_count,
        brandControlledPct: bundle.keepa.brand_controlled_pct,
        annualLeak,
        exitLift,
        revenue: trailing12,
      }),
    ),
  ]);

  // 4. Compose final structures.
  const finalReality: NarrativeResellerReality = {
    ...reality,
    one_liner: realityLine,
    note: reality.top_sellers.length === 0 ? "Keepa returned no sellers for this brand." : null,
  };

  let finalDossier: NarrativeResellerDossier | null = null;
  if (dossierBase.dossier) {
    finalDossier = { ...dossierBase.dossier, risk_profile: dossierRisk || "" };
  }

  const finalCx: NarrativeCxAudit = { ...cxBase, whats_broken: cxBroken };

  const finalBenchmark: NarrativeCompetitorBenchmark = {
    ...benchmarkBase,
    one_liner: competitorLine,
  };

  // Append the revenue-estimator footnote when revenue came from the
  // Keepa BSR estimator rather than imported deal terms.
  const finalNotes = usingEstimate && revenueEstimate?.methodology_footnote
    ? `${mathNotes}\n\nRevenue note: ${revenueEstimate.methodology_footnote}`.trim()
    : mathNotes;
  const finalMath: NarrativeMath = { ...math, notes: finalNotes };

  // Phase 24 — DIY-mode reframes the cover: the headline becomes a
  // congratulatory "you're already running a tight channel" line and the
  // hero numbers collapse into a single percent. We still keep the
  // delta_profit / exit_lift values on the narrative for legacy/PDF
  // consumers, but the renderer suppresses them in DIY mode.
  const isDiy = fitDecision.mode === "diy_fit";
  const diyHeadline = isDiy
    ? renderDiyCoverHeadline(brand.name, fitDecision.brand_controlled_pct)
    : null;
  const diySteps = isDiy ? buildDiySteps(brand.name) : null;

  // 5. Top-level NarrativeV2.
  const narrative: NarrativeV2 = {
    version: 2,
    generated_at: generatedAt.toISOString(),
    brand_id: brand.id,
    brand_name: brand.name,

    report_mode: fitDecision.mode,
    recoverable_revenue_dollars: fitDecision.recoverable_revenue_dollars,
    brand_controlled_pct: fitDecision.brand_controlled_pct,

    cover: {
      headline: diyHeadline ?? coverHeadline,
      kpis: isDiy
        ? buildDiyCoverKpis(fitDecision.brand_controlled_pct)
        : buildCoverKpis(annualLeak, exitLift),
      delta_profit: annualLeak,
      exit_lift: exitLift,
    },

    reseller_reality: finalReality,
    reseller_dossier: finalDossier,
    cx_audit: finalCx,
    competitor_benchmark: finalBenchmark,
    math: finalMath,

    plan: {
      intro: plan.intro,
      columns: plan.columns.slice(0, 3),
      steps: fiveStep.steps,
      closing: fiveStep.closing,
    },

    why_rcg: buildWhyRcg(),

    diy_steps: diySteps ?? undefined,

    cta: {
      // DIY mode keeps a soft CTA at the bottom only — no big sales push.
      headline: isDiy
        ? `When you're ready to scale, ${brand.name}, we're a click away.`
        : `Book a strategy call for ${brand.name}.`,
      primary_cta_url: calendlyUrl,
      primary_cta_label: isDiy ? "Book a free strategy call" : "Book a strategy call",
      secondary_email: contactEmail,
      secondary_phone: null,
    },

    data_sources: {
      keepa:
        (bundle.keepa.asin_count ?? 0) > 0 || (bundle.keepa.sellers?.length ?? 0) > 0,
      keepa_freshness: bundle.keepa.last_enriched_at,
      dataforseo:
        (bundle.dataforseo?.top_keywords?.length ?? 0) > 0 ||
        (bundle.dataforseo?.competitor_brands?.length ?? 0) > 0,
      dataforseo_freshness: bundle.dataforseo?.captured_at ?? null,
      reseller_dossier: finalDossier !== null,
      // Only call the benchmark "real" if at least one competitor row
      // has ≥ 2 measured fields. A single competitor with all-null
      // numbers shouldn't flip this to true — the reader treats true
      // as "we measured peers", and that's a strong claim.
      competitor_benchmark: benchmarkBase.rows
        .filter((r) => !r.is_audited_brand)
        .some(
          (r) =>
            countNonNull([
              r.unique_seller_count,
              r.brand_controlled_pct,
              r.branded_search_volume,
              r.organic_serp_rank,
              r.listing_health,
            ]) >= 2,
        ),
    },
  };

  return {
    narrative,
    assumptions,
    resellerDossierJson: finalDossier,
    competitorBenchmarkJson: finalBenchmark,
    cxAuditJson: finalCx,
  };
}

function buildCoverKpis(
  annualLeak: number | null,
  exitLift: number | null,
): { label: string; value: string; sub: string | null }[] {
  // v2.1 — opportunity-first cover. Two big stats, both economic, both
  // computed from the math table. Keeps the cover tight and on-message
  // (capture, not growth). The 7× footnote is rendered alongside.
  const kpis: { label: string; value: string; sub: string | null }[] = [];
  if (annualLeak != null) {
    kpis.push({
      label: "Annual profit recovered",
      value: money(annualLeak),
      sub: "Keepa + math model · see Section 5",
    });
  }
  if (exitLift != null) {
    kpis.push({
      label: "Business value created",
      value: money(exitLift),
      sub: "7× EBITDA on the new annual profit",
    });
  }
  return kpis;
}

function buildWhyRcg(): NarrativeV2["why_rcg"] {
  return {
    bio:
      "Steve Rolle ran Diversified Hospitality on Amazon as the operator before he ran it as a consultant. He took the brand from a reseller-saturated catalog to a $10M/year brand-controlled channel, then doubled enterprise value at exit. RCG now runs the same playbook for other manufacturers.",
    case_studies: [
      {
        name: "Diversified Hospitality",
        summary:
          "Reclaimed the catalog from a long tail of unauthorized resellers and rebuilt brand-controlled distribution.",
        metric: "$10M/year brand-controlled · 2× enterprise value at exit",
      },
      {
        name: "Legion Chemicals",
        summary:
          "Stood up direct Amazon operations from a wholesale-only baseline and consolidated MAP enforcement under the brand.",
        metric: "Reseller count down · brand-controlled buy box up",
      },
    ],
    risk_reversal:
      "We work performance-based on the additional first-year profit we generate. No upfront retainer, no long contracts — if we don't add profit, we don't get paid.",
  };
}

function money(n: number | null): string {
  if (n == null) return "— not measured";
  return `$${Math.round(Number(n)).toLocaleString("en-US")}`;
}

// --------------------------------------------------------------------
// Phase 24 — DIY-mode copy helpers
// --------------------------------------------------------------------

function pctText(pct: number | null): string {
  if (pct == null) return "most";
  return `${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%`;
}

function leakageText(pct: number | null): string {
  if (pct == null) return "the residual";
  const leak = 1 - Math.max(0, Math.min(1, pct));
  return `${Math.round(leak * 100)}%`;
}

function renderDiyCoverHeadline(
  brandName: string,
  brandControlledPct: number | null,
): string {
  return `${brandName}, you're already running a tight Amazon channel — here's how to seal the last ${leakageText(brandControlledPct)} of reseller leakage yourself.`;
}

function buildDiyCoverKpis(
  brandControlledPct: number | null,
): { label: string; value: string; sub: string | null }[] {
  const pct = pctText(brandControlledPct);
  return [
    {
      label: "Brand-controlled share of your Amazon channel",
      value: pct,
      sub: "Buy-box ownership across your top SKUs · Keepa",
    },
  ];
}

function buildDiySteps(brandName: string): DiyStep[] {
  return [
    {
      number: 1,
      title: "Send a polite request to the reseller asking them to stop selling.",
      body:
        `Most small unauthorized resellers — especially LLCs that look like ${brandName}'s own family or DBA — will comply when contacted directly. ` +
        `A short note works: "Hi, we've noticed you're listing our products on Amazon. We don't have a wholesale agreement on file — could you confirm your source so we can make sure our distribution is clean?" ` +
        `Give them 14 days.`,
    },
    {
      number: 2,
      title: "If they don't comply, file an Amazon Brand Registry complaint.",
      body:
        "Brand Registry gives you takedown power for unauthorized listings and counterfeit claims. " +
        "It's the lever that converts a polite ask into an enforced outcome. " +
        "Most resellers de-list within a week of the first complaint hitting their account.",
    },
    {
      number: 3,
      title: "Tighten distribution with your existing wholesale customers.",
      body:
        "Add a Minimum Advertised Price (MAP) policy and no-resale clauses for new accounts. " +
        "For existing accounts, send a one-page distribution policy update (MAP, no Amazon resale, no transshipping) and ask for written acknowledgment. " +
        "This is what stops the next reseller showing up six months from now.",
    },
  ];
}

function countNonNull(xs: (number | null | undefined)[]): number {
  return xs.filter((x) => x != null).length;
}
