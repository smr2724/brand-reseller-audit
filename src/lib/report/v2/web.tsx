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

  // Phase 41a — short / tight-channel layout. Triggered when the
  // persisted classification snapshot shows reseller share < 5% AND
  // brand-owned + authorized share >= 90%. `derived.is_tight_channel`
  // already requires `has_snapshot`, so legacy reports without a
  // classification snapshot fall through to the long opportunity layout
  // (or the legacy `diy_fit` rendering, if present).
  const isTightShort = derived.is_tight_channel;

  // Phase 24 — legacy diy_fit mode. Older reports without a
  // classification snapshot may still be tagged `diy_fit` by
  // `decideReportMode`; we keep the legacy DIY rendering path for them
  // so existing public URLs render unchanged.
  const isLegacyDiy =
    !isTightShort && narrative.report_mode === "diy_fit";

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
              callHref={callHref}
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
            {/* 7. Three concrete steps to seal the leak yourself */}
            <SectionDiySteps narrative={narrative} brand={brand} />
            {/* 8. Soft CTA */}
            <SectionDiyFooterCta
              narrative={narrative}
              brand={brand}
              pdfUrl={pdfUrl}
              callHref={callHref}
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
            <SectionResellerDossier narrative={narrative} derived={derived} />
            <SectionTopProducts narrative={narrative} />
            <SectionDiySteps narrative={narrative} brand={brand} />
            <SectionDiyFooterCta narrative={narrative} brand={brand} pdfUrl={pdfUrl} callHref={callHref} />
            <SectionMethodology narrative={narrative} brand={brand} />
            <SectionDisclaimer />
          </>
        ) : (
          <>
            {/* 1. Hero / Executive Punch */}
            <SectionCover
              narrative={narrative}
              brand={brand}
              callHref={callHref}
              derived={derived}
              confRevenue={confRevenue}
              confSellerControl={confSellerControl}
              confProfit={confProfit}
              confValue={confValue}
            />
            {/* 2. Executive Summary Box */}
            <SectionExecutiveSummary
              narrative={narrative}
              brand={brand}
              derived={derived}
            />
            {/* 3. Channel Control Problem */}
            <SectionChannelControl
              narrative={narrative}
              brand={brand}
              bundle={bundle}
              derived={derived}
              confSellerControl={confSellerControl}
            />
            {/* 4. Customer Experience Problem */}
            <SectionCustomerExperience brand={brand} />
            {/* 5. Evidence — top products surfaces ASINs in the main body
                before the dossier dives into a single seller. Per the
                executive spec, the reader should see the top 5–10 ASINs
                right after CX, then the reseller landscape, then the
                single-seller dossier. */}
            <SectionTopProducts narrative={narrative} />
            <SectionResellerReality narrative={narrative} bundle={bundle} derived={derived} />
            <SectionResellerDossier narrative={narrative} derived={derived} />
            {/* 6. Financial Opportunity (line-by-line bridge) */}
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
            {/* 7. Safe Transition Plan */}
            <SectionSafeTransition />
            {/* 8. Five-Step Framework */}
            <SectionPlan narrative={narrative} derived={derived} />
            {/* 9. Why Steve / RMG */}
            <SectionWhySteveRolle />
            {/* 9.5 Phase 44 — Diversified Hospitality case study (opportunity-only) */}
            <SectionCaseStudyDiversifiedHospitality brand={brand} />
            <SectionFooterCta narrative={narrative} brand={brand} pdfUrl={pdfUrl} callHref={callHref} />
            {/* 10. Methodology Appendix (collapsible, low) */}
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
            ["s-dossier", "Reseller dossier"],
            ["s-products", "Top products"],
            ["s-diy", "3 steps to wrap this up"],
            ["s-cta", "Want help later?"],
          ]
        : [
            ["s-cover", "Executive punch"],
            ["s-summary", "Executive summary"],
            ["s-channel-control", "Channel control"],
            ["s-cx", "Customer experience"],
            ["s-products", "Top products"],
            ["s-reseller-reality", "Reseller reality"],
            ["s-dossier", "Reseller dossier"],
            ["s-math", "Financial opportunity"],
            ["s-transition", "Safe transition"],
            ["s-plan", "Five-step framework"],
            ["s-why", "Why Steve / RMG"],
            [CASE_STUDY_ANCHOR_ID, "Case study"],
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
  callHref,
  derived,
  confRevenue,
  confSellerControl,
  confProfit,
  confValue,
}: {
  narrative: NarrativeV2;
  brand: PublicReportV2Brand;
  callHref: string;
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
  const subheadline = renderHeroSubheadline({
    brandName: brand.name,
    auditScope: narrative.audit_scope ?? null,
    topReseller: pickTopReseller(narrative, derived),
    topResellerSharePct: pickTopResellerShare(narrative, derived),
  });
  const valueLine = renderValueLine({
    profit,
    value,
    ebitdaMultiple,
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
      <p className="rv2-prose rv2-cover-subhead">{subheadline}</p>
      <p className="rv2-prose rv2-cover-valueline">{valueLine}</p>

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

      <div className="rv2-cover-actions">
        <a className="rv2-btn rv2-btn-primary" href={callHref}>
          Book a 15-minute review
        </a>
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

function renderHeroSubheadline(args: {
  brandName: string;
  auditScope: NarrativeV2["audit_scope"] | null;
  topReseller: string | null;
  topResellerSharePct: number | null;
}): string {
  const totalAsins = args.auditScope?.asins_found_total ?? null;
  const includedAsins = args.auditScope?.asins_included_count ?? null;
  const reseller = args.topReseller;
  const resellerShare =
    args.topResellerSharePct != null
      ? `${Math.round(args.topResellerSharePct * 100)}%`
      : null;

  if (totalAsins != null && includedAsins != null && reseller && resellerShare) {
    return `Our analysis found ${totalAsins.toLocaleString("en-US")} ASINs associated with ${args.brandName}, with ${includedAsins.toLocaleString("en-US")} included in this audit. Across those listings, third-party sellers appear to control the Amazon channel, including ${reseller}, which accounts for roughly ${resellerShare} of observed buy-box activity.`;
  }
  if (reseller && resellerShare) {
    return `Across the audited listings, third-party sellers appear to control the Amazon channel, including ${reseller}, which accounts for roughly ${resellerShare} of observed buy-box activity.`;
  }
  return `Across the audited listings, third-party sellers appear to be involved in the Amazon channel for ${args.brandName}.`;
}

function renderValueLine(args: {
  profit: number | null;
  value: number | null;
  ebitdaMultiple: string;
}): string {
  if (args.profit != null && args.value != null) {
    return `Based on conservative marketplace estimates, bringing this channel under brand control could create approximately ${money(args.profit)} in annual profit recapture and up to ${money(args.value)} in business value at a ${args.ebitdaMultiple}× EBITDA multiple.`;
  }
  return `Based on conservative marketplace estimates, bringing this channel under brand control could create meaningful annual profit recapture and business value — see the financial bridge below.`;
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

// ====================================================================
// Section 3 — Reseller Dossier
// ====================================================================

function SectionResellerDossier({
  narrative,
  derived,
}: {
  narrative: NarrativeV2;
  derived: DerivedSnapshot;
}) {
  const d = narrative.reseller_dossier;
  // Phase 40 Goal A3 — filter the dossier subject through the snapshot:
  // sellers classified brand_owned/authorized/amazon must NOT appear.
  // If the dossier subject is a brand-controlled seller, swallow the
  // dossier and render the tight-channel acknowledgement.
  const dossierIsReseller = (() => {
    if (!d) return false;
    const synthetic: ResellerRow = {
      rank: 0,
      seller_name: d.seller_name,
      share_pct: d.share_pct ?? null,
      asins_won: d.asins_won ?? null,
      is_fba: d.is_fba ?? null,
      country: d.country ?? null,
    };
    const cls = lookupClassification(derived, synthetic);
    if (cls === "reseller") return true;
    if (cls == null) return true; // Legacy: assume reseller by default.
    return false;
  })();

  const filteredDossier = dossierIsReseller ? d : null;
  const friendly = filteredDossier
    ? friendlySellerName(filteredDossier.seller_name)
    : null;

  // Count classified resellers for the "Did you authorize these?" block.
  const resellerSellers = (narrative.reseller_reality.top_sellers ?? []).filter(
    (s) => {
      const cls = lookupClassification(derived, s);
      if (cls === "reseller") return true;
      if (cls == null && s.is_brand_controlled === false) return true;
      return false;
    },
  );

  return (
    <section id="s-dossier" className="rv2-section">
      <SectionHead
        eyebrow="Did You Authorize These Sellers?"
        title={filteredDossier ? `Inside ${friendly}` : "Reseller dossier"}
        source="Keepa · seller profile · filtered to your reseller classifications"
      />
      {filteredDossier ? (
        <>
          <div className="rv2-dossier-grid">
            <Fact label="Seller name" value={friendly ?? filteredDossier.seller_name} />
            <Fact
              label="Marketplace ID"
              value={filteredDossier.seller_id ?? "— not measured"}
            />
            <Fact
              label="Country"
              value={prettyCountry(filteredDossier.country) ?? "— not measured"}
            />
            <Fact
              label="Buy-box share"
              value={
                filteredDossier.share_pct != null
                  ? `${Math.round(filteredDossier.share_pct * 100)}%`
                  : "— not measured"
              }
            />
            <Fact
              label="ASINs won"
              value={
                filteredDossier.asins_won != null
                  ? String(filteredDossier.asins_won)
                  : "— not measured"
              }
            />
            <Fact label="Fulfilment" value={filteredDossier.fulfilment_mix} />
            <Fact
              label="Authorization status"
              value="Authorization unknown — confirm with your team"
            />
          </div>

          {filteredDossier.top_asins.length > 0 && (
            <div className="rv2-dossier-asins">
              <div className="rv2-dossier-subtitle">Top ASINs they win</div>
              <ul>
                {filteredDossier.top_asins.map((a) => (
                  <li key={a.asin}>
                    <span className="rv2-asin">{a.asin}</span>
                    <span className="rv2-asin-title">
                      {a.title ?? "— not measured"}
                    </span>
                    <span className="rv2-asin-price">
                      {a.buy_box_price != null
                        ? `$${Number(a.buy_box_price).toFixed(2)}`
                        : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rv2-prose rv2-prose-callout">
            {paragraphs(sanitizeForbidden(filteredDossier.risk_profile))}
          </div>

          {resellerSellers.length > 0 && (
            <div className="rv2-checklist">
              <div className="rv2-checklist-title">
                Sellers to confirm authorization on
              </div>
              <ul>
                {resellerSellers.slice(0, 8).map((s, i) => {
                  const friendly = friendlySellerName(s.seller_name);
                  return (
                    <li key={`auth-${i}`}>
                      <SellerInitialBadge name={friendly} />
                      <span>{friendly}</span>
                    </li>
                  );
                })}
              </ul>
              <div className="rv2-checklist-note">
                Authorization status should be confirmed with your team. We&apos;ll review which sellers are authorized, which relationships matter, and which accounts should be transitioned, restricted, or monitored.
              </div>
            </div>
          )}
        </>
      ) : derived.is_tight_channel ? (
        <p className="rv2-muted rv2-prose">
          No third-party reseller activity to investigate based on your classifications. The channel appears tightly brand-controlled.
        </p>
      ) : resellerSellers.length === 0 ? (
        <p className="rv2-muted rv2-prose">
          No third-party reseller activity to investigate based on your classifications.
        </p>
      ) : (
        <>
          <p className="rv2-prose">
            The dominant share is held by sellers you&apos;ve classified as brand-controlled. Below are the third-party sellers we&apos;d still recommend confirming authorization on:
          </p>
          <div className="rv2-checklist">
            <ul>
              {resellerSellers.slice(0, 8).map((s, i) => {
                const friendly = friendlySellerName(s.seller_name);
                return (
                  <li key={`auth2-${i}`}>
                    <SellerInitialBadge name={friendly} />
                    <span>{friendly}</span>
                  </li>
                );
              })}
            </ul>
            <div className="rv2-checklist-note">
              Authorization status should be confirmed with your team.
            </div>
          </div>
        </>
      )}
    </section>
  );
}

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
        eyebrow="Evidence Snapshot · Top Marketplace Signals"
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

      {cx.whats_broken.length > 0 && (
        <div className="rv2-callouts">
          <div className="rv2-block-title">What's broken right now</div>
          <ul>
            {cx.whats_broken.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {hasVariations && <VariationMethodologyPanel />}

      <p className="rv2-muted-small">
        Per-ASIN revenue and units are directional estimates from Keepa BSR + buy-box price (365-day avg). Replace with seller's actual TTM during diligence.
      </p>
    </section>
  );
}

/**
 * Phase 31 — methodology disclosure. Renders only when the brand has
 * at least one parent variation group (size ≥ 2). The user explicitly
 * requested that reports including ASINs from variation groups
 * notate (1) the presence of variations and (2) the methodology used,
 * so the reader knows the per-ASIN numbers are estimates and how they
 * were derived.
 */
function VariationMethodologyPanel() {
  return (
    <aside className="rv2-method-panel" aria-labelledby="rv2-method-title">
      <div id="rv2-method-title" className="rv2-method-kicker">
        Methodology · Variation handling
      </div>
      <p className="rv2-method-body">
        Some ASINs in this brand share a parent listing with sibling variations
        (e.g. a 4-pack and a 12-pack of the same product). Amazon's sales rank
        is often shared across variations, which causes raw third-party sales
        estimators to over-count sales on inactive variations. We attribute
        group-level sales to each variation using a combined signal: <strong>
        recent review activity (last 90 days)</strong> plus <strong>Buy Box win
        frequency (how often each variation actually held the Buy Box recently)
        </strong>. When some siblings have Buy Box history and others don't, the
        absence of Buy Box activity is itself evidence the listing hasn't been
        selling — those variations correctly receive minimal attributed sales.
        <strong> These per-ASIN sales numbers are estimates derived from Keepa
        rank, review, and Buy Box data, not direct sales reporting.</strong>
      </p>
    </aside>
  );
}

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

  // Empty-resellers fallback: every seller is brand-owned / authorized
  // / amazon. The framework section needs sensible reference copy
  // rather than a body that still names "the largest reseller".
  if (!hasResellers && steps) {
    return (
      <section id="s-plan" className="rv2-section rv2-section-alt">
        <SectionHead
          eyebrow="6–12 Month Capture Plan"
          title="The Five-Step Framework"
        />
        <p className="rv2-prose">
          Based on your classifications, the channel is already brand-controlled — there are no third-party resellers to transition off your listings today. The framework below is offered as a reference for protecting that position long-term.
        </p>
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
        eyebrow="6–12 Month Capture Plan"
        title="The Five-Step Framework"
      />
      {p.intro && <p className="rv2-prose">{scrubBrandOwnedNaming(p.intro)}</p>}

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
  return (input: string) => {
    if (!input) return input ?? "";
    let out = input;
    for (const re of constructPatterns) out = out.replace(re, "third-party resellers");
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
          body={
            <>
              {DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.frameworkStep4}{" "}
              <a href={DIVERSIFIED_CASE_STUDY_HREF} className="rv2-case-study-link">
                {DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.referenceLinkLabel}
              </a>.
            </>
          }
        />
      )}
      {callout === "step5" && (
        <RcgCallout
          kicker="Team model"
          body={
            <>
              {DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.frameworkStep5}{" "}
              <a href={DIVERSIFIED_CASE_STUDY_HREF} className="rv2-case-study-link">
                {DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.referenceLinkLabel}
              </a>.
            </>
          }
        />
      )}
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
      <p className="rv2-prose rv2-cta-prose">
        If these sellers are intentionally authorized to operate {brand.name}&apos;s Amazon channel, this may simply be a useful benchmark. If they are not, this could be a meaningful profit recapture and brand-control opportunity.
      </p>
      <p className="rv2-prose rv2-cta-prose">
        On the call, we&apos;ll walk through the numbers, confirm which sellers are authorized, pressure-test the assumptions, and determine whether this is worth pursuing.
      </p>
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
}: {
  narrative: NarrativeV2;
  brand: PublicReportV2Brand;
  pdfUrl: string | null;
  callHref: string;
}) {
  const c = narrative.cta;
  return (
    <section id="s-cta" className="rv2-section rv2-section-cta">
      <h2 className="rv2-h2">
        When you're ready to scale or want a hand executing on this, we're a click away.
      </h2>
      <p className="rv2-prose rv2-cta-prose">
        Most brands at {brand.name}'s stage don't need a consultant — they just need a clean plan. If you'd like a second pair of eyes later, the strategy call is free and we'll walk through whatever you're seeing.
      </p>

      <div className="rv2-cta-actions">
        <a className="rv2-btn" href={callHref}>
          Book a free strategy call
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

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rv2-fact">
      <div className="rv2-fact-lbl">{label}</div>
      <div className="rv2-fact-val">{value}</div>
    </div>
  );
}

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
        <p className="rv2-summary-close">
          This is worth a 15-minute review if these sellers are not intentionally authorized to operate your Amazon channel.
        </p>
      </div>
    </section>
  );
}

function SectionChannelControl({
  narrative,
  brand,
  bundle,
  derived,
  confSellerControl,
}: {
  narrative: NarrativeV2;
  brand: PublicReportV2Brand;
  bundle: BrandEnrichmentBundle | null;
  derived: DerivedSnapshot;
  confSellerControl: ConfidenceLabel;
}) {
  const sellers = narrative.reseller_reality.top_sellers ?? [];
  const top = pickTopReseller(narrative, derived);
  const topShare = pickTopResellerShare(narrative, derived);
  const sellerCount = bundle?.keepa?.unique_seller_count ?? sellers.length ?? null;
  const asinsWithReseller = sellers.filter((s) => {
    const cls = lookupClassification(derived, s);
    return cls === "reseller" || (cls == null && s.is_brand_controlled === false);
  }).reduce((sum, s) => sum + (s.asins_won ?? 0), 0);

  return (
    <section id="s-channel-control" className="rv2-section rv2-section-alt">
      <SectionHead
        eyebrow="The Channel Control Problem"
        title="Your Amazon channel appears to be controlled by resellers"
      />
      <p className="rv2-prose">
        Amazon may already be a meaningful channel for {brand.name}. The problem is that the channel does not appear to be operated by {brand.name} directly.
      </p>
      <p className="rv2-prose rv2-prose-callout">
        <strong>You may already have a meaningful Amazon business. The issue is that someone else appears to be operating it.</strong>
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
        <ChannelCard
          label="Top reseller"
          value={top ?? "— not measured"}
          sub={
            topShare != null
              ? `~${Math.round(topShare * 100)}% buy-box share`
              : null
          }
        />
        <ChannelCard
          label="Observed sellers"
          value={sellerCount != null ? String(sellerCount) : "— not measured"}
        />
        <ChannelCard
          label="ASINs with reseller activity"
          value={asinsWithReseller > 0 ? String(asinsWithReseller) : "— not measured"}
        />
        <ChannelCard
          label="Brand-owned Amazon presence"
          value={derived.shares.brand_owned > 0 ? "Yes" : "Unknown"}
          sub="Confirm with your team"
        />
      </div>

      <BuyBoxPanel
        derived={derived}
        legacyPct={bundle?.keepa?.brand_controlled_pct ?? null}
      />
    </section>
  );
}

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

function SectionCustomerExperience({ brand }: { brand: PublicReportV2Brand }) {
  return (
    <section id="s-cx" className="rv2-section">
      <SectionHead
        eyebrow="The Customer Experience Problem"
        title="It's not just margin — it's brand control"
      />
      <p className="rv2-prose">
        This is not just a reseller margin problem. It is a brand control problem. When third-party sellers control the channel, they influence pricing, packaging, availability, listing quality, customer expectations, and the buying experience. They may benefit from the demand your brand created without investing in the long-term health of the brand.
      </p>
      <p className="rv2-prose">
        Resellers can sell product. But they rarely represent the brand the way the brand owner would.
      </p>

      <div className="rv2-cx-list">
        <div className="rv2-cx-list-title">Typical customer experience risks when resellers control the channel</div>
        <ul>
          <li>Inconsistent pricing across listings</li>
          <li>Inconsistent packaging and product configurations</li>
          <li>Outdated or incomplete listings</li>
          <li>Poor images, weak content, and missing A+ pages</li>
          <li>Inventory inconsistency and stock-outs</li>
          <li>Customer confusion about which listing is &ldquo;official&rdquo;</li>
          <li>Bad reviews caused by the wrong seller experience</li>
          <li>Lack of long-term brand investment from third parties</li>
        </ul>
      </div>

      <p className="rv2-prose rv2-prose-callout">
        {DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.customerExperience} That is what allowed the Amazon channel to scale — relevant for {brand.name} too.{" "}
        <a href={DIVERSIFIED_CASE_STUDY_HREF} className="rv2-case-study-link">
          {DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.referenceLinkLabel}
        </a>.
      </p>
    </section>
  );
}

function SectionSafeTransition() {
  return (
    <section id="s-transition" className="rv2-section rv2-section-alt">
      <SectionHead
        eyebrow="The Safe Path to Taking Control"
        title="How we reclaim the channel without blowing up wholesale"
      />
      <p className="rv2-prose">
        The biggest objection to bringing Amazon under brand control is fear of disrupting wholesale relationships. The process below is strategic, careful, and respectful of the relationships that matter.
      </p>
      <p className="rv2-prose rv2-prose-callout">
        <strong>The goal is not to create a reseller war. The goal is to bring the Amazon customer experience under brand control in a way that protects the business.</strong>
      </p>
      <div className="rv2-cx-list">
        <ul>
          <li>Identify authorized vs. authorization-unknown sellers</li>
          <li>Review distributor and reseller terms</li>
          <li>Map which relationships matter to the broader business</li>
          <li>Create sell-through windows where needed</li>
          <li>Update future Amazon resale restrictions</li>
          <li>Prepare inventory before transitioning listings</li>
          <li>Avoid customer availability gaps</li>
          <li>Maintain important wholesale relationships where possible</li>
          <li>Transition Amazon toward brand-owned control over 6–12 months</li>
          <li>Monitor listings after transition</li>
        </ul>
      </div>
      <p className="rv2-muted-small">
        We&apos;ll confirm which sellers are authorized, which relationships matter, and which accounts should be transitioned, restricted, or monitored.
      </p>
    </section>
  );
}

function SectionWhySteveRolle() {
  return (
    <section id="s-why" className="rv2-section">
      <SectionHead
        eyebrow="Why Steve Rolle / RMG"
        title="Operator-led, not agency"
      />
      <p className="rv2-prose">
        {DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.whySteveBio}{" "}
        <a href={DIVERSIFIED_CASE_STUDY_HREF} className="rv2-case-study-link">
          {DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.referenceLinkLabel}
        </a>.
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

function SectionCaseStudyDiversifiedHospitality({
  brand,
}: {
  brand: PublicReportV2Brand;
}) {
  const cs = DIVERSIFIED_HOSPITALITY_CASE_STUDY;
  return (
    <section
      id={CASE_STUDY_ANCHOR_ID}
      className="rv2-section rv2-section-case-study"
    >
      <SectionHead
        eyebrow="Case Study"
        title={`How Diversified Hospitality turned Amazon from a reseller-controlled channel into a $10M brand-owned revenue stream`}
      />
      <p className="rv2-prose">
        <em>
          Why we share this: when a brand owner takes Amazon back from
          resellers, the unlock is not just margin recapture — it is the
          ability to invest in listings, packaging, customer experience,
          and long-term channel strategy in a way resellers never will.
          That same shift is the opportunity in front of {brand.name}.
        </em>
      </p>
      <details className="rv2-case-study-details">
        <summary className="rv2-case-study-summary">
          <span className="rv2-case-study-summary-label">
            Read the full Diversified Hospitality case study
          </span>
          <span className="rv2-case-study-summary-hint">
            Click to expand
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
                <div className="rv2-case-study-step-title">
                  {i + 1}. {step.title}
                </div>
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
            <li>Amazon became a major profit center</li>
            <li>Customer experience became more consistent</li>
            <li>
              Cash flow improved significantly because Amazon paid faster
              than reseller terms
            </li>
            <li>
              Diversified paid down more than $5 million in accounts
              payable across 2022 and 2023
            </li>
            <li>The increased profitability materially improved the value of the business</li>
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

          <h3 className="rv2-h3 rv2-case-study-h3">
            Why This Matters for Your Brand
          </h3>
          {cs.sections.whyThisMatters.paragraphs?.map((p, i) => (
            <p key={`w-p-${i}`} className="rv2-prose">
              {p}
            </p>
          ))}

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
  callHref,
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
  callHref: string;
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

      <div className="rv2-cover-actions">
        <a className="rv2-btn rv2-btn-primary" href={callHref}>
          Book a 15-minute review
        </a>
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
  ];
  for (const [re, rep] of replacements) s = s.replace(re, rep);
  return s.trim();
}

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

/**
 * Phase 41b — circular initial badge for the reseller checklist.
 * Replaces the literal "?" decoration that read as a missing-icon
 * fallback. Strips a leading "Unknown 3P" prefix so the initial reflects
 * the actual seller name when available; falls back to "?" if the name
 * is empty.
 */
function sellerInitial(name: string): string {
  const cleaned = name.replace(/^Unknown 3P seller(?:\s*\(ID:.*\))?$/i, "").trim();
  const source = cleaned || name;
  const ch = source.replace(/[^A-Za-z0-9]/g, "").charAt(0);
  return ch ? ch.toUpperCase() : "?";
}

function SellerInitialBadge({ name }: { name: string }) {
  return (
    <span className="rv2-seller-initial" aria-hidden>
      {sellerInitial(name)}
    </span>
  );
}

const COUNTRY_NAMES: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  UK: "United Kingdom",
  CA: "Canada",
  DE: "Germany",
  FR: "France",
  IT: "Italy",
  ES: "Spain",
  JP: "Japan",
  AU: "Australia",
  MX: "Mexico",
  CN: "China",
  IN: "India",
  BR: "Brazil",
  NL: "Netherlands",
  PL: "Poland",
  SE: "Sweden",
  TR: "Turkey",
  AE: "United Arab Emirates",
  SG: "Singapore",
  HK: "Hong Kong",
  TW: "Taiwan",
  KR: "South Korea",
};

function prettyCountry(c: string | null | undefined): string | null {
  if (!c) return null;
  const k = c.trim().toUpperCase();
  if (!k) return null;
  return COUNTRY_NAMES[k] ?? k;
}

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
