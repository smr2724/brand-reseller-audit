/**
 * Phase 8 / v2.1 — Public web renderer for v2 audit reports.
 *
 * v2.1 reframe: opportunity-first, not feature-rich. Cover leads with
 * the recapture-without-growth thesis. CX section is now Top Products
 * & Listing Health (top 10 ASINs with revenue/units estimates).
 * Competitor benchmark is hidden from the rendered output (data stays
 * in the DB). The 90-day plan becomes the 5-step Capture framework
 * (6-12 months, no advertising/DTC/growth language). RCG credibility
 * is sprinkled across the report as small inline callouts instead of
 * stacked in a standalone "Why RCG" section.
 *
 * v1 reports still render via the old PublicReportView.
 */
/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import type { BrandEnrichmentBundle } from "@/lib/enrichment";
import type {
  CxAuditAsinScore,
  DiyStep,
  NarrativeV2,
  PlanStep,
  ReportAssumptions,
  ResellerRow,
} from "./types";
import { DEFAULT_ASSUMPTIONS } from "./types";
import { LegionMathSection } from "./LegionMathSection";
import {
  CASE_STUDY_ANCHOR_ID,
  DIVERSIFIED_CASE_STUDY_HREF,
  DIVERSIFIED_HOSPITALITY_CASE_STUDY,
} from "./case-studies";
import { computeBenchmarkEconomics } from "@/lib/math/legion-economics";
import {
  confidenceForBusinessValue,
  confidenceForProfitRecapture,
  confidenceForRevenue,
  confidenceForSellerControl,
  deriveSnapshot,
  lookupClassification,
  type ConfidenceLabel,
  type DerivedSnapshot,
  type SellerClassificationSnapshotEntry,
} from "./snapshot-derive";
import { findResellerByName, pickHook } from "./hooks";

export interface PublicReportV2Brand {
  id: string;
  name: string;
  category: string | null;
  est_monthly_revenue: number | null;
}

export interface PublicReportV2Props {
  narrative: NarrativeV2;
  brand: PublicReportV2Brand;
  bundle: BrandEnrichmentBundle | null;
  pdfUrl: string | null;
  /** URL token used to namespace localStorage state for the editable
   * math input panel. */
  reportToken: string;
  /** Persisted ReportAssumptions for this report; falls back to
   * `DEFAULT_ASSUMPTIONS` when missing/legacy. */
  assumptions: ReportAssumptions | null;
  /** Phase 40 — persisted classification snapshot from
   * `reports.seller_classifications`. Null on legacy reports → renderer
   * falls back to `bundle.keepa.brand_controlled_pct`. */
  classificationSnapshot?: SellerClassificationSnapshotEntry[] | null;
  /** Phase 40 — four `*_share_pct` columns persisted on the report row.
   * All null on legacy rows → falls back to legacy heuristic. */
  shareCols?: {
    brand_owned: number | null;
    authorized: number | null;
    amazon: number | null;
    reseller: number | null;
  } | null;
}

const STRATEGY_CALL_MAILTO_SUBJECT = "Amazon%20opportunity%20call";
const STEVE_EMAIL = "steve@rollemanagementgroup.com";

/**
 * Phase 41a — three rendering modes:
 *   - "tight"        : new short / tight-channel benchmark layout.
 *                      Triggered when the persisted classification
 *                      snapshot meets the TIGHT_CHANNEL_THRESHOLDS.
 *   - "legacy-diy"   : older diy_fit reports without a classification
 *                      snapshot. Kept for backward compatibility with
 *                      reports generated before Phase 41a.
 *   - "opportunity"  : the full executive long layout (Phase 40).
 */
type ReportLayoutMode = "tight" | "legacy-diy" | "opportunity";

function strategyCallHref(narrative: NarrativeV2, brandName: string): string {
  const calendly = narrative.cta?.primary_cta_url;
  if (calendly) return calendly;
  const subj = `${STRATEGY_CALL_MAILTO_SUBJECT}%20-%20${encodeURIComponent(brandName)}`;
  return `mailto:${STEVE_EMAIL}?subject=${subj}`;
}

export function PublicReportV2({
  narrative,
  brand,
  bundle,
  pdfUrl,
  reportToken,
  assumptions,
  classificationSnapshot,
  shareCols,
}: PublicReportV2Props) {
  const callHref = strategyCallHref(narrative, brand.name);

  // Phase 40 — Derive the classification-aware snapshot view.
  // Falls back to bundle.keepa.brand_controlled_pct when neither the
  // snapshot nor share_pct cols are populated (legacy reports).
  const derived: DerivedSnapshot = deriveSnapshot({
    share_pcts: shareCols ?? {
      brand_owned: null,
      authorized: null,
      amazon: null,
      reseller: null,
    },
    snapshot: classificationSnapshot ?? null,
    legacyBrandControlledPct:
      bundle?.keepa?.brand_controlled_pct ??
      narrative.brand_controlled_pct ??
      null,
  });

  // Phase 56 — segment-driven routing (Edge F: deterministic segment
  // wins over snapshot math). When the qualification row carries a
  // segment, use it directly:
  //   - reseller_controlled        → opportunity (full)
  //   - mixed_control              → opportunity (full)
  //   - brand_managed_with_leakage → opportunity_softlead (softer lead)
  //   - authorized_network_healthy → tight (Phase 41a layout)
  // Disqualified segments (5-10) are suppressed upstream in /r/[token];
  // if one slips through we fall back to opportunity to avoid a blank
  // page. Legacy reports without a segment fall through to the prior
  // snapshot-math rules so they render unchanged.
  const segment = narrative.qualification?.segment ?? null;
  const segmentSays = (() => {
    switch (segment) {
      case "authorized_network_healthy":
        return "tight" as const;
      case "brand_managed_with_leakage":
        return "opportunity_softlead" as const;
      case "reseller_controlled":
      case "mixed_control":
        return "opportunity" as const;
      default:
        return null;
    }
  })();

  // Phase 41a — short / tight-channel layout. Triggered by either the
  // segment classification or (legacy fallback) the snapshot math.
  const isTightShort =
    segmentSays === "tight" ||
    (segmentSays == null && derived.is_tight_channel);

  // Phase 56 — softer-lead opportunity variant for Segment 4.
  const isSoftLead = segmentSays === "opportunity_softlead";

  // Phase 24 — legacy diy_fit mode. Older reports without a
  // classification snapshot may still be tagged `diy_fit` by
  // `decideReportMode`; we keep the legacy DIY rendering path for them
  // so existing public URLs render unchanged. Segment-driven routing
  // takes precedence when present.
  const isLegacyDiy =
    segmentSays == null && !isTightShort && narrative.report_mode === "diy_fit";

  // Pull the seed values for the editable math input panel out of
  // narrative_json + the persisted ReportAssumptions row. Anything
  // missing falls back to DEFAULT_ASSUMPTIONS.
  const revenueLine = narrative.math.lines.find((l) => l.key === "revenue");
  const initialRevenue: number | null =
    typeof revenueLine?.value === "number" ? revenueLine.value : null;
  const revenueSource = revenueLine?.source ?? "Keepa";
  const revenueBadge = revenueLine?.badge ?? null;
  const revenueConfirmedSource = revenueLine?.confirmed_source ?? null;
  const revenueEstimatorSuggestion =
    typeof revenueLine?.estimator_suggestion === "number"
      ? revenueLine.estimator_suggestion
      : null;
  const a: ReportAssumptions = { ...DEFAULT_ASSUMPTIONS, ...(assumptions ?? {}) };
  const initialAssumptions = {
    reseller_markup_pct: a.reseller_markup_pct,
    outbound_shipping_pct: a.outbound_shipping_pct,
    outbound_shipping_payer: a.outbound_shipping_payer,
    reseller_net_margin_pct: a.reseller_net_margin_pct,
    current_profit_margin_pct: a.current_profit_margin_pct,
    ebitda_multiple: a.ebitda_multiple,
    labor_cost_override: a.labor_cost_override ?? null,
  };

  // Confidence labels per spec section 13.
  const confRevenue = confidenceForRevenue(revenueBadge);
  const confSellerControl = confidenceForSellerControl(derived);
  const confProfit = confidenceForProfitRecapture(derived, revenueBadge);
  const confValue = confidenceForBusinessValue();

  // Phase 41a — benchmark profit / business value for the short layout.
  // Uses the same fixed margin (0.20) and EBITDA multiple (7) as the
  // long layout's recapture math, but applied to total revenue rather
  // than the recoverable slice — there is no recapture story for a
  // tight-channel brand, but the benchmark is still useful.
  const revenueValue =
    typeof revenueLine?.value === "number" ? revenueLine.value : null;
  const benchmark =
    isTightShort && revenueValue != null
      ? computeBenchmarkEconomics({
          revenue: revenueValue,
          current_profit_margin_pct: a.current_profit_margin_pct,
          ebitda_multiple: a.ebitda_multiple,
        })
      : null;

  return (
    <div className="rv2">
      <V2Styles />
      <Header
        brand={brand}
        pdfUrl={pdfUrl}
        narrative={narrative}
        mode={isTightShort ? "tight" : isLegacyDiy ? "legacy-diy" : "opportunity"}
      />
      <SideNav mode={isTightShort ? "tight" : isLegacyDiy ? "legacy-diy" : "opportunity"} />

      <main className="rv2-main">
        {isTightShort ? (
          <>
            {/* 1. Hero — revenue-led, benchmark framing */}
            <SectionTightHero
              narrative={narrative}
              brand={brand}
              revenue={revenueValue}
              benchmark={benchmark}
              derived={derived}
              ebitdaMultiple={a.ebitda_multiple}
              currentMarginPct={a.current_profit_margin_pct}
              confRevenue={confRevenue}
              confSellerControl={confSellerControl}
            />
            {/* 2. Three-card snapshot row (revenue · profit · business value) */}
            <SectionTightBenchmarkCards
              revenue={revenueValue}
              benchmark={benchmark}
              ebitdaMultiple={a.ebitda_multiple}
              currentMarginPct={a.current_profit_margin_pct}
              confRevenue={confRevenue}
            />
            {/* 3. Buy-box ownership 4-bucket bar */}
            <SectionTightBuyBox
              derived={derived}
              bundle={bundle}
              confSellerControl={confSellerControl}
            />
            {/* 4. Brand-controlled positive sub-heading */}
            <SectionTightBrandControlled
              narrative={narrative}
              derived={derived}
            />
            {/* 5. Top products (capped at 5 in short mode) */}
            <SectionTopProducts narrative={narrative} maxCards={5} />
            {/* 6. Residual reseller activity (small table) */}
            <SectionTightResidualResellers
              narrative={narrative}
              derived={derived}
            />
            {/* Phase 56 — Segment 2 callout: even authorized resellers cap growth */}
            {segment === "authorized_network_healthy" && (
              <SectionAuthorizedResellersCap />
            )}
            {/* 7. Three concrete steps to seal the leak yourself */}
            <SectionDiySteps narrative={narrative} brand={brand} />
            {/* 8. Soft CTA */}
            <SectionDiyFooterCta
              narrative={narrative}
              brand={brand}
              pdfUrl={pdfUrl}
              callHref={callHref}
              derived={derived}
            />
            {/* 9. Methodology Appendix */}
            <SectionMethodology narrative={narrative} brand={brand} />
            {/* 10. Disclaimer */}
            <SectionDisclaimer />
          </>
        ) : isLegacyDiy ? (
          <>
            <SectionDiyCover narrative={narrative} brand={brand} />
            <SectionResellerReality narrative={narrative} bundle={bundle} derived={derived} />
            {/* Phase 58 — SectionResellerDossier removed; "Did You Authorize
                These Sellers?" / "Top ASINs They Win" copy is gone in all
                modes that previously rendered it. */}
            <SectionTopProducts narrative={narrative} />
            <SectionDiySteps narrative={narrative} brand={brand} />
            <SectionDiyFooterCta narrative={narrative} brand={brand} pdfUrl={pdfUrl} callHref={callHref} derived={derived} />
            <SectionMethodology narrative={narrative} brand={brand} />
            <SectionDisclaimer />
          </>
        ) : (
          <>
            {/* Phase 58 — Section ordering:
                Cover → Exec Summary → Reseller Reality → Financial
                Opportunity → Five-Step Framework → Phase 2 → Diversified
                case study → Why Steve / RCG → CTA → Methodology. The
                Channel Control, Top Products (Evidence Snapshot), and
                Reseller Dossier ("Did You Authorize These Sellers?")
                sections were removed in Phase 58, and the Financial
                Opportunity static bridge body was deduped — only the
                expandable math card remains. */}
            {/* 1. Hero / Executive Punch */}
            <SectionCover
              narrative={narrative}
              brand={brand}
              derived={derived}
              confRevenue={confRevenue}
              confSellerControl={confSellerControl}
              confProfit={confProfit}
              confValue={confValue}
            />
            {/* Phase 56 — Segment 4 (brand_managed_with_leakage) soft lead */}
            {isSoftLead && <SectionSoftLead brand={brand} derived={derived} />}
            {/* 2. Executive Summary Box */}
            <SectionExecutiveSummary
              narrative={narrative}
              brand={brand}
              derived={derived}
            />
            {/* 3. Reseller Reality — the persuasion fulcrum. The new
                Phase 58 consolidation prose is reseller_controlled only.
                Other segments (mixed_control, legacy) keep the existing
                data-led Reseller Reality. */}
            {segment === "reseller_controlled" ? (
              <SectionResellerRealityConsolidation />
            ) : (
              <SectionResellerReality narrative={narrative} bundle={bundle} derived={derived} />
            )}
            {/* 4. Financial Opportunity — expandable math card only */}
            <LegionMathSection
              reportToken={reportToken}
              reportGeneratedAt={narrative.generated_at ?? null}
              initialRevenue={initialRevenue}
              initialAssumptions={initialAssumptions}
              revenueSource={revenueSource}
              revenueBadge={revenueBadge ?? null}
              revenueFootnote={extractRevenueFootnote(narrative.math.notes ?? "")}
              notes={cleanMathNotes(narrative.math.notes ?? "") || null}
              brandControlledPct={
                derived.shares.has_snapshot
                  ? derived.non_reseller_share
                  : narrative.brand_controlled_pct ?? null
              }
              revenueConfirmedSource={revenueConfirmedSource}
              revenueEstimatorSuggestion={revenueEstimatorSuggestion}
            />
            {/* 5. Five-Step Framework */}
            <SectionPlan narrative={narrative} derived={derived} />
            {/* 6. Phase 2 / fractional CAO */}
            <SectionPhaseTwo brand={brand} />
            {/* 7. Diversified Hospitality case study */}
            <SectionCaseStudyDiversifiedHospitality />
            {/* 8. Why Steve / RCG */}
            <SectionWhySteveRolle />
            {/* 9. CTA */}
            <SectionFooterCta narrative={narrative} brand={brand} pdfUrl={pdfUrl} callHref={callHref} />
            {/* 10. Methodology Appendix (now hosts variation handling) */}
            <SectionMethodology narrative={narrative} brand={brand} />
            {/* 11. Disclaimer */}
            <SectionDisclaimer />
          </>
        )}
      </main>

      <footer className="rv2-footer">
        © {new Date().getFullYear()} Rolle Consulting Group · Confidential audit prepared for {brand.name}
      </footer>
    </div>
  );
}

/** assemble.ts appends `\n\nRevenue note: …` when the figure is from the
 * estimator. Pull that out so the LegionMathSection can render it
 * separately under Tier 2. */
function extractRevenueFootnote(notes: string): string | null {
  const m = notes.match(/Revenue note:\s*([\s\S]*)$/);
  return m ? m[1].trim() : null;
}
function cleanMathNotes(notes: string): string {
  return notes.replace(/\n*Revenue note:[\s\S]*$/, "").trim();
}

// ====================================================================
// Header (sticky)
// ====================================================================

function Header({
  brand,
  pdfUrl,
  narrative,
  mode,
}: {
  brand: PublicReportV2Brand;
  pdfUrl: string | null;
  narrative: NarrativeV2;
  mode: ReportLayoutMode;
}) {
  // Tight / legacy DIY modes keep the same header chrome but reframe
  // the subtitle — "Channel Ownership Recommendations" lands warmer
  // than "Audit" when the report is congratulating the brand on already
  // running a tight channel.
  const useDiyChrome = mode === "tight" || mode === "legacy-diy";
  const subtitle = useDiyChrome
    ? `Channel Ownership Recommendations · ${formatShortDate(narrative.generated_at)}`
    : `Channel Ownership Audit · ${formatShortDate(narrative.generated_at)}`;
  return (
    <header className="rv2-hdr">
      <div className="rv2-hdr-row">
        <Link href="/" className="rv2-hdr-brand">
          <img src="/rmg-logo-white.png" alt="Rolle Consulting Group" className="rv2-hdr-logo" />
          <span className="rv2-hdr-wordmark">Rolle Consulting Group</span>
        </Link>
        <div className="rv2-hdr-mid">
          <div className="rv2-hdr-title">{brand.name}</div>
          <div className="rv2-hdr-sub">{subtitle}</div>
        </div>
        <div className="rv2-hdr-actions">
          {pdfUrl && (
            <a className="rv2-btn rv2-btn-primary" href={pdfUrl} target="_blank" rel="noreferrer">
              Download PDF
            </a>
          )}
        </div>
      </div>
    </header>
  );
}

// ====================================================================
// Side nav (anchors)
// ====================================================================

