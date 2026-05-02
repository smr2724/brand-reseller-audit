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
import {
  DEFAULT_ASSUMPTIONS,
  type NarrativeCompetitorBenchmark,
  type NarrativeCxAudit,
  type NarrativeMath,
  type NarrativeResellerDossier,
  type NarrativeResellerReality,
  type NarrativeV2,
  type ReportAssumptions,
} from "./types";

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

  // 3. LLM section calls — fanned out in parallel where possible.
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
    llmCoverHeadline({
      brandName: brand.name,
      topReseller: bundle.keepa.top_seller ?? null,
      topResellerSharePct: bundle.keepa.top_seller_share_pct ?? null,
      annualLeak,
      exitLift,
      brandedSearchVolume: bundle.dataforseo?.branded_search_volume ?? null,
    }),
    llmResellerRealityLine(reality, bundle),
    dossierBase.dossier
      ? llmDossierRisk(dossierBase.dossier, brand)
      : Promise.resolve(""),
    llmCxBroken(cxBase, brand),
    llmCompetitorLine(benchmarkBase, brand),
    llmMathNotes(math),
    llmPlan({
      brandName: brand.name,
      topReseller: bundle.keepa.top_seller ?? null,
      uniqueSellerCount: bundle.keepa.unique_seller_count,
      brandedSearchVolume: bundle.dataforseo?.branded_search_volume ?? null,
    }),
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

  // 5. Top-level NarrativeV2.
  const narrative: NarrativeV2 = {
    version: 2,
    generated_at: generatedAt.toISOString(),
    brand_id: brand.id,
    brand_name: brand.name,

    cover: {
      headline: coverHeadline,
      kpis: buildCoverKpis(annualLeak, exitLift),
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

    cta: {
      headline: `Book a strategy call for ${brand.name}.`,
      primary_cta_url: calendlyUrl,
      primary_cta_label: "Book a strategy call",
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

function countNonNull(xs: (number | null | undefined)[]): number {
  return xs.filter((x) => x != null).length;
}