function SideNav({ mode }: { mode: ReportLayoutMode }) {
  const items: [string, string][] =
    mode === "tight"
      ? [
          ["s-cover", "The picture"],
          ["s-benchmark", "Benchmark snapshot"],
          ["s-buybox", "Buy-box ownership"],
          ["s-brand-controlled", "Sellers you control"],
          ["s-products", "Top products"],
          ["s-residual", "Residual seller activity"],
          ["s-diy", "3 steps to wrap this up"],
          ["s-cta", "Want help later?"],
          ["s-methodology", "Methodology"],
        ]
      : mode === "legacy-diy"
        ? [
            ["s-cover", "The good news"],
            ["s-methodology", "Audit scope"],
            ["s-reseller-reality", "Reseller reality"],
            ["s-products", "Top products"],
            ["s-diy", "3 steps to wrap this up"],
            ["s-cta", "Want help later?"],
          ]
        : [
            ["s-cover", "Executive punch"],
            ["s-summary", "Executive summary"],
            ["s-reseller-reality", "Reseller reality"],
            ["s-math", "Financial opportunity"],
            ["s-plan", "Five-step framework"],
            ["s-phase-two", "Phase 2 — what comes next"],
            [CASE_STUDY_ANCHOR_ID, "Case study"],
            ["s-why", "Why Steve / RCG"],
            ["s-cta", "Recommended next step"],
            ["s-methodology", "Methodology appendix"],
          ];
  return (
    <nav className="rv2-sidenav" aria-label="Sections">
      <ul>
        {items.map(([id, label]) => (
          <li key={id}>
            <a href={`#${id}`}>{label}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ====================================================================
// Section 1 — Cover (opportunity-first headline + 2 big stats)
// ====================================================================

function SectionCover({
  narrative,
  brand,
  derived,
  confRevenue,
  confSellerControl,
  confProfit,
  confValue,
}: {
  narrative: NarrativeV2;
  brand: PublicReportV2Brand;
  derived: DerivedSnapshot;
  confRevenue: ConfidenceLabel;
  confSellerControl: ConfidenceLabel;
  confProfit: ConfidenceLabel;
  confValue: ConfidenceLabel;
}) {
  const c = narrative.cover;
  const profit = c.delta_profit ?? null;
  const value = c.exit_lift ?? null;
  const revenueLine = narrative.math.lines.find((l) => l.key === "revenue");
  const revenue =
    typeof revenueLine?.value === "number" ? revenueLine.value : null;
  const ebitdaLine = narrative.math.lines.find((l) => l.key === "exit_lift");
  const ebitdaMultiple = ebitdaLine?.label?.match(/^(\d+(?:\.\d+)?)/)?.[1] ?? "7";

  const brandControlledPct = Math.round(derived.non_reseller_share * 100);
  const headline = renderHeroHeadline({
    brandName: brand.name,
    revenue,
    brandControlledPct,
  });

  return (
    <section id="s-cover" className="rv2-section rv2-section-cover">
      <div className="rv2-eyebrow">Amazon Channel Ownership Audit</div>
      <div className="rv2-cover-meta">
        <div className="rv2-cover-meta-line">Prepared for {brand.name}</div>
        <div className="rv2-cover-meta-line rv2-muted">
          {formatLongDate(narrative.generated_at)} · By Rolle Consulting Group
        </div>
      </div>
      <h1 className="rv2-h1">{headline}</h1>

      <div className="rv2-kpi-grid rv2-kpi-grid-3">
        <BigStat
          label="Estimated annual Amazon revenue"
          value={revenue != null ? money(revenue) : "— not measured"}
          sub="Based on available marketplace data"
          confidence={confRevenue}
        />
        <BigStat
          label="Estimated annual profit recapture"
          value={profit != null ? money(profit) : "— not measured"}
          sub="Directional estimate · transparent bridge below"
          confidence={confProfit}
        />
        <BigStat
          label={`Estimated business value lift (${ebitdaMultiple}× EBITDA)`}
          value={value != null ? money(value) : "— not measured"}
          sub="Assumption-based · pressure-tested on a call"
          confidence={confValue}
        />
      </div>

      <div className="rv2-cover-secondary">
        <div className="rv2-cover-secondary-stat">
          <span className="rv2-cover-secondary-lbl">Brand-controlled buy box</span>
          <span className="rv2-cover-secondary-val">
            {brandControlledPct}%
            <ConfidencePill level={confSellerControl} />
          </span>
        </div>
      </div>
    </section>
  );
}

function renderHeroHeadline(args: {
  brandName: string;
  revenue: number | null;
  brandControlledPct: number;
}): string {
  if (args.revenue != null) {
    return `${args.brandName} may already have a ${money(args.revenue)} Amazon channel — but based on our audit, ${args.brandControlledPct}% of the buy box appears to be brand-controlled.`;
  }
  return `${args.brandName} appears to have a meaningful Amazon channel — but based on our audit, ${args.brandControlledPct}% of the buy box appears to be brand-controlled.`;
}

function pickTopReseller(
  narrative: NarrativeV2,
  derived: DerivedSnapshot,
): string | null {
  const sellers = narrative.reseller_reality.top_sellers ?? [];
  for (const s of sellers) {
    const cls = lookupClassification(derived, s);
    if (cls === "reseller" || (cls == null && s.is_brand_controlled === false)) {
      return friendlySellerName(s.seller_name);
    }
  }
  return null;
}

function pickTopResellerShare(
  narrative: NarrativeV2,
  derived: DerivedSnapshot,
): number | null {
  const sellers = narrative.reseller_reality.top_sellers ?? [];
  for (const s of sellers) {
    const cls = lookupClassification(derived, s);
    if (cls === "reseller" || (cls == null && s.is_brand_controlled === false)) {
      return s.share_pct ?? null;
    }
  }
  return null;
}

function BigStat({
  label,
  value,
  sub,
  confidence,
}: {
  label: string;
  value: string;
  sub: string;
  confidence?: ConfidenceLabel;
}) {
  return (
    <div className="rv2-bigstat">
      <div className="rv2-bigstat-num">{value}</div>
      <div className="rv2-bigstat-lbl">{label}</div>
      <div className="rv2-bigstat-sub">{sub}</div>
      {confidence && (
        <div className="rv2-bigstat-conf">
          <ConfidencePill level={confidence} />
        </div>
      )}
    </div>
  );
}

function ConfidencePill({ level }: { level: ConfidenceLabel }) {
  const tone =
    level === "High"
      ? "high"
      : level === "Medium"
        ? "med"
        : level === "Low"
          ? "low"
          : "assumption";
  return (
    <span
      className={`rv2-conf rv2-conf-${tone}`}
      title="Confidence level — see methodology appendix for how these are assigned."
    >
      <span className="rv2-conf-dot" aria-hidden />
      <span className="rv2-conf-label">{level} confidence</span>
    </span>
  );
}

// ====================================================================
// Section 1.5 — Methodology & Audit Scope (Phase 35)
// ====================================================================
//
// Always rendered, right after the cover. Surfaces the universe of
// ASINs measured, the unit-estimation methodology, and the conservative
// "100+ bought" badge disclaimer BEFORE the stakeholder sees any
// dollar numbers. Web mirrors the PDF page byte-for-byte (same
// wording, same structure) so both surfaces tell the same story.
// ====================================================================

function SectionMethodology({
  narrative,
  brand,
}: {
  narrative: NarrativeV2;
  brand: PublicReportV2Brand;
}) {
  const scope = narrative.audit_scope ?? null;
  const keepaFresh = narrative.data_sources?.keepa_freshness ?? null;
  const dfsFresh = narrative.data_sources?.dataforseo_freshness ?? null;

  const auditWindow = `Trailing 12 months · ${formatLongDate(keepaFresh)}`;
  const asinsFound = scope?.asins_found_total ?? null;
  const asinsIncluded = scope?.asins_included_count ?? null;
  const withBadge = scope?.asins_with_keepa_monthly_sold ?? 0;

  const exclusions = scope?.exclusion_breakdown ?? {
    rank_too_high: 0,
    out_of_stock: 0,
    no_buy_box_history: 0,
    variation_inactive_sibling: 0,
  };

  const exclusionBullets: { key: string; node: React.ReactNode }[] = [];
  if (exclusions.rank_too_high > 0) {
    exclusionBullets.push({
      key: "rank",
      node: (
        <>
          <strong>Rank ceiling:</strong> {exclusions.rank_too_high} ASINs ranked above 500,000 in their category were excluded as low-velocity.
        </>
      ),
    });
  }
  if (exclusions.out_of_stock > 0) {
    exclusionBullets.push({
      key: "oos",
      node: (
        <>
          <strong>Out of stock:</strong> {exclusions.out_of_stock} ASINs flagged as out of stock by Amazon were excluded.
        </>
      ),
    });
  }
  if (exclusions.no_buy_box_history > 0) {
    exclusionBullets.push({
      key: "nobb",
      node: (
        <>
          <strong>No buy-box history:</strong> {exclusions.no_buy_box_history} ASINs with no recorded buy-box winner in the trailing 90 days are kept in the catalog count but contribute zero attributed sales (we treat the absence of buy-box activity as evidence the listing did not sell).
        </>
      ),
    });
  }
  if (exclusions.variation_inactive_sibling > 0) {
    exclusionBullets.push({
      key: "var",
      node: (
        <>
          <strong>Variation siblings:</strong> {exclusions.variation_inactive_sibling} bulk-pack or parent-shell ASINs that share rank with an active sibling and have no independent buy-box wins receive zero attributed units to avoid double-counting.
        </>
      ),
    });
  }

  return (
    <section id="s-methodology" className="rv2-section rv2-section-method">
      <SectionHead eyebrow="Audit Scope" title="Methodology & Audit Scope" />

      <div className="rv2-method-strip">
        <MethodStat label="Brand" value={brand.name} />
        <MethodStat
          label="ASINs found on Amazon"
          value={asinsFound != null ? asinsFound.toLocaleString("en-US") : "— not measured"}
        />
        <MethodStat
          label="ASINs included in this audit"
          value={asinsIncluded != null ? asinsIncluded.toLocaleString("en-US") : "— not measured"}
        />
        <MethodStat label="Audit window" value={auditWindow} />
      </div>

      <div className="rv2-method-card">
        <div className="rv2-method-card-title">Why these ASINs are included</div>
        {exclusionBullets.length > 0 ? (
          <ul className="rv2-method-bullets">
            {exclusionBullets.map((b) => (
              <li key={b.key}>{b.node}</li>
            ))}
          </ul>
        ) : (
          <p className="rv2-method-card-body">
            All ASINs Keepa returned for this brand had measurable sales activity in the trailing 90 days, so no listings were excluded from the catalog count.
          </p>
        )}
      </div>

      <div className="rv2-method-card">
        <div className="rv2-method-card-title">How we estimate units sold</div>
        <ul className="rv2-method-bullets">
          <li>
            <strong>Primary source — Amazon&apos;s published purchase badge.</strong> When Amazon shows a &ldquo;100+ bought in past month&rdquo; or similar badge on the listing, we capture that value via Keepa&apos;s <code>monthlySold</code> field.{" "}
            <strong>
              {withBadge} of {asinsIncluded ?? 0} included ASINs have a published badge.
            </strong>
          </li>
          <li>
            <strong>Fallback — BSR curve.</strong> For ASINs without a published badge, we estimate monthly units from the ASIN&apos;s category sales rank using a published-research BSR-to-units curve.
          </li>
          <li>
            <strong>Variation attribution.</strong> When sibling ASINs share a parent listing&apos;s sales rank, we split the parent&apos;s units across siblings using recent review activity (last 90 days) plus buy-box win frequency. Inactive siblings (pallets, dormant variations) receive zero.
          </li>
          <li>
            <strong>Revenue formula.</strong> <code>attributed monthly units × current buy-box price × 12 = trailing 12-month revenue estimate</code>, summed across every included ASIN.
          </li>
        </ul>
      </div>

      <aside className="rv2-method-disclaimer" aria-labelledby="rv2-method-disc-title">
        <div id="rv2-method-disc-title" className="rv2-method-disclaimer-title">
          About the &ldquo;100+ bought&rdquo; badge.
        </div>
        <p className="rv2-method-disclaimer-body">
          Amazon publishes monthly purchase badges in tiers (&ldquo;50+ bought&rdquo;, &ldquo;100+ bought&rdquo;, &ldquo;1,000+ bought&rdquo;). When we see &ldquo;100+ bought,&rdquo; our model records exactly <strong>100</strong> units — even though the true number could be 101, 199, or anything up to the next tier. <strong>We are deliberately conservative.</strong> A brand with many &ldquo;100+&rdquo; or &ldquo;1,000+&rdquo; badged ASINs may have meaningfully higher actual TTM revenue than this report shows. Replace these estimates with the seller&apos;s actual TTM during diligence.
        </p>
      </aside>

      <div className="rv2-method-card">
        <div className="rv2-method-card-title">What this report does not do</div>
        <ul className="rv2-method-bullets">
          <li>
            This report does not adjust for <strong>seasonality</strong> — trailing 12-month revenue is treated as flat across the year.
          </li>
          <li>
            This report does not include <strong>non-Amazon channels</strong> (Walmart, Shopify, wholesale, retail).
          </li>
          <li>
            This report does not detect <strong>brand-name collisions</strong> — if a brand catalog umbrellas multiple sub-brands or a hijacked listing, those ASINs may still appear as included.
          </li>
          <li>
            This report does not include <strong>direct sales reporting</strong> — every per-ASIN unit number is a model estimate.
          </li>
        </ul>
      </div>

      {/* Phase 60 — Variation handling methodology card removed per spec. */}

      <div className="rv2-method-sources">
        <span>Keepa snapshot · {formatLongDate(keepaFresh)}</span>
        <span className="rv2-method-sources-sep">·</span>
        <span>DataForSEO snapshot · {formatLongDate(dfsFresh)}</span>
        <span className="rv2-method-sources-sep">·</span>
        <span>Buy-box history window · 90 days</span>
      </div>
    </section>
  );
}

function MethodStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rv2-method-stat">
      <div className="rv2-method-stat-lbl">{label}</div>
      <div className="rv2-method-stat-val">{value}</div>
    </div>
  );
}

// ====================================================================
// Section 2 — Reseller Reality (charts)
// ====================================================================

function SectionResellerReality({
  narrative,
  bundle,
  derived,
}: {
  narrative: NarrativeV2;
  bundle: BrandEnrichmentBundle | null;
  derived: DerivedSnapshot;
}) {
  const r = narrative.reseller_reality;
  const sellers = r.top_sellers;
  // Phase 47 — Module 3 hook callouts. Tight-channel reports skip all
  // hooks (handled inside `pickHook`).
  const antiAmazonHook = pickHook(
    narrative.qualification,
    "anti_amazon_policy_violation",
    derived.is_tight_channel,
  );
  const dominantHook = pickHook(
    narrative.qualification,
    "dominant_single_reseller",
    derived.is_tight_channel,
  );
  // Phase 46 — verify the hook names a seller the user has classified
  // as `reseller`. Brand-controlled / authorized / amazon names are
  // never named in reseller-context copy.
  const dominantSeller = dominantHook
    ? findResellerByName(dominantHook, sellers)
    : null;
  const dominantSellerSafe = dominantHook && dominantSeller ? dominantHook : null;

  // Phase 40 — Goal A2. Split brand-controlled rows OUT of the reseller
  // table into a separate positive sub-heading. Only classification =
  // 'reseller' rows (or legacy is_brand_controlled === false) belong in
  // the reseller table.
  const resellerRows: ResellerRow[] = [];
  const brandControlledRows: ResellerRow[] = [];
  for (const s of sellers) {
    const cls = lookupClassification(derived, s);
    if (cls === "reseller") {
      resellerRows.push(s);
    } else if (cls === "brand_owned" || cls === "authorized") {
      brandControlledRows.push(s);
    } else if (cls === "amazon") {
      // Amazon retail isn't a reseller in the threat sense — show in
      // brand-controlled section to keep the reseller table tight.
      brandControlledRows.push(s);
    } else if (cls == null) {
      // No snapshot data → fall back to legacy boolean.
      if (s.is_brand_controlled === true) brandControlledRows.push(s);
      else resellerRows.push(s);
    }
  }

  const maxResellerShare =
    resellerRows.reduce((m, s) => Math.max(m, s.share_pct ?? 0), 0) || 1;
  const maxBrandShare =
    brandControlledRows.reduce((m, s) => Math.max(m, s.share_pct ?? 0), 0) || 1;

  // Tone selector: tight channel vs strong control vs default reseller-heavy.
  const tone: "tight" | "strong" | "default" = derived.is_tight_channel
    ? "tight"
    : derived.is_strongly_controlled
      ? "strong"
      : "default";

  return (
    <section id="s-reseller-reality" className="rv2-section rv2-section-alt">
      <SectionHead
        eyebrow="Reseller Reality"
        title="Who actually sells your brand on Amazon"
        source="Keepa · 90-day window · classification confirmed by you"
      />

      {/* Phase 47 — Module 3 hook: anti-amazon policy violation. */}
      {antiAmazonHook && (
        <div className="rv2-banner rv2-banner-warn">
          <strong>Your stated policy:</strong>{" "}
          <span>{antiAmazonHook.hook_text}</span>
          {antiAmazonHook.evidence && (
            <div className="rv2-prose" style={{ marginTop: 6 }}>
              {antiAmazonHook.evidence}
            </div>
          )}
        </div>
      )}

      {/* Phase 47 — Module 3 hook: dominant single reseller emphasis bar.
          Per Phase 46, only renders when the hook names a seller that the
          user has classified as `reseller`. */}
      {dominantSellerSafe && dominantSeller && (
        <div className="rv2-banner rv2-banner-warn">
          <strong>One reseller dominates the channel:</strong>{" "}
          {dominantSeller.seller_name}
          {dominantSeller.share_pct != null
            ? ` — ${Math.round(dominantSeller.share_pct * 100)}% of buy-box share.`
            : "."}
          <div className="rv2-prose" style={{ marginTop: 6 }}>
            {dominantSellerSafe.hook_text}
          </div>
        </div>
      )}

      {sellers.length === 0 ? (
        <p className="rv2-muted">{r.note ?? "Reseller landscape — not measured this run."}</p>
      ) : (
        <>
          {tone === "tight" && (
            <div className="rv2-banner rv2-banner-good">
              <strong>Tight channel detected.</strong> Based on your classification, you appear to already control this channel. The estimated reseller leakage is small, and there may be limited recovery opportunity here. We&apos;d still want to confirm your authorization on the remaining sellers below.
            </div>
          )}
          {tone === "strong" && !derived.is_tight_channel && (
            <div className="rv2-banner rv2-banner-warn">
              <strong>This channel may already be tightly controlled.</strong> Brand-controlled, authorized, and Amazon retail together appear to account for {Math.round(derived.non_reseller_share * 100)}% of buy-box activity — there may be limited recoverable revenue from reseller removal here. Worth pressure-testing on a short call.
            </div>
          )}

          {brandControlledRows.length > 0 && (
            <div className="rv2-channel-block rv2-channel-good">
              <div className="rv2-channel-block-title">
                Sellers you&apos;ve identified as brand-controlled
              </div>
              <p className="rv2-prose rv2-channel-sub">
                These are the sellers you&apos;ve confirmed represent the brand. They appear in this section so the channel-control picture stays accurate.
              </p>
              <div className="rv2-bars">
                {brandControlledRows.map((s, i) => (
                  <ResellerBar
                    key={`bc-${s.seller_name}-${i}`}
                    row={s}
                    maxShare={maxBrandShare}
                    tone="good"
                  />
                ))}
              </div>
            </div>
          )}

          {resellerRows.length > 0 ? (
            <div className="rv2-channel-block">
              <div className="rv2-channel-block-title">
                Third-party sellers (authorization unknown)
              </div>
              <div className="rv2-bars">
                {resellerRows.map((s, i) => (
                  <ResellerBar
                    key={`r-${s.seller_name}-${i}`}
                    row={s}
                    maxShare={maxResellerShare}
                  />
                ))}
              </div>
              <p className="rv2-prose">{r.one_liner}</p>
            </div>
          ) : (
            <p className="rv2-muted rv2-prose">
              No third-party reseller activity to investigate based on your classifications.
            </p>
          )}

          <BuyBoxPanel
            derived={derived}
            legacyPct={bundle?.keepa?.brand_controlled_pct ?? null}
          />
        </>
      )}
    </section>
  );
}

// ====================================================================
// Phase 58 — Reseller Reality (new consolidation prose)
//
// Persuasion centerpiece for `reseller_controlled` mode. Verbatim copy
// approved by the user — do not paraphrase, shorten, or "improve" it.
// Renders as flowing prose with the standalone "Then we did the math."
// beat, Phase 1 / Phase 2 bolds, and italicized closing questions.
// ====================================================================

function SectionResellerRealityConsolidation() {
  return (
    <section id="s-reseller-reality" className="rv2-section rv2-section-alt">
      <div className="rv2-section-head">
        <div className="rv2-eyebrow">Reseller Reality</div>
      </div>
      <p className="rv2-prose">
        You may already have authorized resellers on Amazon — and you may believe your network is healthy. That belief is reasonable. Most brand owners in your revenue range hold it. None of what we&apos;re about to say is meant to take that away from you.
      </p>
      <p className="rv2-prose">
        What we&apos;ve learned is that the question isn&apos;t whether your resellers are <em>authorized</em>. It&apos;s whether your channel is <em>consolidated</em>. A fragmented seller base — even an authorized one — caps how aggressively the brand itself can invest in the channel. Pricing gets noisy. Listings get edited by people who don&apos;t own the P&amp;L. Advertising dollars compete with sellers who have no incentive to grow the catalog beyond their bestsellers. The brand ends up underwriting an ecosystem instead of running one.
      </p>
      {/* Phase 59 — Web only: everything below the first body paragraph
          collapses into an expandable disclosure. PDF stays fully inline
          (see PDF renderer). Preserve the exact prose unchanged when
          expanded. */}
      <details className="rv2-reseller-reality-details">
        <summary className="rv2-reseller-reality-summary">
          <span className="rv2-reseller-reality-summary-label">
            Read the full reasoning — including the Diversified Hospitality breakdown
          </span>
          <span className="rv2-reseller-reality-summary-hint">(click to expand)</span>
        </summary>
        <div className="rv2-reseller-reality-body">
          <p className="rv2-prose">
            This usually isn&apos;t visible until a brand starts pushing past $2M in revenue. Below that, the math works. Above that, the cracks start showing — and most brand owners assume they&apos;re hitting a ceiling that&apos;s about the product, the category, or the algorithm. It&apos;s almost never any of those things.
          </p>
          <p className="rv2-prose">
            The clearest example we have is Diversified Hospitality. When we took over their Amazon channel, we assumed — like they did — that their existing reseller network was their growth engine. They had authorized partners. Sales were steady. Nothing looked broken.
          </p>
          <p className="rv2-prose">Then we did the math.</p>
          <p className="rv2-prose">
            The resellers weren&apos;t holding the brand back from $2M to $3M. They were holding the brand back from $2M to $10M. Once we consolidated control — pricing, listings, advertising, inventory positioning, all of it under one cohesive strategy owned by the brand — the channel grew more than 5x. That growth didn&apos;t come from removing bad actors. It came from removing fragmentation. The brand finally had one P&amp;L, one voice, one strategy on Amazon. That&apos;s when the real number showed up.
          </p>
          <p className="rv2-prose">
            We think of this as two phases. <strong>Phase 1 is consolidation</strong>: bringing the channel back under the brand&apos;s direct control so the economics stop leaking and the strategy stops competing with itself. <strong>Phase 2 is growth</strong>: running that consolidated channel like a real business, with a dedicated Chief Amazon Officer function, full P&amp;L ownership, and the kind of compounding investment that only makes sense once the brand controls every lever.
          </p>
          <p className="rv2-prose">
            If you walk away from this report thinking your reseller network is fine, that&apos;s a fair conclusion to reach. Most brand owners do — until they see what the consolidated version of their own channel looks like. The question we&apos;d leave you with isn&apos;t <em>&ldquo;are my resellers a problem?&rdquo;</em> It&apos;s <em>&ldquo;how much growth am I leaving on the table because nobody owns the whole picture?&rdquo;</em>
          </p>
        </div>
      </details>
    </section>
  );
}

function ResellerBar({
  row,
  maxShare,
  tone,
}: {
  row: ResellerRow;
  maxShare: number;
  tone?: "good" | undefined;
}) {
  const pct = row.share_pct ?? 0;
  const widthPct = Math.max(2, Math.round((pct / maxShare) * 100));
  const name = friendlySellerName(row.seller_name);
  return (
    <div className="rv2-bar-row">
      <div className="rv2-bar-rank">{row.rank}.</div>
      <div className="rv2-bar-name" title={name}>
        {name}
      </div>
      <div className="rv2-bar-track">
        <div
          className={tone === "good" ? "rv2-bar-fill rv2-bar-fill-good" : "rv2-bar-fill"}
          style={{ width: `${widthPct}%` }}
          aria-hidden
        />
      </div>
      <div className="rv2-bar-val">
        {row.share_pct != null ? `${Math.round(row.share_pct * 100)}%` : "—"}
      </div>
      <div className="rv2-bar-asins">
        {row.asins_won != null ? `${row.asins_won} ASINs` : ""}
      </div>
    </div>
  );
}

/**
 * Phase 40 Goal A1 — 4-bucket buy-box ownership bar driven by the
 * persisted classification snapshot. Falls back to a 2-bucket bar
 * (brand_owned vs reseller) when the snapshot is missing.
 */
function BuyBoxPanel({
  derived,
  legacyPct,
}: {
  derived: DerivedSnapshot;
  legacyPct: number | null;
}) {
  const brandOwned = derived.shares.brand_owned;
  const authorized = derived.shares.authorized;
  const amazon = derived.shares.amazon;
  const reseller = derived.shares.reseller;

  const fmt = (n: number) => `${Math.round(n * 100)}%`;
  const widthFor = (n: number) => `${Math.max(0, Math.min(100, n * 100))}%`;

  const note = derived.shares.has_snapshot
    ? "Source: Keepa buy-box share split across your seller classifications."
    : legacyPct != null
      ? "Source: Keepa · brand-controlled share derived from seller-name overlap (legacy heuristic). Re-classify sellers for an exact 4-bucket split."
      : "Source: Keepa · share of buy-box wins on the audited ASINs.";

  return (
    <div className="rv2-bbpanel">
      <div className="rv2-bbpanel-title">Buy-box ownership over the last 90 days</div>
      <div className="rv2-bbpanel-bar rv2-bbpanel-bar-4">
        {brandOwned > 0 && (
          <div
            className="rv2-bbpanel-seg rv2-bbpanel-brand"
            style={{ width: widthFor(brandOwned) }}
          >
            <span>{fmt(brandOwned)} brand-owned</span>
          </div>
        )}
        {authorized > 0 && (
          <div
            className="rv2-bbpanel-seg rv2-bbpanel-authorized"
            style={{ width: widthFor(authorized) }}
          >
            <span>{fmt(authorized)} authorized</span>
          </div>
        )}
        {amazon > 0 && (
          <div
            className="rv2-bbpanel-seg rv2-bbpanel-amazon"
            style={{ width: widthFor(amazon) }}
          >
            <span>{fmt(amazon)} Amazon</span>
          </div>
        )}
        {reseller > 0 && (
          <div
            className="rv2-bbpanel-seg rv2-bbpanel-reseller"
            style={{ width: widthFor(reseller) }}
          >
            <span>{fmt(reseller)} reseller</span>
          </div>
        )}
        {brandOwned + authorized + amazon + reseller === 0 && (
          <div className="rv2-bbpanel-seg rv2-bbpanel-empty" style={{ width: "100%" }}>
            <span>— not measured</span>
          </div>
        )}
      </div>
      <div className="rv2-bbpanel-legend">
        <span className="rv2-bbpanel-legend-item">
          <span className="rv2-bbpanel-swatch rv2-bbpanel-brand" /> Brand-owned
        </span>
        <span className="rv2-bbpanel-legend-item">
          <span className="rv2-bbpanel-swatch rv2-bbpanel-authorized" /> Authorized
        </span>
        <span className="rv2-bbpanel-legend-item">
          <span className="rv2-bbpanel-swatch rv2-bbpanel-amazon" /> Amazon
        </span>
        <span className="rv2-bbpanel-legend-item">
          <span className="rv2-bbpanel-swatch rv2-bbpanel-reseller" /> Reseller
        </span>
      </div>
      <div className="rv2-bbpanel-note">{note}</div>
    </div>
  );
}

// Phase 58 — SectionResellerDossier removed entirely. "Did You Authorize
// These Sellers?" and the embedded "Top ASINs they win" subsection were
// two of the five sections cut in Phase 58.

// ====================================================================
// Section 4 — Top Products & Listing Health (per-ASIN economics)
// ====================================================================

function SectionTopProducts({
  narrative,
  maxCards = 10,
}: {
  narrative: NarrativeV2;
  /** Phase 41a — short layout caps at 5 to keep the benchmark report
   *  scannable. Long layout keeps the existing 10-card limit. */
  maxCards?: number;
}) {
  const cx = narrative.cx_audit;
  // Cards are sorted by revenue desc and capped per `maxCards`. Older
  // narrative_json may have only 3 — we keep what's there.
  const sorted = cx.asin_scores
    .slice()
    .sort((a, b) => (b.ttm_revenue ?? -1) - (a.ttm_revenue ?? -1))
    .slice(0, maxCards);
  // Phase 31 — fall back on per-card group size when the narrative
  // doesn't carry the dedicated `variation_disclosure` flag (legacy
  // narrative_json from before this phase shipped). Either signal
  // surfaces the methodology subsection.
  const hasVariations =
    cx.variation_disclosure?.has_variations === true ||
    sorted.some((a) => (a.variation_group_size ?? 1) >= 2);

  return (
    <section id="s-products" className="rv2-section rv2-section-alt">
      <SectionHead
        eyebrow="Top Products"
        title="Where the demand sits — and what each listing looks like"
        source={
          hasVariations
            ? "Keepa /product · BSR + price · 365-day avg · variation-aware"
            : "Keepa /product · BSR + price · 365-day avg"
        }
      />

      {sorted.length > 0 && (
        <p className="rv2-prose rv2-prose-callout">
          The top {sorted.length} ASINs ranked by estimated TTM revenue. Per-ASIN economics, listing health, and seller signals — full ASIN list lives in the methodology appendix.
        </p>
      )}

      {sorted.length > 0 ? (
        <div className="rv2-asin-scores rv2-asin-scores-wide">
          {sorted.map((a) => (
            <AsinScoreCard key={a.asin} score={a} />
          ))}
        </div>
      ) : (
        <p className="rv2-muted">
          Top product economics — not measured this run.
        </p>
      )}

      {/* Phase 58 — "What's Broken Right Now" block removed; the
          variation handling methodology now lives in SectionMethodology
          at the bottom of the report. */}

      <p className="rv2-muted-small">
        Per-ASIN revenue and units are directional estimates from Keepa BSR + buy-box price (365-day avg). Replace with seller's actual TTM during diligence.
      </p>
    </section>
  );
}

// Phase 58 — VariationMethodologyPanel was moved into SectionMethodology
// (see the Methodology · Variation handling card there).

function AsinScoreCard({ score }: { score: CxAuditAsinScore }) {
  const facts: { label: string; value: string }[] = [];
  if (score.images != null) facts.push({ label: "Images", value: String(score.images) });
  if (score.bullets != null) facts.push({ label: "Bullets", value: String(score.bullets) });
  if (score.rating != null) facts.push({ label: "Rating", value: score.rating.toFixed(1) });
  if (score.reviews != null)
    facts.push({ label: "Reviews", value: score.reviews.toLocaleString("en-US") });
  if (score.has_a_plus != null) facts.push({ label: "A+", value: score.has_a_plus ? "Yes" : "No" });
  if (score.has_video != null)
    facts.push({ label: "Video", value: score.has_video ? "Yes" : "No" });
  const groupSize = score.variation_group_size ?? 1;
  const isVariation = groupSize >= 2;
  return (
    <div className="rv2-asincard">
      <div className="rv2-asincard-top">
        <span className="rv2-asin">{score.asin}</span>
        <span className="rv2-asincard-badges">
          {isVariation && (
            <span
              className="rv2-rev-badge rv2-rev-badge-variation"
              title={`This ASIN is one of ${groupSize} variations sharing a parent listing. Sales are attributed across siblings by recent review activity and Buy Box win frequency.`}
            >
              Variation · 1 of {groupSize}
            </span>
          )}
          <span className="rv2-rev-badge rv2-rev-badge-est" title="Directional estimate from Keepa BSR + buy-box price">
            Estimate
          </span>
        </span>
      </div>
      {score.title && <div className="rv2-asincard-title">{score.title}</div>}
      <div className="rv2-asincard-econ">
        <div className="rv2-asincard-econ-row">
          <span className="rv2-asincard-econ-lbl">Revenue</span>
          <span className="rv2-asincard-econ-val">
            {score.ttm_revenue != null ? `${money(score.ttm_revenue)}/yr` : "— not measured"}
          </span>
        </div>
        <div className="rv2-asincard-econ-row">
          <span className="rv2-asincard-econ-lbl">Units sold</span>
          <span className="rv2-asincard-econ-val">
            {formatMonthlyAnnualUnits(score.monthly_units, score.ttm_units)}
          </span>
        </div>
        {score.buy_box_price != null && (
          <div className="rv2-asincard-econ-row">
            <span className="rv2-asincard-econ-lbl">Buy-box price</span>
            <span className="rv2-asincard-econ-val">${score.buy_box_price.toFixed(2)}</span>
          </div>
        )}
      </div>
      {score.score != null && (
        <div className="rv2-asincard-health">
          <div className="rv2-asincard-health-lbl">
            Listing health <span className="rv2-asincard-health-val">{score.score}/100</span>
          </div>
          <div className="rv2-asincard-bar">
            <div
              className="rv2-asincard-bar-fill"
              style={{ width: `${score.score}%` }}
              aria-hidden
            />
          </div>
        </div>
      )}
      {facts.length > 0 && (
        <div className="rv2-asincard-facts">
          {facts.map((f) => (
            <span key={f.label} className="rv2-asincard-fact">
              <span className="rv2-asincard-fact-lbl">{f.label}</span>
              <span className="rv2-asincard-fact-val">{f.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Section 5 — The Math — rendered by `LegionMathSection` (client). See
// `./LegionMathSection.tsx` for the two-tier disclosure + editable
// input panel.

// ====================================================================
// Section 6 — 6-12 Month Capture Plan (Five-Step Framework)
// ====================================================================

function SectionPlan({
  narrative,
  derived,
}: {
  narrative: NarrativeV2;
  derived: DerivedSnapshot;
}) {
  const p = narrative.plan;
  const steps = p.steps && p.steps.length === 5 ? p.steps : null;

  // Phase 46 — Render-time defense in depth. Re-classify the top-seller
  // list against the persisted snapshot here (mirrors the assemble.ts
  // filter) so legacy narrative_json that named the brand owner as a
  // reseller in Step 4 still renders cleanly. We use this for:
  //   1. The empty-resellers fallback decision (no reseller exists →
  //      switch to a reference protection plan)
  //   2. A name-redaction sanitizer over each step body / intro
  const sellers = narrative.reseller_reality.top_sellers ?? [];
  const resellerSellers: ResellerRow[] = [];
  const brandControlledNames = new Set<string>();
  for (const s of sellers) {
    const cls = lookupClassification(derived, s);
    if (cls === "reseller" || (cls == null && s.is_brand_controlled === false)) {
      resellerSellers.push(s);
    } else if (cls === "brand_owned" || cls === "authorized" || cls === "amazon") {
      const n = (s.seller_name ?? "").trim();
      if (n) brandControlledNames.add(n);
    } else if (cls == null && s.is_brand_controlled === true) {
      const n = (s.seller_name ?? "").trim();
      if (n) brandControlledNames.add(n);
    }
  }
  const hasResellers = resellerSellers.length > 0;
  const scrubBrandOwnedNaming = makePlanCopySanitizer(brandControlledNames);

  // Phase 47 — Module 3 hook: trademark split renders as a subsection in
  // the framework intro (NOT inside Step 4 — Phase 46 already gates that).
  const trademarkHook = pickHook(
    narrative.qualification,
    "trademark_split",
    derived.is_tight_channel,
  );

  // Empty-resellers fallback: every seller is brand-owned / authorized
  // / amazon. The framework section needs sensible reference copy
  // rather than a body that still names "the largest reseller".
  if (!hasResellers && steps) {
    return (
      <section id="s-plan" className="rv2-section rv2-section-alt">
        <SectionHead
          eyebrow="Capture Plan"
          title="The Five-Step Framework"
        />
        <div className="rv2-fivestep">
          {steps.map((s, i) => (
            <PlanStepCard
              key={s.number}
              step={
                s.number === 4
                  ? { ...s, body: emptyResellerStep4Body() }
                  : { ...s, body: scrubBrandOwnedNaming(s.body) }
              }
              callout={i === 3 ? "step4" : i === 4 ? "step5" : null}
            />
          ))}
        </div>
        {p.closing && (
          <p className="rv2-prose rv2-plan-closing">{p.closing}</p>
        )}
      </section>
    );
  }

  return (
    <section id="s-plan" className="rv2-section rv2-section-alt">
      <SectionHead
        eyebrow="Capture Plan"
        title="The Five-Step Framework"
      />

      {trademarkHook && (
        <div className="rv2-banner rv2-banner-warn">
          <strong>Brand Registry enforcement complexity:</strong>{" "}
          <span>{trademarkHook.hook_text}</span>
          {trademarkHook.evidence && (
            <div className="rv2-prose" style={{ marginTop: 6 }}>
              {trademarkHook.evidence}
            </div>
          )}
        </div>
      )}

      {steps ? (
        <div className="rv2-fivestep">
          {steps.map((s, i) => (
            <PlanStepCard
              key={s.number}
              step={{ ...s, body: scrubBrandOwnedNaming(s.body) }}
              callout={i === 3 ? "step4" : i === 4 ? "step5" : null}
            />
          ))}
        </div>
      ) : (
        // Legacy 90-day shape — keeps older reports rendering during the
        // backfill window.
        <div className="rv2-plan-grid">
          {p.columns.map((col, i) => (
            <div key={i} className="rv2-plan-col">
              <div className="rv2-plan-label">{col.label}</div>
              <ul>
                {col.bullets.map((b, j) => (
                  <li key={j}>{scrubBrandOwnedNaming(b)}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {p.closing && (
        <p className="rv2-prose rv2-plan-closing">{p.closing}</p>
      )}
    </section>
  );
}

/**
 * Phase 46 — Render-time scrub for any "Transitioning from resellers
 * like {brand-owned}" copy that may have been baked into older
 * narrative_json. Replaces the literal seller name with neutral
 * phrasing rather than failing closed (the page already rendered);
 * downstream surfaces (PDF) re-use this same helper.
 */
function emptyResellerStep4Body(): string {
  return "Based on your classifications, the channel is already brand-controlled — there are no third-party resellers to transition off your listings today. The framework continues to apply as a protection plan: written distribution terms, MAP enforcement, and a monitored authorized-seller list keep new resellers from showing up six months from now.";
}

function makePlanCopySanitizer(
  brandControlledNames: Set<string>,
): (input: string) => string {
  if (!brandControlledNames || brandControlledNames.size === 0) {
    return (s) => s ?? "";
  }
  const names = Array.from(brandControlledNames)
    .map((n) => n.trim())
    .filter((n) => n.length >= 3)
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return (s) => s ?? "";
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Two passes per name:
  //   1. "(transitioning|removing|targeting) … resellers like {name}" →
  //      strip the construct entirely so the sentence reads as a
  //      generic reseller-transition reference.
  //   2. Bare-name fallback → swap with "an authorized brand-controlled
  //      seller" so any standalone mention reads correctly.
  // Order matters — do construct-stripping first.
  const constructPatterns = names.map(
    (n) =>
      new RegExp(
        `\\bresellers?\\s+(?:like|such as)\\s+${escape(n)}\\b(?:\\s*\\([^)]*\\))?`,
        "gi",
      ),
  );
  const barePatterns = names.map(
    (n) => new RegExp(`\\b${escape(n)}\\b(?:\\s*\\([^)]*\\d+%[^)]*\\))?`, "gi"),
  );
  // Phase 55 — appositive guard. When the brand owner's own name shows
  // up in a "Your brand, {name}, has an annual leak of $X" construct,
  // the previous bare-name rewrite produced "Your brand, an authorized
  // brand-controlled seller, has an annual leak of $X" — grammatically
  // valid but conceptually broken (the brand isn't a "seller" to be
  // transitioned; the leak isn't the brand's own). Strip the entire
  // appositive in that construct so it reads "Your brand has an annual
  // leak of $X."
  const appositivePatterns = names.map(
    (n) =>
      new RegExp(
        `(your brand|the brand|${escape(n)})\\s*,\\s*${escape(n)}\\s*,\\s*`,
        "gi",
      ),
  );
  return (input: string) => {
    if (!input) return input ?? "";
    let out = input;
    for (const re of constructPatterns) out = out.replace(re, "third-party resellers");
    for (const re of appositivePatterns) out = out.replace(re, "$1 ");
    for (const re of barePatterns) out = out.replace(re, "an authorized brand-controlled seller");
    return out;
  };
}

function PlanStepCard({
  step,
  callout,
}: {
  step: PlanStep;
  callout: "step4" | "step5" | null;
}) {
  return (
    <div className="rv2-step">
      <div className="rv2-step-head">
        <div className="rv2-step-num">Step {step.number}</div>
        <div className="rv2-step-title">{step.title}</div>
      </div>
      <p className="rv2-step-body">{step.body}</p>
      {callout === "step4" && (
        <RcgCallout
          kicker="Case study"
          body={DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.frameworkStep4}
        />
      )}
      {/* Phase 59 — Step 5 "Team Model" callout removed per spec. */}
    </div>
  );
}

// ====================================================================
// Section 7 — Footer CTA + Steve bio block
// ====================================================================

function SectionFooterCta({
  narrative,
  brand,
  pdfUrl,
  callHref,
}: {
  narrative: NarrativeV2;
  brand: PublicReportV2Brand;
  pdfUrl: string | null;
  callHref: string;
}) {
  const c = narrative.cta;
  return (
    <section id="s-cta" className="rv2-section rv2-section-cta">
      <div className="rv2-eyebrow">Recommended Next Step</div>
      <h2 className="rv2-h2">
        Schedule a 15-minute Amazon Channel Ownership Review with Steve.
      </h2>
      <p className="rv2-prose rv2-cta-prose rv2-muted">
        No pressure. The goal is to confirm whether the opportunity is real, whether the assumptions are fair, and whether taking control is worth exploring.
      </p>

      <div className="rv2-cta-actions">
        <a className="rv2-btn rv2-btn-primary" href={callHref}>
          Book a 15-minute review
        </a>
        {pdfUrl && (
          <a className="rv2-btn" href={pdfUrl} target="_blank" rel="noreferrer">
            Download the PDF
          </a>
        )}
      </div>

      <p className="rv2-cta-contact">
        <a href={`mailto:${c.secondary_email}`}>{c.secondary_email}</a>
        {c.secondary_phone && (
          <>
            {" · "}
            {c.secondary_phone}
          </>
        )}
      </p>
    </section>
  );
}

// ====================================================================
// Phase 24 — DIY-mode sections (rendered only when narrative.report_mode
// === 'diy_fit'). The brand is already running a tight Amazon channel;
// the residual reseller share is too small to justify RCG fees, so we
// drop the capture plan / WHY-RCG callouts / math section in favor of a
// friendly "wrap this up yourself" 3-step list. Reseller dossier + CX +
// keywords + competitors stay because they're genuinely useful info.
// ====================================================================

function SectionDiyCover({
  narrative,
  brand,
}: {
  narrative: NarrativeV2;
  brand: PublicReportV2Brand;
}) {
  const pct = narrative.brand_controlled_pct ?? null;
  const pctLabel =
    pct != null ? `${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%` : "most";
  const headline =
    narrative.cover.headline ||
    `${brand.name}, you're already running a tight Amazon channel.`;
  return (
    <section id="s-cover" className="rv2-section rv2-section-cover">
      <div className="rv2-eyebrow">Channel Ownership Recommendations</div>
      <div className="rv2-cover-meta">
        <div className="rv2-cover-meta-line">Prepared for {brand.name}</div>
        <div className="rv2-cover-meta-line rv2-muted">
          {formatLongDate(narrative.generated_at)} · By Rolle Consulting Group
        </div>
      </div>
      <h1 className="rv2-h1">{headline}</h1>

      <div className="rv2-kpi-grid rv2-kpi-grid-1">
        <BigStat
          label={`You already control ${pctLabel} of your own Amazon sales — that's strong.`}
          value={pctLabel}
          sub="Buy-box ownership across your top SKUs · Keepa"
        />
      </div>

      <p className="rv2-prose rv2-cta-prose">
        Below: who's left on your listings, what they're shipping, and three concrete steps to seal the leak yourself.
      </p>
    </section>
  );
}

function SectionDiySteps({
  narrative,
  brand,
}: {
  narrative: NarrativeV2;
  /** Phase 41a — tight-channel reports may not have `diy_steps` baked
   *  into narrative_json (legacy `decideReportMode` only populates them
   *  for `diy_fit`). When missing, we fall back to the canonical
   *  copy parametrised on the brand name. */
  brand?: PublicReportV2Brand;
}) {
  const steps: DiyStep[] =
    narrative.diy_steps && narrative.diy_steps.length > 0
      ? narrative.diy_steps
      : brand
        ? defaultDiySteps(brand.name)
        : [];
  if (!steps.length) return null;
  return (
    <section id="s-diy" className="rv2-section rv2-section-alt">
      <SectionHead
        eyebrow="3 steps to wrap this up yourself"
        title="How to seal the residual reseller leakage"
      />
      <div className="rv2-fivestep">
        {steps.map((s) => (
          <div key={s.number} className="rv2-step">
            <div className="rv2-step-head">
              <div className="rv2-step-num">Step {s.number}</div>
              <div className="rv2-step-title">{s.title}</div>
            </div>
            <p className="rv2-step-body">{s.body}</p>
          </div>
        ))}
      </div>
      <p className="rv2-prose rv2-plan-closing">
        Most brands at this stage close the residual leakage in 30–60 days using just these three moves. No agency needed.
      </p>
    </section>
  );
}

function SectionDiyFooterCta({
  narrative,
  brand,
  pdfUrl,
  callHref,
  derived,
}: {
  narrative: NarrativeV2;
  brand: PublicReportV2Brand;
  pdfUrl: string | null;
  callHref: string;
  derived?: DerivedSnapshot;
}) {
  const c = narrative.cta;
  // Phase 54 — brand-controlled share for the tactful Phase 2 framing.
  // Falls back to narrative.brand_controlled_pct for legacy reports.
  const pct =
    (derived && derived.shares.has_snapshot
      ? derived.non_reseller_share
      : narrative.brand_controlled_pct) ?? null;
  const brandControlledPct =
    pct != null ? Math.round(Math.max(0, Math.min(1, pct)) * 100) : null;
  return (
    <section id="s-cta" className="rv2-section rv2-section-cta">
      <div className="rv2-eyebrow">What comes next</div>
      <h2 className="rv2-h2">
        You&apos;ve done more than most brands ever do. Here&apos;s what comes next.
      </h2>
      <p className="rv2-prose rv2-cta-prose">
        Your snapshot shows roughly {brandControlledPct != null ? `${brandControlledPct}%` : "most"} of buy-box wins running through brand-controlled entities — that puts you ahead of 80%+ of the brands we audit. Genuine credit for that; most owners never get there.
      </p>
      <p className="rv2-prose rv2-cta-prose">
        The path from where you are to a channel that compounds at the rate Amazon allows is shorter than for most brands — but it isn&apos;t zero. There&apos;s a distinction that matters before growth investment starts paying back at full strength: complete sales control is different from majority sales control. Authorized resellers — even the ones operating in good faith — fragment how the channel can be invested in. Each one sets its own pricing posture, its own inventory cadence, its own customer experience. None of them are positioned to invest in the brand the way the brand owner can. Before Phase 2 capital and strategy can compound, the channel needs to be running at 100% — not 95%, not 90%.
      </p>
      <p className="rv2-prose rv2-cta-prose">
        For brands in your position, Phase 1 is shorter and lighter than the typical engagement. The work is finishing what you started: closing the residual gap, transitioning the remaining authorized sellers under terms that respect the relationships you&apos;ve built, and putting the operational scaffolding in place so Phase 2 has a clean foundation. Brands in this position typically clear Phase 1 quickly.
      </p>
      <p className="rv2-prose rv2-cta-prose">
        Phase 2 is where the next chapter starts — and that&apos;s a conversation we&apos;d genuinely like to have with you.
      </p>

      <div className="rv2-cta-actions">
        <a className="rv2-btn rv2-btn-primary" href={callHref}>
          Schedule a 15-minute review with Steve
        </a>
        {pdfUrl && (
          <a className="rv2-btn" href={pdfUrl} target="_blank" rel="noreferrer">
            Download the PDF
          </a>
        )}
      </div>

      <p className="rv2-cta-contact rv2-muted">
        <a href={`mailto:${c.secondary_email}`}>{c.secondary_email}</a>
      </p>
    </section>
  );
}

// ====================================================================
// Building blocks
// ====================================================================

function SectionHead({ eyebrow, title, source }: { eyebrow: string; title: string; source?: string }) {
  return (
    <div className="rv2-section-head">
      <div className="rv2-eyebrow">{eyebrow}</div>
      <h2 className="rv2-h2">{title}</h2>
      {source && <div className="rv2-source">{source}</div>}
    </div>
  );
}

// Phase 58 — Fact helper removed; only used by the deleted Reseller Dossier.

function RcgCallout({
  kicker,
  body,
}: {
  kicker: string;
  body: React.ReactNode;
}) {
  return (
    <aside className="rv2-rcg-callout">
      <div className="rv2-rcg-callout-kicker">{kicker}</div>
      <div className="rv2-rcg-callout-body">{body}</div>
    </aside>
  );
}

// ====================================================================
// Phase 40 — New executive sections
// ====================================================================

function SectionExecutiveSummary({
  narrative,
  brand,
  derived,
}: {
  narrative: NarrativeV2;
  brand: PublicReportV2Brand;
  derived: DerivedSnapshot;
}) {
  const revenueLine = narrative.math.lines.find((l) => l.key === "revenue");
  const revenue = typeof revenueLine?.value === "number" ? revenueLine.value : null;
  const profit = narrative.cover.delta_profit ?? null;
  const scope = narrative.audit_scope ?? null;
  const brandPct = Math.round(derived.non_reseller_share * 100);
  const resellerPct = Math.round(derived.reseller_share * 100);
  const top = pickTopReseller(narrative, derived);
  const topShare = pickTopResellerShare(narrative, derived);

  const bullets: React.ReactNode[] = [];
  if (revenue != null) {
    bullets.push(
      <>
        Estimated Amazon revenue found: <strong>{money(revenue)}</strong> per year
      </>,
    );
  }
  if (scope?.asins_included_count != null) {
    bullets.push(
      <>
        ASINs analyzed: <strong>{scope.asins_included_count.toLocaleString("en-US")}</strong>
        {scope.asins_found_total
          ? <> of {scope.asins_found_total.toLocaleString("en-US")} found</>
          : null}
      </>,
    );
  }
  bullets.push(
    <>
      Brand-controlled buy box: <strong>{brandPct}%</strong>
    </>,
  );
  bullets.push(
    <>
      Third-party / reseller-controlled buy box: <strong>{resellerPct}%</strong>
    </>,
  );
  if (top && topShare != null) {
    bullets.push(
      <>
        Top reseller: <strong>{top}</strong> with approximately{" "}
        <strong>{Math.round(topShare * 100)}%</strong> observed buy-box share
      </>,
    );
  }
  if (profit != null) {
    bullets.push(
      <>
        Estimated annual profit recapture: <strong>{money(profit)}</strong>
      </>,
    );
  }
  bullets.push(
    <>Primary issue: margin leakage + customer experience control</>,
  );

  return (
    <section id="s-summary" className="rv2-section">
      <SectionHead eyebrow="Executive Summary" title={`What we found for ${brand.name}`} />
      <div className="rv2-summary-box">
        <ul className="rv2-summary-bullets">
          {bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// Phase 58 — SectionChannelControl, SectionCustomerExperience, and
// SectionSafeTransition were removed in opportunity mode. The new
// Reseller Reality consolidation prose absorbs the channel-control / CX
// argument, and the Five-Step Framework covers the transition narrative.
// ChannelCard is retained because tight-mode (SectionTightBuyBox) still
// renders it.

function ChannelCard({
  label,
  value,
  sub,
  tone,
  confidence,
}: {
  label: string;
  value: string;
  sub?: string | null;
  tone?: "good" | "warn";
  confidence?: ConfidenceLabel;
}) {
  const cls =
    tone === "good"
      ? "rv2-channel-card rv2-channel-card-good"
      : tone === "warn"
        ? "rv2-channel-card rv2-channel-card-warn"
        : "rv2-channel-card";
  return (
    <div className={cls}>
      <div className="rv2-channel-card-lbl">{label}</div>
      <div className="rv2-channel-card-val">{value}</div>
      {sub && <div className="rv2-channel-card-sub">{sub}</div>}
      {confidence && (
        <div className="rv2-channel-card-conf">
          <ConfidencePill level={confidence} />
        </div>
      )}
    </div>
  );
}


// ====================================================================
// Phase 54 — Phase 2 / Fractional Chief Amazon Officer section.
// Renders only in opportunity mode, between the Five-Step Framework and
// Why Steve Rolle. Tight + legacy-diy modes use the SectionDiyFooterCta
// block to deliver the Phase 2 framing instead.
// ====================================================================

function SectionPhaseTwo({ brand }: { brand: PublicReportV2Brand }) {
  return (
    <section id="s-phase-two" className="rv2-section">
      <SectionHead
        eyebrow="Phase 2"
        title="What comes next, once capture is complete"
      />
      <p className="rv2-prose">
        Once your channel is brand-controlled and the leakage is closed, the question shifts from &ldquo;how do we stop the bleeding&rdquo; to &ldquo;how do we compound this into a meaningful business.&rdquo; That&apos;s where most brands stall — not because the team isn&apos;t capable, but because the Amazon growth playbook is a moving target. The right agency this year is the wrong one next year. The right team structure at $5M is the wrong one at $15M. The experiments that compound aren&apos;t the ones that look obvious from the outside.
      </p>
      <p className="rv2-prose">
        Phase 2 is where Rolle Consulting steps in as your fractional Chief Amazon Officer — orchestrating the agencies, strategists, and team scaling that turn a controlled channel into a compounding one. We&apos;ve already done the trial-and-error on which partners deliver, which experiments are worth the spend, and how to scale the team without scaling overhead ahead of the revenue.
      </p>
      <p className="rv2-prose">
        Phase 2 is a separate engagement that begins after Phase 1 capture stabilizes. We&apos;ll walk through what that looks like for {brand.name} once Phase 1 is on track.
      </p>
    </section>
  );
}

function SectionWhySteveRolle() {
  return (
    <section id="s-why" className="rv2-section">
      <SectionHead
        eyebrow="Why Steve Rolle / RCG"
        title="Operator-led, not agency"
      />
      <p className="rv2-prose">
        {DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.whySteveBio}
      </p>
      <p className="rv2-prose">
        More recently, Steve helped <strong>Legion Chemicals</strong> grow from $0 to roughly a <strong>$1M ARR</strong> Amazon run rate in less than 10 months.
      </p>
      <p className="rv2-prose">
        We&apos;ve handled this process across reseller-fragmented catalogs and understand how to sequence the transition without disrupting core wholesale relationships.
      </p>
      <p className="rv2-prose rv2-prose-callout">
        The lesson was simple: when the brand owner controls the marketplace, the brand can invest in the channel in a way resellers never will.
      </p>
      <div className="rv2-positioning">
        <ul>
          <li>Operator, not agency</li>
          <li>Brand owner, not theorist</li>
          <li>Channel strategist, not Amazon tactician</li>
          <li>Profit recovery, not ad management</li>
          <li>Safe transition, not reseller war</li>
        </ul>
      </div>
      <p className="rv2-muted-small">
        Engagements are structured around the size of the opportunity. In many cases, we combine a fixed implementation fee with performance-based upside tied to incremental profit. If the opportunity is not large enough to justify our involvement, we&apos;ll tell you.
      </p>
    </section>
  );
}

// ====================================================================
// Phase 44 — Diversified Hospitality case study (full appendix)
// Renders only in opportunity mode. Collapsed-by-default <details>
// element so the page stays compact; the in-page anchor uses
// `:target` to auto-expand when the reader follows a snippet link.
// ====================================================================

function SectionCaseStudyDiversifiedHospitality() {
  const cs = DIVERSIFIED_HOSPITALITY_CASE_STUDY;
  return (
    <section
      id={CASE_STUDY_ANCHOR_ID}
      className="rv2-section rv2-section-case-study"
    >
      <SectionHead
        eyebrow="Case Study"
        title="How Diversified Hospitality doubled its Amazon profit at flat revenue by taking the channel back from resellers"
      />
      <details className="rv2-case-study-details">
        <summary className="rv2-case-study-summary">
          <span className="rv2-case-study-summary-label">
            Read the full Diversified Hospitality case study
          </span>
          {" "}
          <span className="rv2-case-study-summary-hint">
            (click to expand)
          </span>
        </summary>
        <div className="rv2-case-study-body">
          <p className="rv2-prose rv2-case-study-preface">{cs.preface}</p>

          <h3 className="rv2-h3 rv2-case-study-h3">The Situation</h3>
          {cs.sections.situation.paragraphs?.map((p, i) => (
            <p key={`s-p-${i}`} className="rv2-prose">
              {p}
            </p>
          ))}
          {cs.sections.situation.bullets && (
            <ul className="rv2-case-study-list">
              {cs.sections.situation.bullets.map((b, i) => (
                <li key={`s-b-${i}`}>{b}</li>
              ))}
            </ul>
          )}
          {cs.sections.situation.tail?.map((p, i) => (
            <p key={`s-t-${i}`} className="rv2-prose">
              {p}
            </p>
          ))}

          <h3 className="rv2-h3 rv2-case-study-h3">The Decision</h3>
          {cs.sections.decision.paragraphs?.map((p, i) => (
            <p key={`d-p-${i}`} className="rv2-prose">
              {p}
            </p>
          ))}
          {cs.sections.decision.bullets && (
            <ul className="rv2-case-study-list">
              {cs.sections.decision.bullets.map((b, i) => (
                <li key={`d-b-${i}`}>{b}</li>
              ))}
            </ul>
          )}

          <h3 className="rv2-h3 rv2-case-study-h3">The Execution</h3>
          <p className="rv2-prose">{cs.sections.execution.lead}</p>
          <ol className="rv2-case-study-steps">
            {cs.sections.execution.steps.map((step, i) => (
              <li key={`e-${i}`}>
                <div className="rv2-case-study-step-title">{step.title}</div>
                <div className="rv2-case-study-step-body">{step.body}</div>
              </li>
            ))}
          </ol>

          <h3 className="rv2-h3 rv2-case-study-h3">The Results</h3>
          {cs.sections.results.paragraphs?.map((p, i) => (
            <p key={`r-p-${i}`} className="rv2-prose">
              {p}
            </p>
          ))}
          {cs.sections.results.bullets && (
            <ul className="rv2-case-study-list">
              {cs.sections.results.bullets.map((b, i) => (
                <li key={`r-b-${i}`}>{b}</li>
              ))}
            </ul>
          )}
          {cs.sections.results.tail?.map((p, i) => (
            <p key={`r-t-${i}`} className="rv2-prose">
              {p}
            </p>
          ))}
          <ul className="rv2-case-study-list">
            <li>Amazon became a brand-controlled profit center</li>
            <li>Customer experience became more consistent</li>
            <li>
              Cash flow improved significantly because Amazon paid faster
              than reseller terms
            </li>
            <li>
              Recovered margin was redeployed against working-capital
              needs across the capture period
            </li>
            <li>The increased profitability materially improved the underlying business</li>
          </ul>

          <h3 className="rv2-h3 rv2-case-study-h3">The Lesson</h3>
          {cs.sections.lesson.paragraphs?.map((p, i) => (
            <p key={`l-p-${i}`} className="rv2-prose">
              {p}
            </p>
          ))}
          {cs.sections.lesson.bullets && (
            <ul className="rv2-case-study-list">
              {cs.sections.lesson.bullets.map((b, i) => (
                <li key={`l-b-${i}`}>{b}</li>
              ))}
            </ul>
          )}
          {cs.sections.lesson.tail?.map((p, i) => (
            <p key={`l-t-${i}`} className="rv2-prose">
              {p}
            </p>
          ))}

          {cs.sections.whyThisMatters.paragraphs &&
            cs.sections.whyThisMatters.paragraphs.length > 0 && (
              <>
                <h3 className="rv2-h3 rv2-case-study-h3">
                  Why This Matters for Your Brand
                </h3>
                {cs.sections.whyThisMatters.paragraphs.map((p, i) => (
                  <p key={`w-p-${i}`} className="rv2-prose">
                    {p}
                  </p>
                ))}
              </>
            )}

          <p className="rv2-muted-small rv2-case-study-footnote">
            {cs.footnote}
          </p>
        </div>
      </details>
      {/* Auto-expand + smooth-scroll when the user follows an in-page
         snippet link. SSR-safe: runs once on load and on hashchange. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){
            function openIfHash(){
              if (typeof window === 'undefined') return;
              if (window.location.hash !== '#${CASE_STUDY_ANCHOR_ID}') return;
              var el = document.getElementById('${CASE_STUDY_ANCHOR_ID}');
              if (!el) return;
              var d = el.querySelector('.rv2-case-study-details');
              if (d && !d.open) d.open = true;
              try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch(e) {}
            }
            if (document.readyState === 'loading') {
              document.addEventListener('DOMContentLoaded', openIfHash);
            } else {
              openIfHash();
            }
            window.addEventListener('hashchange', openIfHash);
          })();`,
        }}
      />
    </section>
  );
}

// ====================================================================
// Phase 41a — Short / tight-channel benchmark layout sections.
// Triggered when the persisted classification snapshot meets the
// TIGHT_CHANNEL_THRESHOLDS (reseller share < 5%, brand_owned +
// authorized >= 90%). Tone is consultative — we already control the
// channel, this is a benchmark, not a recapture pitch.
// ====================================================================

function SectionTightHero({
  narrative,
  brand,
  revenue,
  benchmark,
  derived,
  ebitdaMultiple,
  currentMarginPct,
  confRevenue,
  confSellerControl,
}: {
  narrative: NarrativeV2;
  brand: PublicReportV2Brand;
  revenue: number | null;
  benchmark: { current_profit_annual: number; business_value: number } | null;
  derived: DerivedSnapshot;
  ebitdaMultiple: number;
  currentMarginPct: number;
  confRevenue: ConfidenceLabel;
  confSellerControl: ConfidenceLabel;
}) {
  const brandPct = Math.round(derived.non_reseller_share * 100);
  const headline =
    revenue != null
      ? `${brand.name} runs an estimated ${money(revenue)} Amazon channel — and based on your classifications, you control roughly ${brandPct}% of the buy box already.`
      : `${brand.name}, based on your classifications you already control roughly ${brandPct}% of your Amazon buy box.`;
  return (
    <section id="s-cover" className="rv2-section rv2-section-cover">
      <div className="rv2-eyebrow">Channel Ownership Benchmark</div>
      <div className="rv2-cover-meta">
        <div className="rv2-cover-meta-line">Prepared for {brand.name}</div>
        <div className="rv2-cover-meta-line rv2-muted">
          {formatLongDate(narrative.generated_at)} · By Rolle Consulting Group
        </div>
      </div>
      <h1 className="rv2-h1">{headline}</h1>
      <p className="rv2-prose rv2-cover-subhead">
        These are the same numbers we&apos;d compute for a brand we engage with — shared as a benchmark since the channel appears to already be under your control. Below: the buy-box picture, the sellers you&apos;ve confirmed represent the brand, top products driving the revenue, and a small residual reseller table you can address with the 3-step playbook further down.
      </p>

      <div className="rv2-cover-secondary">
        <div className="rv2-cover-secondary-stat">
          <span className="rv2-cover-secondary-lbl">Brand-controlled buy box</span>
          <span className="rv2-cover-secondary-val">
            {brandPct}%
            <ConfidencePill level={confSellerControl} />
          </span>
        </div>
      </div>

      {/* Compact revenue-led signal at the top of the cover. The full
          three-card snapshot lives below in SectionTightBenchmarkCards. */}
      {revenue != null && (
        <div className="rv2-kpi-grid rv2-kpi-grid-1" style={{ marginTop: 36 }}>
          <BigStat
            label="Estimated annual Amazon revenue"
            value={money(revenue)}
            sub="Based on available marketplace data"
            confidence={confRevenue}
          />
        </div>
      )}
      {revenue == null && (
        <p className="rv2-muted-small" style={{ marginTop: 24 }}>
          Revenue not measured this run. Margin / business value below default to <strong>{Math.round(currentMarginPct * 100)}%</strong> of revenue at a {ebitdaMultiple}× EBITDA multiple — pressure-test on a call.
        </p>
      )}
      {benchmark == null && revenue != null && null}
    </section>
  );
}

function SectionTightBenchmarkCards({
  revenue,
  benchmark,
  ebitdaMultiple,
  currentMarginPct,
  confRevenue,
}: {
  revenue: number | null;
  benchmark: { current_profit_annual: number; business_value: number } | null;
  ebitdaMultiple: number;
  currentMarginPct: number;
  confRevenue: ConfidenceLabel;
}) {
  const marginPctLabel = `${Math.round(currentMarginPct * 100)}%`;
  return (
    <section id="s-benchmark" className="rv2-section">
      <SectionHead
        eyebrow="Benchmark Snapshot"
        title="The same numbers we&rsquo;d compute for a brand we engage with"
        source={`Directional benchmark · ${marginPctLabel} margin · ${ebitdaMultiple}× EBITDA`}
      />
      <p className="rv2-prose">
        These are the same numbers we&apos;d compute for a brand we engage with — shared as a benchmark since the channel is already under your control. They are directional estimates designed to size the business, not a recapture pitch.
      </p>

      <div className="rv2-kpi-grid rv2-kpi-grid-3">
        <BigStat
          label="Estimated annual Amazon revenue"
          value={revenue != null ? money(revenue) : "— not measured"}
          sub="Based on available marketplace data"
          confidence={confRevenue}
        />
        <BigStat
          label={`Estimated annual profit at ${marginPctLabel} margin`}
          value={
            benchmark != null
              ? money(benchmark.current_profit_annual)
              : "— not measured"
          }
          sub="Directional estimate · margin assumption shown above"
          confidence="Medium"
        />
        <BigStat
          label={`Estimated business value (${ebitdaMultiple}× EBITDA)`}
          value={
            benchmark != null
              ? money(benchmark.business_value)
              : "— not measured"
          }
          sub="Assumption-based · pressure-tested on a call"
          confidence="Assumption-based"
        />
      </div>
    </section>
  );
}

function SectionTightBuyBox({
  derived,
  bundle,
  confSellerControl,
}: {
  derived: DerivedSnapshot;
  bundle: BrandEnrichmentBundle | null;
  confSellerControl: ConfidenceLabel;
}) {
  return (
    <section id="s-buybox" className="rv2-section rv2-section-alt">
      <SectionHead
        eyebrow="Buy-box ownership"
        title="Who actually wins the buy box on your listings"
        source="Keepa · 90-day window · split by your seller classifications"
      />
      <p className="rv2-prose">
        The bar below splits the buy-box wins on the audited ASINs across the four buckets we track. For a tight channel like yours, the bar should read mostly brand-owned with a small residual reseller sliver.
      </p>
      <div className="rv2-channel-cards">
        <ChannelCard
          label="Brand-controlled buy box"
          value={`${Math.round(derived.non_reseller_share * 100)}%`}
          tone="good"
          confidence={confSellerControl}
        />
        <ChannelCard
          label="Reseller-controlled buy box"
          value={`${Math.round(derived.reseller_share * 100)}%`}
          tone="warn"
          confidence={confSellerControl}
        />
      </div>
      <BuyBoxPanel
        derived={derived}
        legacyPct={bundle?.keepa?.brand_controlled_pct ?? null}
      />
    </section>
  );
}

function SectionTightBrandControlled({
  narrative,
  derived,
}: {
  narrative: NarrativeV2;
  derived: DerivedSnapshot;
}) {
  const sellers = narrative.reseller_reality.top_sellers ?? [];
  const brandRows: ResellerRow[] = [];
  for (const s of sellers) {
    const cls = lookupClassification(derived, s);
    if (cls === "brand_owned" || cls === "authorized" || cls === "amazon") {
      brandRows.push(s);
    }
  }
  const maxShare =
    brandRows.reduce((m, s) => Math.max(m, s.share_pct ?? 0), 0) || 1;

  return (
    <section id="s-brand-controlled" className="rv2-section">
      <SectionHead
        eyebrow="Sellers you&rsquo;ve identified as brand-controlled"
        title="The sellers carrying your buy-box share"
        source="Keepa · classifications confirmed by you"
      />
      {brandRows.length > 0 ? (
        <>
          <p className="rv2-prose">
            These are the sellers you&apos;ve confirmed represent the brand. They appear here so the channel-control picture stays accurate — and so the residual reseller table below is a clean, scoped list.
          </p>
          <div className="rv2-channel-block rv2-channel-good">
            <div className="rv2-bars">
              {brandRows.map((s, i) => (
                <ResellerBar
                  key={`tbc-${s.seller_name}-${i}`}
                  row={s}
                  maxShare={maxShare}
                  tone="good"
                />
              ))}
            </div>
          </div>
        </>
      ) : (
        <p className="rv2-muted rv2-prose">
          No sellers were classified as brand-controlled in your snapshot. The buy-box bar above still reflects the persisted share columns.
        </p>
      )}
    </section>
  );
}

function SectionTightResidualResellers({
  narrative,
  derived,
}: {
  narrative: NarrativeV2;
  derived: DerivedSnapshot;
}) {
  const sellers = narrative.reseller_reality.top_sellers ?? [];
  const resellerRows: ResellerRow[] = [];
  for (const s of sellers) {
    const cls = lookupClassification(derived, s);
    if (cls === "reseller") resellerRows.push(s);
  }
  const residualPct = Math.round(derived.reseller_share * 100);

  return (
    <section id="s-residual" className="rv2-section rv2-section-alt">
      <SectionHead
        eyebrow={`Residual third-party seller activity (~${residualPct}%)`}
        title="The small residual you can address yourself"
        source="Keepa · classifications confirmed by you"
      />
      {resellerRows.length > 0 ? (
        <>
          <p className="rv2-prose">
            These are the third-party sellers in the residual reseller bucket. The combined share is small — small enough that the 3-step playbook below is usually enough to seal it without bringing anyone in.
          </p>
          <div className="rv2-bars">
            {resellerRows.map((s, i) => (
              <ResellerBar
                key={`tr-${s.seller_name}-${i}`}
                row={s}
                maxShare={
                  resellerRows.reduce((m, x) => Math.max(m, x.share_pct ?? 0), 0) || 1
                }
              />
            ))}
          </div>
          <p className="rv2-muted-small" style={{ marginTop: 12 }}>
            Authorization status should be confirmed with your team before contacting any of these sellers.
          </p>
        </>
      ) : (
        <p className="rv2-muted rv2-prose">
          No third-party reseller activity to investigate based on your classifications.
        </p>
      )}
    </section>
  );
}

/**
 * Phase 41a — canonical 3-step DIY copy. Mirrors the assemble.ts
 * `buildDiySteps` so a tight-channel report rendered without a baked
 * `narrative.diy_steps` (e.g. one generated under the Phase 40 high_fit
 * mode) still gets the 3-step playbook.
 */
function defaultDiySteps(brandName: string): DiyStep[] {
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

function SectionDisclaimer() {
  return (
    <section className="rv2-section rv2-section-disclaimer">
      <div className="rv2-disclaimer">
        <div className="rv2-disclaimer-title">How to read this report</div>
        <p>
          Marketplace data is useful for identifying directional opportunity, but final economics require confirmation of COGS, wholesale pricing, authorized seller relationships, fulfillment costs, and current channel agreements.
        </p>
        <p>
          All revenue, profit, and margin estimates are directional and based on available marketplace data, third-party tools, and reasonable assumptions. Actual results depend on costs, pricing, inventory, reseller agreements, fulfillment method, Amazon fees, and execution.
        </p>
      </div>
    </section>
  );
}

// Phase 56 — Segment 4 (brand_managed_with_leakage) soft lead callout.
// Renders only in opportunity_softlead mode, immediately after the
// standard cover. Acknowledges the brand is doing well on its own
// before transitioning into the leakage / Phase 2 framing.
function SectionSoftLead({
  brand,
  derived,
}: {
  brand: PublicReportV2Brand;
  derived: DerivedSnapshot;
}) {
  const brandOwnedPct = Math.round((derived.shares?.brand_owned ?? 0) * 100);
  return (
    <section className="rv2-section">
      <div className="rv2-section-inner">
        <div
          style={{
            border: "1px solid var(--border-soft)",
            borderLeft: "3px solid var(--gold)",
            background: "rgba(201,169,106,0.06)",
            padding: "20px 24px",
            borderRadius: "0 10px 10px 0",
            marginTop: 12,
          }}
        >
          <div
            style={{
              fontWeight: 700,
              fontSize: 13,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--gold)",
              marginBottom: 8,
            }}
          >
            You&apos;re doing well
          </div>
          <p style={{ margin: 0, color: "var(--text)", lineHeight: 1.65 }}>
            {brand.name}, you control a meaningful share of your Amazon channel
            yourself — roughly {brandOwnedPct}% brand-owned today. That puts you
            ahead of most. The remaining slice is where unauthorized resellers
            are still costing you in leakage. Close that gap and you control
            100% of sales, profit on existing demand doubles, and you&apos;re
            set up for Phase 2 growth.
          </p>
        </div>
      </div>
    </section>
  );
}

// Phase 56 — Segment 2 (authorized_network_healthy) callout.
// Renders only in tight-mode for Segment 2 brands. Soft, consultative,
// keeps with Phase 54 voice. The "missing piece" called out by the
// user: even authorized resellers cap growth at scale.
function SectionAuthorizedResellersCap() {
  return (
    <section className="rv2-section">
      <div className="rv2-section-inner">
        <div
          style={{
            border: "1px solid var(--border-soft)",
            borderRadius: 10,
            padding: "22px 24px",
            background: "rgba(255,255,255,0.02)",
            marginTop: 12,
          }}
        >
          <h3
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: "var(--text)",
              margin: "0 0 12px",
              lineHeight: 1.3,
            }}
          >
            Why even authorized resellers cap your growth
          </h3>
          <div style={{ display: "grid", gap: 14, color: "var(--text)", lineHeight: 1.65 }}>
            <p style={{ margin: 0 }}>
              Authorized resellers can be excellent partners. They hold
              inventory, they extend reach, and they often grew with your
              brand. None of that is going away.
            </p>
            <p style={{ margin: 0 }}>
              But there&apos;s a quieter cost that becomes visible at scale: a
              fragmented seller base — even an authorized one — caps how
              aggressively the brand itself can invest in the channel. Each
              reseller sets their own pricing posture. Each one decides their
              own inventory cadence. Each one shapes a piece of the customer
              experience the brand owner doesn&apos;t control.
            </p>
            <p style={{ margin: 0 }}>
              That fragmentation isn&apos;t a problem at $1M, $2M, or even $5M
              of Amazon revenue. It becomes the bottleneck somewhere between
              $5M and $10M, when the brand wants to invest seriously in
              advertising, content, and listing optimization — and discovers
              that those investments compound only when 100% of the buy box
              is brand-controlled.
            </p>
            <p style={{ margin: 0 }}>
              Diversified Hospitality went through exactly this. Authorized
              distributors were &ldquo;helping&rdquo; until we ran the
              numbers. Phase 1 brought all sales under brand control —
              profit doubled on the same revenue base. Phase 2 then took the
              channel from $2M to $10M+ per year. None of that compounding
              was possible while the channel was fragmented across resellers,
              even authorized ones.
            </p>
            <p style={{ margin: 0 }}>
              We&apos;re not telling you your distributor network is bad.
              We&apos;re telling you it&apos;s the layer between where you are
              now and where Phase 2 can take you.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ====================================================================
// Phase 40 — render-time copy sanitization for any LLM-generated text
// that could surface forbidden phrases (risk_profile, math notes, etc.)
// ====================================================================

function sanitizeForbidden(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input);
  // Order matters: the longer/multi-word phrases come first.
  const replacements: [RegExp, string][] = [
    [/\bunauthorized importers?\b/gi, "third-party seller"],
    [/\bconfirmed unauthorized sellers?\b/gi, "third-party seller (authorization unknown)"],
    [/\btermination lists?\b/gi, "channel transition plan"],
    [/\bterminate\b/gi, "transition"],
    [/\bunauthorized resellers?\b/gi, "third-party seller (authorization unknown)"],
    [/\bdozens of brands\b/gi, "reseller-fragmented catalogs"],
    [/we only get paid if we add profit/gi, "engagements are structured around the size of the opportunity"],
    [/the report sells the result;? this call just opens the door\.?/gi, ""],
    // Phase 55 — strip stray markdown bold markers from LLM output.
    // The renderer doesn't process markdown, so `**65%**` shows as
    // `**65%**` with the asterisks visible. Even worse, when the LLM
    // emits `approximately**65%**`, removal without a space produces
    // `approximately65%`. Normalize by inserting a space when bold-
    // adjacent-to-word, then drop the markers entirely.
    [/(\S)\*\*(\S)/g, "$1 **$2"],
    [/(\S)\*\*(\s)/g, "$1**$2"],
    [/\*\*([^*]+?)\*\*/g, "$1"],
    // Collapse any double-spaces produced by the inserts above.
    [/  +/g, " "],
  ];
  for (const [re, rep] of replacements) s = s.replace(re, rep);
  return s.trim();
}

// Phase 58 — Dossier-specific sanitizer + forbidden-phrase regexes were
// removed alongside the Reseller Dossier section.

// ====================================================================
// Helpers
// ====================================================================

const AMAZON_SELLER_ID_RE = /^A[A-Z0-9]{12,13}$/;

function isAmazonSellerId(s: string | null | undefined): boolean {
  return !!s && AMAZON_SELLER_ID_RE.test(s.trim());
}

function friendlySellerName(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  if (!n) return "Unknown 3P seller";
  if (isAmazonSellerId(n)) return `Unknown 3P seller (ID: ${n})`;
  return n;
}

// Phase 58 — sellerInitial / SellerInitialBadge / COUNTRY_NAMES /
// prettyCountry removed; they were only consumed by the deleted
// Reseller Dossier section.

function money(n: number | null | undefined): string {
  if (n == null) return "— not measured";
  return `$${Math.round(Number(n)).toLocaleString("en-US")}`;
}

/**
 * Phase 36 — per-ASIN unit display matching Amazon's monthly badge.
 * Renders "{monthly}/mo (~{annual}/yr)". Falls back to ttm-only when
 * monthly is missing (legacy narrative_json) and to monthly-only when
 * ttm is missing. Returns the not-measured placeholder when both null.
 */
function formatMonthlyAnnualUnits(
  monthly: number | null | undefined,
  ttm: number | null | undefined,
): string {
  const hasMonthly = monthly != null && Number.isFinite(monthly);
  const hasTtm = ttm != null && Number.isFinite(ttm);
  if (!hasMonthly && !hasTtm) return "— not measured";
  const monthlyVal = hasMonthly
    ? monthly!
    : hasTtm
      ? (ttm as number) / 12
      : 0;
  const annualVal = hasTtm
    ? (ttm as number)
    : hasMonthly
      ? (monthly as number) * 12
      : 0;
  const monthlyLabel = Math.round(monthlyVal).toLocaleString("en-US");
  const annualLabel = Math.round(annualVal).toLocaleString("en-US");
  return `${monthlyLabel}/mo (~${annualLabel}/yr)`;
}

function formatShortDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

function formatLongDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

function paragraphs(md: string | null | undefined) {
  if (!md) return null;
  const ps = md.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  return ps.map((p, i) => <p key={i}>{p}</p>);
}

// ====================================================================
// Styles — RCG dark/cream palette, mobile responsive, print-friendly
// ====================================================================

function V2Styles() {
  return (
    <style>{`
      .rv2, .rv2 * { box-sizing: border-box; }
      .rv2 {
        --bg: #0b0b0d;
        --bg-alt: #111114;
        --bg-cream: #f7f5f0;
        --text: #f2f2f3;
        --text-muted: #9b9ba3;
        --gold: #c9a96a;
        --gold-soft: #d8b878;
        --red: #e07b5e;
        --green: #6cb98a;
        --border: rgba(255,255,255,0.08);
        --border-soft: rgba(255,255,255,0.05);
        background: var(--bg);
        color: var(--text);
        min-height: 100vh;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        line-height: 1.6;
        overflow-x: hidden;
        max-width: 100vw;
      }

      .rv2-main {
        max-width: 980px;
        margin: 0 auto;
        padding: 0 clamp(16px, 4vw, 24px);
        width: 100%;
      }
      .rv2-section {
        padding: clamp(40px, 8vw, 64px) 0;
        border-top: 1px solid var(--border-soft);
        position: relative;
      }
      .rv2-section:first-of-type { border-top: none; }
      .rv2-section-alt { background: var(--bg-alt); }
      .rv2-section-cover { padding-top: clamp(48px, 10vw, 96px); }
      .rv2-section-cta { padding: clamp(48px, 10vw, 96px) 0; text-align: center; }
      .rv2-section-head { max-width: 720px; margin-bottom: 28px; }

      .rv2-eyebrow {
        text-transform: uppercase; letter-spacing: 0.14em;
        font-size: 11px; color: var(--gold); font-weight: 600;
      }
      .rv2-source {
        margin-top: 6px; font-size: 12px; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.06em;
      }

      .rv2-h1, .rv2-h2 {
        color: var(--text); margin: 0;
        font-family: 'Fraunces', 'Inter', serif; font-weight: 600;
        letter-spacing: -0.02em;
        overflow-wrap: anywhere;
      }
      .rv2-h1 { font-size: clamp(28px, 6vw, 44px); line-height: 1.15; margin: 18px 0 0; }
      .rv2-h2 { font-size: clamp(22px, 4.5vw, 28px); line-height: 1.2; margin: 8px 0 6px; }

      .rv2-prose { font-size: 16px; line-height: 1.7; color: var(--text); margin: 16px 0; }
      .rv2-prose p { margin: 0 0 14px; }
      .rv2-prose-callout {
        background: rgba(201,169,106,0.06); border-left: 3px solid var(--gold);
        padding: 16px 18px; border-radius: 0 8px 8px 0;
      }
      .rv2-muted { color: var(--text-muted); }
      .rv2-muted-small { color: var(--text-muted); font-size: 12px; }

      /* Header */
      .rv2-hdr {
        position: sticky; top: 0; z-index: 20;
        background: rgba(11,11,13,0.85);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border-bottom: 1px solid var(--border-soft);
      }
      .rv2-hdr-row {
        display: flex; align-items: center; gap: 16px;
        padding: 14px clamp(16px, 4vw, 24px); max-width: 1200px; margin: 0 auto;
        flex-wrap: wrap;
      }
      .rv2-hdr-mid { min-width: 0; word-break: break-word; }
      .rv2-hdr-brand {
        display: inline-flex; align-items: center; gap: 8px;
        text-decoration: none;
      }
      .rv2-hdr-logo { height: 28px; width: auto; }
      .rv2-hdr-wordmark {
        color: var(--text); font-size: 13px; font-weight: 600;
        letter-spacing: 0.02em; white-space: nowrap;
      }
      .rv2-hdr-mid { flex: 1; min-width: 0; }
      .rv2-hdr-title { font-weight: 600; color: var(--text); font-size: 14px; line-height: 1.2; }
      .rv2-hdr-sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
      .rv2-hdr-actions { display: flex; gap: 8px; }

      .rv2-btn {
        display: inline-block; padding: 9px 16px; border-radius: 8px;
        background: rgba(255,255,255,0.05); color: var(--text);
        border: 1px solid var(--border); font-size: 13px; font-weight: 500;
        text-decoration: none; transition: all 0.15s;
      }
      .rv2-btn:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.15); }
      .rv2-btn-primary {
        background: var(--gold); color: #1a1408; border-color: var(--gold); font-weight: 600;
      }
      .rv2-btn-primary:hover { background: var(--gold-soft); border-color: var(--gold-soft); }

      /* Side nav */
      .rv2-sidenav { display: none; }
      @media (min-width: 1180px) {
        .rv2-sidenav {
          display: block;
          position: fixed; left: 24px; top: 96px;
          width: 160px; z-index: 5;
        }
        .rv2-sidenav ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
        .rv2-sidenav a {
          color: var(--text-muted); font-size: 12px;
          text-decoration: none; padding: 4px 8px; display: block;
          border-left: 2px solid var(--border-soft);
        }
        .rv2-sidenav a:hover { color: var(--gold); border-left-color: var(--gold); }
      }

      /* Cover */
      .rv2-cover-meta { margin-top: 12px; min-width: 0; word-break: break-word; }
      .rv2-cover-meta-line { font-size: 14px; }
      .rv2-cover-actions { margin-top: 28px; }

      .rv2-kpi-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 14px; margin-top: 36px;
      }
      .rv2-kpi-grid-2 {
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }
      .rv2-kpi-grid-1 {
        grid-template-columns: 1fr;
        max-width: 560px;
      }

      /* Big stats on the cover */
      .rv2-bigstat {
        padding: 24px; border: 1px solid var(--border);
        background: rgba(255,255,255,0.02); border-radius: 14px;
      }
      .rv2-bigstat-num {
        font-size: clamp(34px, 6vw, 48px); font-weight: 700; letter-spacing: -0.02em;
        color: var(--gold); font-variant-numeric: tabular-nums; line-height: 1.1;
      }
      .rv2-bigstat-lbl {
        font-size: 14px; color: var(--text); margin-top: 6px; font-weight: 600;
      }
      .rv2-bigstat-sub { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

      /* RCG credibility callouts (sprinkled throughout) */
      .rv2-rcg-callout {
        margin: 24px 0;
        padding: 14px 18px;
        border-left: 3px solid var(--gold);
        border-top: 1px solid rgba(201,169,106,0.18);
        border-right: 1px solid rgba(201,169,106,0.18);
        border-bottom: 1px solid rgba(201,169,106,0.18);
        background: linear-gradient(180deg, rgba(201,169,106,0.10), rgba(201,169,106,0.04));
        border-radius: 0 8px 8px 0;
        font-size: 13px; line-height: 1.55;
      }
      .rv2-rcg-callout-kicker {
        font-size: 10px; color: var(--gold);
        text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700;
        margin-bottom: 4px;
      }
      .rv2-rcg-callout-body { color: var(--text); }
      .rv2-rcg-callout-body strong { color: var(--gold-soft); font-weight: 600; }

      /* Reseller bars */
      .rv2-bars {
        display: grid; gap: 10px; margin-top: 4px;
        padding: 16px; border: 1px solid var(--border-soft);
        border-radius: 12px; background: rgba(255,255,255,0.015);
        min-width: 0;
      }
      .rv2-bar-row {
        display: grid;
        grid-template-columns: 22px minmax(0, 180px) minmax(0, 1fr) 56px 80px;
        gap: 10px; align-items: center;
        font-size: 13px;
        min-width: 0;
      }
      .rv2-bar-rank { color: var(--gold); font-weight: 600; }
      .rv2-bar-name {
        color: var(--text);
        min-width: 0;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .rv2-bar-track { height: 14px; background: rgba(255,255,255,0.04); border-radius: 4px; overflow: hidden; min-width: 0; }
      .rv2-bar-fill { height: 100%; background: linear-gradient(90deg, var(--gold), var(--gold-soft)); }
      .rv2-bar-val { text-align: right; color: var(--gold-soft); font-variant-numeric: tabular-nums; }
      .rv2-bar-asins { color: var(--text-muted); font-size: 11px; text-align: right; }

      .rv2-checklist {
        margin-top: 24px; padding: 18px;
        border: 1px solid var(--border-soft); border-radius: 10px;
        background: rgba(255,255,255,0.015);
      }
      .rv2-checklist-title { font-weight: 600; margin-bottom: 10px; font-size: 14px; }
      .rv2-checklist ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
      .rv2-checklist li { display: flex; align-items: center; gap: 10px; font-size: 14px; }
      .rv2-q {
        display: inline-flex; align-items: center; justify-content: center;
        width: 20px; height: 20px; border-radius: 4px;
        background: rgba(224,123,94,0.15); color: var(--red); font-weight: 700;
      }
      /* Phase 41b — circular initial badge replaces the literal "?" */
      .rv2-seller-initial {
        display: inline-flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; border-radius: 50%; flex: 0 0 26px;
        background: rgba(201,169,106,0.15);
        color: var(--gold);
        font-weight: 700; font-size: 12px; letter-spacing: 0.02em;
        border: 1px solid rgba(201,169,106,0.32);
      }
      .rv2-checklist-note { color: var(--text-muted); font-size: 12px; margin-top: 10px; font-style: italic; }

      .rv2-bbpanel {
        margin-top: 24px; padding: 18px;
        border: 1px solid var(--border-soft); border-radius: 10px;
        background: rgba(255,255,255,0.015);
      }
      .rv2-bbpanel-title { font-weight: 600; margin-bottom: 12px; font-size: 14px; }
      .rv2-bbpanel-bar {
        display: flex; height: 36px; border-radius: 6px; overflow: hidden;
      }
      .rv2-bbpanel-brand { background: var(--gold); color: #1a1408; }
      .rv2-bbpanel-reseller { background: var(--red); color: #2a0e0a; }
      .rv2-bbpanel-brand, .rv2-bbpanel-reseller {
        display: flex; align-items: center; justify-content: center;
        font-size: 12px; font-weight: 600; min-width: 0; padding: 0 8px;
      }
      .rv2-bbpanel-note { color: var(--text-muted); font-size: 12px; margin-top: 8px; }

      /* Dossier */
      .rv2-dossier-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px;
      }
      .rv2-fact {
        padding: 14px; border: 1px solid var(--border-soft);
        border-radius: 10px; background: rgba(255,255,255,0.015);
      }
      .rv2-fact-lbl {
        font-size: 11px; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.08em;
      }
      .rv2-fact-val { font-size: 15px; color: var(--text); margin-top: 4px; }

      .rv2-dossier-asins { margin-top: 24px; }
      .rv2-dossier-subtitle {
        font-size: 12px; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px;
      }
      .rv2-dossier-asins ul { list-style: none; padding: 0; margin: 0; }
      .rv2-dossier-asins li {
        display: grid; grid-template-columns: 110px minmax(0, 1fr) 80px;
        gap: 12px; align-items: baseline;
        padding: 10px 0; border-bottom: 1px solid var(--border-soft);
        font-size: 14px;
        min-width: 0;
      }
      .rv2-asin {
        font-family: ui-monospace, SFMono-Regular, monospace;
        color: var(--gold); font-size: 12px; font-weight: 600;
        overflow-wrap: anywhere;
        word-break: break-all;
      }
      .rv2-asin-title { color: var(--text); min-width: 0; overflow-wrap: anywhere; }
      .rv2-asin-price { text-align: right; color: var(--gold-soft); font-variant-numeric: tabular-nums; }

      /* Top products / ASIN cards */
      .rv2-asin-scores {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 14px; margin-top: 16px;
      }
      .rv2-asin-scores-wide {
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }
      .rv2-asincard {
        padding: 16px; border: 1px solid var(--border-soft);
        border-radius: 10px; background: rgba(255,255,255,0.015);
        display: flex; flex-direction: column; gap: 10px;
      }
      .rv2-asincard-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
      .rv2-asincard-title { font-size: 13px; color: var(--text); line-height: 1.45; min-height: 32px; }
      .rv2-asincard-econ {
        display: grid; gap: 4px;
        padding: 10px 12px; border-radius: 8px;
        background: rgba(201,169,106,0.06);
        border: 1px solid rgba(201,169,106,0.18);
      }
      .rv2-asincard-econ-row {
        display: flex; justify-content: space-between; align-items: baseline;
        gap: 8px; font-size: 13px;
      }
      .rv2-asincard-econ-lbl { color: var(--text-muted); }
      .rv2-asincard-econ-val { color: var(--gold-soft); font-weight: 600; font-variant-numeric: tabular-nums; }
      .rv2-asincard-health { display: grid; gap: 4px; }
      .rv2-asincard-health-lbl {
        font-size: 11px; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.06em;
        display: flex; justify-content: space-between;
      }
      .rv2-asincard-health-val { color: var(--gold); font-weight: 700; letter-spacing: 0; text-transform: none; }
      .rv2-asincard-bar { height: 6px; background: rgba(255,255,255,0.04); border-radius: 3px; overflow: hidden; }
      .rv2-asincard-bar-fill { height: 100%; background: var(--gold); }
      .rv2-asincard-facts {
        display: flex; flex-wrap: wrap; gap: 6px;
      }
      .rv2-asincard-fact {
        display: inline-flex; align-items: baseline; gap: 4px;
        padding: 3px 8px; border-radius: 6px;
        background: rgba(255,255,255,0.04);
        border: 1px solid var(--border-soft);
        font-size: 11px;
      }
      .rv2-asincard-fact-lbl { color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-size: 10px; }
      .rv2-asincard-fact-val { color: var(--gold-soft); font-variant-numeric: tabular-nums; font-weight: 600; }

      .rv2-callouts {
        margin-top: 24px; padding: 16px;
        border: 1px solid var(--border-soft); border-radius: 10px;
        background: rgba(255,255,255,0.015);
      }
      .rv2-callouts ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
      .rv2-callouts li {
        padding: 10px 14px; border-left: 2px solid var(--gold);
        background: rgba(201,169,106,0.06); color: var(--text); font-size: 14px;
        border-radius: 0 6px 6px 0;
      }
      .rv2-block-title {
        font-size: 12px; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 10px;
      }

      /* Tables */
      .rv2-table-wrap {
        width: 100%;
        max-width: 100%;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        box-sizing: border-box;
      }
      .rv2-table-wrap > .rv2-table { min-width: 480px; }
      .rv2-table {
        width: 100%; border-collapse: collapse; font-size: 14px;
        margin: 8px 0;
      }
      .rv2-table th, .rv2-table td {
        text-align: left; padding: 10px 12px;
        border-bottom: 1px solid var(--border-soft);
        overflow-wrap: anywhere;
      }
      .rv2-table th {
        font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
        color: var(--text-muted); font-weight: 600;
      }
      .rv2-tag {
        display: inline-block; padding: 1px 6px; margin-left: 6px;
        border-radius: 4px; background: var(--gold); color: #1a1408;
        font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700;
      }
      .rv2-tag-edit {
        background: rgba(108,185,138,0.12); color: var(--green);
        margin-left: 0; padding: 2px 8px; font-weight: 600;
      }
      .rv2-num { text-align: right; font-variant-numeric: tabular-nums; color: var(--gold-soft); }
      .rv2-math-total td { font-weight: 700; color: var(--text); border-top: 1px solid var(--border); }
      .rv2-math-total .rv2-num { color: var(--gold); }

      /* Revenue actual/estimate badges */
      .rv2-rev-badge {
        display: inline-block; margin-left: 8px;
        padding: 2px 8px; border-radius: 999px;
        font-size: 10px; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.08em;
        vertical-align: middle;
      }
      .rv2-rev-badge-actual {
        background: rgba(108,185,138,0.15); color: var(--green);
        border: 1px solid rgba(108,185,138,0.4);
      }
      .rv2-rev-badge-est {
        background: rgba(224,170,76,0.15); color: var(--gold-soft);
        border: 1px solid rgba(224,170,76,0.4);
      }
      .rv2-rev-badge-confirmed {
        background: rgba(108,185,138,0.15); color: var(--green);
        border: 1px solid rgba(108,185,138,0.4);
      }
      .rv2-rev-badge-variation {
        background: rgba(135,160,210,0.14); color: #a8c0ea;
        border: 1px solid rgba(135,160,210,0.36);
      }
      .rv2-asincard-badges {
        display: inline-flex; flex-wrap: wrap; gap: 4px;
        justify-content: flex-end;
      }

      /* Phase 35 — Methodology & Audit Scope section */
      .rv2-section-method { }
      .rv2-method-strip {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
        margin: 8px 0 24px;
      }
      .rv2-method-stat {
        padding: 14px 16px;
        border: 1px solid var(--border-soft);
        border-radius: 10px;
        background: rgba(255,255,255,0.02);
        min-width: 0;
      }
      .rv2-method-stat-lbl {
        font-size: 10px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .rv2-method-stat-val {
        font-size: 16px;
        color: var(--gold-soft);
        margin-top: 6px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        line-height: 1.25;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .rv2-method-card {
        margin-top: 14px;
        padding: 18px 20px;
        border: 1px solid var(--border-soft);
        border-radius: 10px;
        background: rgba(255,255,255,0.015);
      }
      .rv2-method-card-title {
        font-weight: 700;
        color: var(--text);
        font-size: 14px;
        margin-bottom: 10px;
      }
      .rv2-method-card-body {
        margin: 0;
        font-size: 14px;
        line-height: 1.6;
        color: var(--text);
      }
      .rv2-method-bullets {
        list-style: disc;
        padding-left: 20px;
        margin: 0;
        display: grid;
        gap: 8px;
      }
      .rv2-method-bullets li {
        font-size: 14px;
        line-height: 1.6;
        color: var(--text);
      }
      .rv2-method-bullets strong { color: var(--text); }
      .rv2-method-bullets code {
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: 12.5px;
        color: var(--gold-soft);
        background: rgba(201,169,106,0.08);
        padding: 1px 6px;
        border-radius: 4px;
      }
      .rv2-method-disclaimer {
        margin-top: 16px;
        padding: 16px 20px;
        border-left: 3px solid var(--gold);
        background: rgba(201,169,106,0.08);
        border-radius: 0 8px 8px 0;
      }
      .rv2-method-disclaimer-title {
        font-weight: 700;
        color: var(--gold-soft);
        font-size: 14px;
        margin-bottom: 6px;
      }
      .rv2-method-disclaimer-body {
        margin: 0;
        font-size: 14px;
        line-height: 1.65;
        color: var(--text);
      }
      .rv2-method-disclaimer-body strong { color: var(--gold-soft); font-weight: 600; }
      .rv2-method-sources {
        margin-top: 18px;
        font-size: 12px;
        color: var(--text-muted);
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: baseline;
      }
      .rv2-method-sources-sep { color: var(--border); }

      @media (max-width: 720px) {
        .rv2-method-strip { grid-template-columns: 1fr 1fr; }
      }
      @media (max-width: 480px) {
        .rv2-method-strip { grid-template-columns: 1fr; }
      }

      /* Phase 31 — methodology disclosure for variation attribution */
      .rv2-method-panel {
        margin-top: 24px;
        padding: 14px 18px;
        border-left: 3px solid var(--gold);
        background: rgba(201,169,106,0.05);
        border-radius: 0 8px 8px 0;
        font-size: 13px;
        line-height: 1.6;
      }
      .rv2-method-kicker {
        font-size: 10px; color: var(--gold);
        text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700;
        margin-bottom: 6px;
      }
      .rv2-method-body {
        color: var(--text);
        margin: 0;
      }
      .rv2-method-body strong { color: var(--gold-soft); font-weight: 600; }

      /* Five-step plan */
      .rv2-fivestep {
        display: grid; gap: 14px; margin-top: 16px;
      }
      .rv2-step {
        padding: 20px; border: 1px solid var(--border-soft);
        border-radius: 12px; background: rgba(255,255,255,0.015);
      }
      .rv2-step-head {
        display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px;
        flex-wrap: wrap;
      }
      .rv2-step-num {
        font-size: 11px; color: var(--gold);
        text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700;
      }
      .rv2-step-title {
        font-size: 17px; color: var(--text); font-weight: 600;
        font-family: 'Fraunces', 'Inter', serif;
      }
      .rv2-step-body { font-size: 14.5px; color: var(--text); margin: 0; line-height: 1.6; }
      .rv2-plan-closing {
        margin-top: 20px; padding: 16px 20px;
        border-left: 3px solid var(--gold);
        background: rgba(201,169,106,0.06);
        border-radius: 0 8px 8px 0;
        font-style: italic;
      }

      /* Legacy 90-day plan */
      .rv2-plan-grid {
        display: grid; grid-template-columns: repeat(3, 1fr);
        gap: 14px; margin-top: 16px;
      }
      .rv2-plan-col {
        padding: 18px; border: 1px solid var(--border-soft);
        border-radius: 10px; background: rgba(255,255,255,0.015);
      }
      .rv2-plan-label {
        font-size: 11px; color: var(--gold);
        text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;
        margin-bottom: 10px;
      }
      .rv2-plan-col ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
      .rv2-plan-col li {
        font-size: 13px; line-height: 1.5; padding-left: 14px; position: relative;
      }
      .rv2-plan-col li::before {
        content: ""; position: absolute; left: 0; top: 8px;
        width: 6px; height: 6px; border-radius: 50%; background: var(--gold);
      }

      /* Bio + CTA */
      .rv2-cta-prose { max-width: 620px; margin: 16px auto 24px; color: var(--text-muted); }
      .rv2-cta-actions {
        display: inline-flex; gap: 12px; flex-wrap: wrap; justify-content: center;
      }
      .rv2-bio {
        max-width: 640px; margin: 40px auto 0;
        padding: 22px; border: 1px solid var(--border-soft);
        border-radius: 12px; background: rgba(255,255,255,0.015);
        text-align: left;
      }
      .rv2-bio-name {
        font-weight: 600; color: var(--text); font-size: 15px; margin-bottom: 8px;
      }
      .rv2-bio-body { font-size: 14px; color: var(--text); line-height: 1.65; margin: 0 0 12px; }
      .rv2-bio-body strong { color: var(--gold-soft); font-weight: 600; }
      .rv2-cta-contact { font-size: 14px; color: var(--text); margin: 0; }
      .rv2-cta-contact a { color: var(--gold); text-decoration: none; }

      /* Footer */
      .rv2-footer {
        padding: 28px 24px; border-top: 1px solid var(--border-soft);
        color: var(--text-muted); font-size: 12px; text-align: center;
      }

      /* Mobile */
      @media (max-width: 720px) {
        .rv2-bar-row {
          grid-template-columns: 22px minmax(0, 1fr) 60px;
          row-gap: 4px;
        }
        .rv2-bar-asins, .rv2-bar-track {
          grid-column: 1 / -1;
          text-align: left;
        }
        .rv2-plan-grid { grid-template-columns: 1fr; }
        .rv2-dossier-asins li { grid-template-columns: 1fr; row-gap: 4px; }
        .rv2-dossier-asins .rv2-asin-price { text-align: left; }
        .rv2-bbpanel-bar {
          flex-direction: column;
          height: auto;
        }
        .rv2-bbpanel-brand, .rv2-bbpanel-reseller {
          width: 100% !important;
          min-height: 32px;
          padding: 6px 8px;
        }
        .rv2-dossier-grid { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
        .rv2-asin-scores, .rv2-asin-scores-wide { grid-template-columns: 1fr; }
        .rv2-kpi-grid, .rv2-kpi-grid-2 { grid-template-columns: 1fr; }
        .rv2-hdr-actions .rv2-btn { padding: 7px 12px; font-size: 12px; }
        .rv2-hdr-wordmark { display: none; }
        .rv2-section-head { margin-bottom: 20px; }
        .rv2-prose { font-size: 15px; }
      }
      @media (max-width: 480px) {
        .rv2-bar-row { grid-template-columns: 20px minmax(0, 1fr) 56px; }
        .rv2-dossier-grid { grid-template-columns: 1fr; }
        .rv2-hdr-row { padding: 12px 16px; }
        .rv2-hdr-mid { flex-basis: 100%; }
      }

      /* Print */
      @media print {
        .rv2 {
          background: #fff !important; color: #111 !important;
        }
        .rv2-hdr, .rv2-sidenav, .rv2-cta-actions { display: none !important; }
        .rv2-section { page-break-inside: avoid; padding: 24px 0; border-top: 1px solid #ddd; }
        .rv2-section-alt { background: #fafafa !important; }
        .rv2-h1, .rv2-h2, .rv2-prose, .rv2-fact-val, .rv2-asin-title,
        .rv2-bar-name, .rv2-table td, .rv2-table th, .rv2-callouts li, .rv2-plan-col li,
        .rv2-step-title, .rv2-step-body, .rv2-bio-name, .rv2-bio-body, .rv2-bigstat-lbl,
        .rv2-cover-meta-line, .rv2-bbpanel-brand, .rv2-bbpanel-reseller, .rv2-rcg-callout-body {
          color: #111 !important;
        }
        .rv2-eyebrow, .rv2-source, .rv2-bigstat-num, .rv2-asin, .rv2-bar-val,
        .rv2-asincard-health-val, .rv2-tag, .rv2-plan-label, .rv2-step-num, .rv2-rcg-callout-kicker,
        .rv2-num, .rv2-asincard-bar-fill, .rv2-bar-fill, .rv2-bar-rank, .rv2-asincard-econ-val {
          color: #8a6d2e !important;
        }
        .rv2-muted, .rv2-fact-lbl, .rv2-asincard-note, .rv2-checklist-note, .rv2-bbpanel-note,
        .rv2-block-title, .rv2-dossier-subtitle, .rv2-muted-small, .rv2-bigstat-sub {
          color: #555 !important;
        }
        .rv2-bigstat, .rv2-fact, .rv2-asincard, .rv2-plan-col, .rv2-step, .rv2-bars,
        .rv2-checklist, .rv2-bbpanel, .rv2-callouts, .rv2-prose-callout, .rv2-rcg-callout, .rv2-bio,
        .rv2-method-panel, .rv2-method-stat, .rv2-method-card, .rv2-method-disclaimer {
          background: #fafafa !important; border-color: #ddd !important;
        }
        .rv2-method-card-title, .rv2-method-card-body, .rv2-method-bullets li,
        .rv2-method-disclaimer-body { color: #111 !important; }
        .rv2-method-stat-val, .rv2-method-disclaimer-title { color: #8a6d2e !important; }
        .rv2-method-stat-lbl, .rv2-method-sources { color: #555 !important; }
        .rv2-method-body { color: #111 !important; }
        .rv2-method-kicker { color: #8a6d2e !important; }
        .rv2-bar-fill { background: #c9a96a !important; }
        .rv2-bbpanel-brand { background: #c9a96a !important; }
        .rv2-bbpanel-reseller { background: #d6d3cb !important; }
      }

      /* Phase 40 — new executive sections */
      .rv2-cover-subhead {
        max-width: 800px;
        font-size: 16px;
        color: var(--text-muted);
        margin: 18px 0 8px;
      }
      .rv2-cover-valueline {
        max-width: 800px;
        font-size: 15px;
        color: var(--text);
        margin: 0 0 24px;
      }
      .rv2-cover-secondary {
        margin-top: 18px;
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
      }
      .rv2-cover-secondary-stat {
        display: inline-flex;
        flex-direction: column;
        gap: 4px;
        padding: 10px 16px;
        border: 1px solid var(--border-soft);
        border-radius: 10px;
        background: rgba(255,255,255,0.02);
      }
      .rv2-cover-secondary-lbl {
        font-size: 11px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .rv2-cover-secondary-val {
        font-size: 20px;
        font-weight: 700;
        color: var(--gold);
        font-variant-numeric: tabular-nums;
        display: inline-flex;
        gap: 10px;
        align-items: center;
      }
      .rv2-kpi-grid-3 {
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }

      /* Confidence pills */
      .rv2-conf {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 10px;
        border-radius: 999px;
        font-size: 10.5px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        border: 1px solid var(--border-soft);
        background: rgba(255,255,255,0.03);
        color: var(--text-muted);
      }
      .rv2-conf-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--text-muted);
      }
      .rv2-conf-high { color: #6cb98a; border-color: rgba(108,185,138,0.35); }
      .rv2-conf-high .rv2-conf-dot { background: #6cb98a; }
      .rv2-conf-med { color: var(--gold-soft); border-color: rgba(216,184,120,0.35); }
      .rv2-conf-med .rv2-conf-dot { background: var(--gold-soft); }
      .rv2-conf-low { color: var(--red); border-color: rgba(224,123,94,0.35); }
      .rv2-conf-low .rv2-conf-dot { background: var(--red); }
      .rv2-conf-assumption { color: #a8c0ea; border-color: rgba(135,160,210,0.36); }
      .rv2-conf-assumption .rv2-conf-dot { background: #a8c0ea; }
      .rv2-bigstat-conf { margin-top: 10px; }

      /* Executive summary box */
      .rv2-summary-box {
        padding: 22px 26px;
        border: 1px solid var(--border-soft);
        border-radius: 14px;
        background: linear-gradient(180deg, rgba(201,169,106,0.08), rgba(201,169,106,0.02));
        margin-top: 8px;
      }
      .rv2-summary-bullets {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: 8px;
      }
      .rv2-summary-bullets li {
        font-size: 15px;
        color: var(--text);
        padding-left: 22px;
        position: relative;
        line-height: 1.55;
      }
      .rv2-summary-bullets li::before {
        content: "";
        position: absolute;
        left: 4px;
        top: 8px;
        width: 8px;
        height: 8px;
        background: var(--gold);
        border-radius: 50%;
      }
      .rv2-summary-bullets strong { color: var(--gold-soft); }
      .rv2-summary-close {
        margin: 16px 0 0;
        padding-top: 14px;
        border-top: 1px solid var(--border-soft);
        color: var(--text);
        font-style: italic;
        font-size: 14px;
      }

      /* Channel control cards */
      .rv2-channel-cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 12px;
        margin: 18px 0;
      }
      .rv2-channel-card {
        padding: 14px 16px;
        border: 1px solid var(--border-soft);
        border-radius: 10px;
        background: rgba(255,255,255,0.015);
      }
      .rv2-channel-card-good { border-color: rgba(108,185,138,0.35); background: rgba(108,185,138,0.06); }
      .rv2-channel-card-warn { border-color: rgba(224,123,94,0.35); background: rgba(224,123,94,0.06); }
      .rv2-channel-card-lbl {
        font-size: 11px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .rv2-channel-card-val {
        font-size: 20px;
        font-weight: 700;
        color: var(--gold);
        margin-top: 6px;
        font-variant-numeric: tabular-nums;
        word-break: break-word;
      }
      .rv2-channel-card-sub { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
      .rv2-channel-card-conf { margin-top: 8px; }

      /* Channel block + tone banners (reseller reality) */
      .rv2-channel-block {
        margin-top: 16px;
        padding: 16px;
        border: 1px solid var(--border-soft);
        border-radius: 10px;
        background: rgba(255,255,255,0.015);
      }
      .rv2-channel-good {
        background: rgba(108,185,138,0.06);
        border-color: rgba(108,185,138,0.25);
      }
      .rv2-channel-block-title {
        font-weight: 700;
        font-size: 14px;
        color: var(--text);
        margin-bottom: 8px;
      }
      .rv2-channel-good .rv2-channel-block-title { color: #8edca6; }
      .rv2-channel-sub { font-size: 13px; color: var(--text-muted); margin: 0 0 12px; }
      .rv2-bar-fill-good {
        background: linear-gradient(90deg, #6cb98a, #8edca6) !important;
      }
      .rv2-banner {
        margin: 12px 0 18px;
        padding: 12px 16px;
        border-radius: 10px;
        font-size: 14px;
        line-height: 1.6;
      }
      .rv2-banner-good {
        background: rgba(108,185,138,0.08);
        border: 1px solid rgba(108,185,138,0.35);
        color: #cfe8d8;
      }
      .rv2-banner-warn {
        background: rgba(216,184,120,0.10);
        border: 1px solid rgba(216,184,120,0.35);
        color: #f5e7c1;
      }

      /* 4-bucket buy-box bar */
      .rv2-bbpanel-bar-4 {
        display: flex;
        height: 36px;
        border-radius: 6px;
        overflow: hidden;
        background: rgba(255,255,255,0.04);
      }
      .rv2-bbpanel-seg {
        display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 600; min-width: 0; padding: 0 6px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .rv2-bbpanel-brand { background: #6cb98a; color: #0d2117; }
      .rv2-bbpanel-authorized { background: var(--gold); color: #1a1408; }
      .rv2-bbpanel-amazon { background: #87a0d2; color: #0c1322; }
      .rv2-bbpanel-reseller { background: var(--red); color: #2a0e0a; }
      .rv2-bbpanel-empty { background: rgba(255,255,255,0.06); color: var(--text-muted); }
      .rv2-bbpanel-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 10px;
        font-size: 11px;
        color: var(--text-muted);
      }
      .rv2-bbpanel-legend-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .rv2-bbpanel-swatch {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 2px;
      }

      /* Customer-experience list + transition + positioning */
      .rv2-cx-list {
        margin-top: 18px;
        padding: 16px 20px;
        border: 1px solid var(--border-soft);
        border-radius: 10px;
        background: rgba(255,255,255,0.015);
      }
      .rv2-cx-list-title {
        font-weight: 700;
        font-size: 13px;
        color: var(--text);
        margin-bottom: 10px;
      }
      .rv2-cx-list ul {
        list-style: disc;
        padding-left: 20px;
        margin: 0;
        display: grid;
        gap: 6px;
      }
      .rv2-cx-list li {
        font-size: 14px;
        color: var(--text);
        line-height: 1.55;
      }

      .rv2-positioning {
        margin-top: 14px;
        padding: 14px 18px;
        border-left: 3px solid var(--gold);
        background: rgba(201,169,106,0.06);
        border-radius: 0 8px 8px 0;
      }
      .rv2-positioning ul {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: 6px;
      }
      .rv2-positioning li {
        font-size: 13.5px;
        color: var(--text);
        padding-left: 18px;
        position: relative;
      }
      .rv2-positioning li::before {
        content: "→";
        position: absolute;
        left: 0;
        color: var(--gold);
      }

      /* Phase 44 — Diversified Hospitality case study */
      .rv2-section-case-study { padding: clamp(36px, 7vw, 56px) 0; }
      .rv2-case-study-link {
        color: var(--gold);
        text-decoration: underline;
        text-underline-offset: 3px;
        font-weight: 500;
      }
      .rv2-case-study-link:hover { color: var(--gold-soft); }
      .rv2-case-study-details {
        margin-top: 8px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: rgba(255,255,255,0.02);
        scroll-margin-top: 96px;
      }
      .rv2-case-study-summary {
        padding: 14px 20px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        list-style: none;
      }
      .rv2-case-study-summary::-webkit-details-marker { display: none; }
      .rv2-case-study-summary::after {
        content: "▾";
        color: var(--gold);
        font-size: 14px;
        transition: transform 0.15s ease;
      }
      .rv2-case-study-details[open] .rv2-case-study-summary::after {
        transform: rotate(180deg);
      }
      .rv2-case-study-summary-label {
        font-weight: 600;
        color: var(--text);
        font-size: 14px;
      }
      .rv2-case-study-summary-hint {
        color: var(--text-muted);
        font-size: 12px;
        margin-left: auto;
        margin-right: 8px;
      }
      .rv2-case-study-details[open] .rv2-case-study-summary-hint {
        display: none;
      }
      .rv2-case-study-body {
        padding: 8px 20px 24px;
        border-top: 1px solid var(--border-soft);
      }
      .rv2-case-study-preface {
        font-style: italic;
        color: var(--text-muted);
      }
      .rv2-h3, .rv2-case-study-h3 {
        font-family: 'Fraunces', 'Inter', serif;
        font-weight: 600;
        font-size: 18px;
        color: var(--gold-soft);
        margin: 22px 0 6px;
        letter-spacing: -0.01em;
      }
      .rv2-case-study-list {
        list-style: disc;
        padding-left: 22px;
        margin: 6px 0 12px;
        display: grid;
        gap: 4px;
      }
      .rv2-case-study-list li { font-size: 15px; line-height: 1.6; }
      .rv2-case-study-steps {
        list-style: none;
        padding: 0;
        margin: 8px 0 12px;
        display: grid;
        gap: 12px;
      }
      .rv2-case-study-step-title {
        font-weight: 600;
        color: var(--text);
        font-size: 15px;
        margin-bottom: 4px;
      }
      .rv2-case-study-step-body {
        font-size: 15px;
        line-height: 1.65;
        color: var(--text);
      }
      .rv2-case-study-footnote {
        margin-top: 18px;
        padding-top: 12px;
        border-top: 1px dashed var(--border-soft);
      }
      /* Auto-expand the details element when the user lands on the
         section anchor via an in-page snippet link. */
      .rv2-section-case-study:target .rv2-case-study-details {
        border-color: var(--gold);
      }
      .rv2-section-case-study:target .rv2-case-study-details:not([open]) .rv2-case-study-body {
        display: block;
      }

      /* Phase 59 — Reseller Reality expandable disclosure (web only).
         Visual treatment mirrors the case-study + math-card expand. */
      .rv2-reseller-reality-details {
        margin-top: 18px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: rgba(255,255,255,0.02);
      }
      .rv2-reseller-reality-summary {
        padding: 14px 20px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        list-style: none;
      }
      .rv2-reseller-reality-summary::-webkit-details-marker { display: none; }
      .rv2-reseller-reality-summary::after {
        content: "▾";
        color: var(--gold);
        font-size: 14px;
        transition: transform 0.15s ease;
      }
      .rv2-reseller-reality-details[open] .rv2-reseller-reality-summary::after {
        transform: rotate(180deg);
      }
      .rv2-reseller-reality-summary-label {
        font-weight: 600;
        color: var(--text);
        font-size: 14px;
      }
      .rv2-reseller-reality-summary-hint {
        color: var(--text-muted);
        font-size: 12px;
        margin-left: auto;
        margin-right: 8px;
      }
      .rv2-reseller-reality-details[open] .rv2-reseller-reality-summary-hint {
        display: none;
      }
      .rv2-reseller-reality-body {
        padding: 8px 20px 24px;
        border-top: 1px solid var(--border-soft);
      }

      /* Disclaimer */
      .rv2-section-disclaimer {
        padding: 32px 0 48px;
      }
      .rv2-disclaimer {
        max-width: 820px;
        margin: 0 auto;
        padding: 16px 20px;
        border: 1px dashed var(--border-soft);
        border-radius: 10px;
        background: rgba(255,255,255,0.015);
        color: var(--text-muted);
        font-size: 12.5px;
        line-height: 1.6;
      }
      .rv2-disclaimer-title {
        font-weight: 700;
        color: var(--text);
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-bottom: 8px;
      }
      .rv2-disclaimer p { margin: 0 0 8px; }
      .rv2-disclaimer p:last-child { margin: 0; }

      @media print {
        .rv2-case-study-details[open] .rv2-case-study-summary::after,
        .rv2-case-study-summary::after { display: none; }
        .rv2-case-study-details { border-color: #ddd !important; }
        .rv2-case-study-summary-hint { display: none !important; }
        .rv2-case-study-body { display: block !important; }
        .rv2-summary-box, .rv2-channel-card, .rv2-channel-block, .rv2-cx-list,
        .rv2-positioning, .rv2-disclaimer, .rv2-cover-secondary-stat {
          background: #fafafa !important; border-color: #ddd !important;
        }
        .rv2-conf, .rv2-banner, .rv2-banner-good, .rv2-banner-warn,
        .rv2-summary-bullets li, .rv2-summary-close, .rv2-cx-list li,
        .rv2-channel-card-val, .rv2-cover-secondary-val, .rv2-channel-block-title,
        .rv2-disclaimer p, .rv2-positioning li {
          color: #111 !important;
        }
        .rv2-bbpanel-brand { background: #6cb98a !important; }
        .rv2-bbpanel-authorized { background: #c9a96a !important; }
        .rv2-bbpanel-amazon { background: #87a0d2 !important; }
        .rv2-bbpanel-reseller { background: #d6d3cb !important; }
      }
    `}</style>
  );
}
