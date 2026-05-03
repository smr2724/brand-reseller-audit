/**
 * Phase 8 — Pure computations for the v2 audit report.
 *
 * Takes the enrichment bundle + brand row + assumptions and returns
 * the typed structures the narrative + renderer consume. No I/O.
 *
 * The math model is deliberately transparent: every number is paired
 * with a `source` string ("Keepa, <date>", "calc: A × B", "Assumption:
 * 20% margin") so the prospect can audit it line-by-line.
 */
import type { BrandEnrichmentBundle } from "@/lib/enrichment";
import type { BrandForReport } from "@/lib/report/narrative";
import type { CompetitorSnapshot, KeepaAsinDetail } from "./enrich";
import type { RevenueEstimate, RevenueEstimatePerAsin } from "@/lib/enrichment/revenue-estimator";
import { classifySellerSync } from "@/lib/enrichment/seller-classification";
import type {
  CompetitorRow,
  CxAuditAsinScore,
  DossierAsinRow,
  MathLine,
  NarrativeCompetitorBenchmark,
  NarrativeCxAudit,
  NarrativeMath,
  NarrativeResellerDossier,
  NarrativeResellerReality,
  ReportAssumptions,
  ResellerRow,
} from "./types";

// ----------------------------------------------------------------------
// Reseller Reality (Section 2)
// ----------------------------------------------------------------------

export function computeResellerReality(
  bundle: BrandEnrichmentBundle,
): NarrativeResellerReality {
  // We don't have a per-seller country attached on KeepaSellerRow in the
  // bundle (it lives on brand_sellers). For now we leave country null
  // here; the dossier section pulls country from the bundle's top_seller_country.
  const sellers = bundle.keepa.sellers ?? [];
  const top_sellers: ResellerRow[] = sellers.slice(0, 10).map((s, i) => {
    // Phase 23 — when the persisted classification column is null
    // (legacy row, or migration not applied yet), recompute synchronously
    // from seller_name vs brand_name so the dossier and reality narrative
    // can still skip the brand's own LLC.
    let isBrand: boolean | null = s.is_brand_controlled ?? null;
    let reason: string | null = s.classification_reason ?? null;
    if (isBrand == null) {
      const v = classifySellerSync({
        brand_name: bundle.brandName,
        seller_name: s.seller_name,
        seller_id: s.seller_id,
      });
      isBrand = v.is_brand_controlled;
      reason = v.reason;
    }
    return {
      rank: i + 1,
      seller_name: s.seller_name,
      share_pct: s.share_pct ?? null,
      asins_won: s.asins_won ?? null,
      is_fba: s.is_fba ?? null,
      country: null,
      // Phase 23 — surface classification verdict + reason for transparency.
      is_brand_controlled: isBrand,
      classification_reason: reason,
    };
  });
  return { top_sellers, one_liner: "", note: null };
}

// ----------------------------------------------------------------------
// Reseller Dossier (Section 3)
// ----------------------------------------------------------------------

export function computeDossierBase(
  bundle: BrandEnrichmentBundle,
): {
  dossier: Omit<NarrativeResellerDossier, "risk_profile"> | null;
  reason: "no_top_seller" | "low_share" | null;
} {
  // Phase 23 — pick the top *reseller*, not the top seller overall.
  // Brand-controlled sellers (the brand's own LLC) shouldn't end up as
  // the dossier subject — RCG can't "remove" Fantaswick LLC from
  // Fantaswick's listings. Backfill classification on the fly when the
  // persisted columns are null (legacy / pre-migration rows).
  const sellers = bundle.keepa.sellers ?? [];
  const resellers = sellers.filter((s) => {
    if (s.is_brand_controlled === true) return false;
    if (s.is_brand_controlled === false) return true;
    const v = classifySellerSync({
      brand_name: bundle.brandName,
      seller_name: s.seller_name,
      seller_id: s.seller_id,
    });
    return !v.is_brand_controlled;
  });
  const top = resellers[0] ?? sellers[0];
  // When `top_seller` (the brand row) and the picked reseller diverge
  // (because legacy data has no classification yet), prefer the picked
  // reseller's own share/name so the dossier is internally consistent.
  const topShare = top?.share_pct ?? bundle.keepa.top_seller_share_pct ?? null;
  const topName = top?.seller_name ?? bundle.keepa.top_seller ?? null;

  if (!top || !topName) {
    return { dossier: null, reason: "no_top_seller" };
  }
  if ((topShare ?? 0) < 0.2) {
    // spec: skip dossier if top reseller share < 20%, do "Top 3 sellers snapshot" instead
    return { dossier: null, reason: "low_share" };
  }

  // Top ASINs this seller wins most often. We approximate by surfacing
  // the brand's highest-traffic ASINs whose buy_box_seller matches the
  // top seller. If none match (data gap), fall back to top 3 by offer
  // count regardless of buy-box owner.
  const matched = (bundle.keepa.asins ?? []).filter(
    (a) =>
      a.buy_box_seller &&
      a.buy_box_seller.toLowerCase().trim() === topName.toLowerCase().trim(),
  );
  const fallback = (bundle.keepa.asins ?? []).slice(0, 3);
  const asinSource = matched.length ? matched : fallback;

  const top_asins: DossierAsinRow[] = asinSource.slice(0, 3).map((a) => ({
    asin: a.asin,
    title: a.title,
    buy_box_pct:
      // No per-ASIN buy-box win % in the bundle today — approximate via
      // is_brand_controlled flip (resellers won → 1, brand won → 0).
      a.is_brand_controlled === false ? 1 : a.is_brand_controlled === true ? 0 : null,
    buy_box_price: a.buy_box_price,
  }));

  const fbaCount = matched.filter((a) => (a.fba_offers_count ?? 0) > 0).length;
  let mix = "— not measured";
  if (top.is_fba === true) mix = "FBA dominant";
  else if (top.is_fba === false) mix = "FBM dominant";
  else if (matched.length > 0) {
    mix = fbaCount >= matched.length / 2 ? "FBA dominant" : "Mixed";
  }

  return {
    dossier: {
      seller_name: topName,
      seller_id: top.seller_id ?? null,
      country: bundle.keepa.top_seller_country ?? null,
      share_pct: topShare,
      asins_won: top.asins_won ?? null,
      is_fba: top.is_fba ?? null,
      fulfilment_mix: mix,
      top_asins,
    },
    reason: null,
  };
}

// ----------------------------------------------------------------------
// CX Audit (Section 4)
// ----------------------------------------------------------------------

export function computeCxAuditBase(
  bundle: BrandEnrichmentBundle,
  asinDetails: KeepaAsinDetail[] = [],
  revenueEstimate: RevenueEstimate | null = null,
): Omit<NarrativeCxAudit, "whats_broken"> {
  const dfs = bundle.dataforseo;
  const detailsByAsin = new Map<string, KeepaAsinDetail>();
  for (const d of asinDetails) detailsByAsin.set(d.asin, d);
  const perAsinRev = new Map<string, RevenueEstimatePerAsin>();
  for (const r of revenueEstimate?.per_asin ?? []) perAsinRev.set(r.asin, r);

  // Score 0-100. When we have real listing fields from Keepa /product,
  // each piece of the listing pulls weight:
  //   • images       (≤6: scaled out of 25)
  //   • bullets      (≤5 features: scaled out of 15)
  //   • A+ / video   (10 each)
  //   • rating       (out of 20: ≥4.5 = full, <3.5 = 0)
  //   • reviews      (log-scaled to 20)
  // When the listing fields are null (no /product data), fall back to
  // the prior heuristic so existing reports don't regress.
  // v2.1 — surface up to 10 ASINs (was 3) and sort by estimated TTM
  // revenue desc so the highest-opportunity SKUs lead.
  const asin_scores: CxAuditAsinScore[] = (bundle.keepa.asins ?? [])
    .map((a) => {
      const d = detailsByAsin.get(a.asin) ?? null;
      const have = d != null;
      let score = 0;
      let bullets: number | null = null;
      let images: number | null = null;
      let hasAPlus: boolean | null = null;
      let hasVideo: boolean | null = null;
      let reviews: number | null = null;
      let rating: number | null = null;

      if (have) {
        images = d!.images_count;
        bullets = d!.features_count;
        hasAPlus = d!.has_a_plus;
        hasVideo = d!.has_video;
        reviews = d!.review_count;
        rating = d!.rating;

        if (images != null) score += Math.min(25, Math.round((images / 6) * 25));
        if (bullets != null) score += Math.min(15, Math.round((bullets / 5) * 15));
        if (hasAPlus === true) score += 10;
        if (hasVideo === true) score += 10;
        if (rating != null) {
          if (rating >= 4.5) score += 20;
          else if (rating >= 4.0) score += 14;
          else if (rating >= 3.5) score += 7;
        }
        if (reviews != null) {
          // log10(reviews) capped at 4 (10000 reviews) → 20 points.
          const r = Math.max(0, Math.min(4, Math.log10(Math.max(1, reviews))));
          score += Math.round((r / 4) * 20);
        }
      } else {
        // Legacy heuristic when /product data is unavailable.
        if (a.is_brand_controlled === true) score += 50;
        else if (a.is_brand_controlled === false) score += 10;
        if ((a.offers_count ?? 99) <= 3) score += 25;
        else if ((a.offers_count ?? 99) <= 6) score += 12;
        if (a.title && a.title.length > 10) score += 15;
        if (a.buy_box_price != null) score += 10;
      }

      const rev = perAsinRev.get(a.asin) ?? null;
      return {
        asin: a.asin,
        title: a.title,
        score: score > 0 ? Math.min(100, score) : null,
        bullets,
        images,
        has_a_plus: hasAPlus,
        has_video: hasVideo,
        reviews,
        rating,
        ttm_revenue: rev?.ttm_revenue ?? null,
        ttm_units:
          rev?.monthly_units != null ? rev.monthly_units * 12 : null,
        buy_box_price: rev?.buy_box_price ?? a.buy_box_price ?? null,
      };
    })
    .sort((a, b) => (b.ttm_revenue ?? -1) - (a.ttm_revenue ?? -1))
    .slice(0, 10);

  const top_keywords = (dfs?.top_keywords ?? []).slice(0, 12).map((k) => ({
    keyword: k.keyword,
    search_volume: k.search_volume ?? null,
  }));

  return {
    branded_search_volume: dfs?.branded_search_volume ?? null,
    branded_trend_pct: dfs?.branded_trend_pct ?? null,
    top_keywords,
    asin_scores,
  };
}

// ----------------------------------------------------------------------
// Competitive Benchmark (Section 5)
// ----------------------------------------------------------------------

export function computeCompetitorBenchmark(
  brand: BrandForReport,
  bundle: BrandEnrichmentBundle,
  competitors: CompetitorSnapshot[],
  cx: Omit<NarrativeCxAudit, "whats_broken">,
): NarrativeCompetitorBenchmark {
  const auditedListingHealth = avg(
    cx.asin_scores.map((a) => a.score).filter((n): n is number => n != null),
  );

  const auditedRow: CompetitorRow = {
    brand: brand.name,
    is_audited_brand: true,
    unique_seller_count: bundle.keepa.unique_seller_count,
    brand_controlled_pct: bundle.keepa.brand_controlled_pct,
    branded_search_volume: bundle.dataforseo?.branded_search_volume ?? null,
    organic_serp_rank:
      bundle.dataforseo?.serp_positions?.find((p) => p.is_brand)?.position ?? null,
    listing_health: auditedListingHealth,
  };

  const compRows: CompetitorRow[] = competitors.slice(0, 4).map((c) => ({
    brand: c.brand,
    is_audited_brand: false,
    unique_seller_count: c.unique_seller_count,
    brand_controlled_pct: c.brand_controlled_pct,
    branded_search_volume: c.branded_search_volume,
    organic_serp_rank: c.organic_serp_rank,
    listing_health: c.listing_health,
  }));

  return {
    rows: [auditedRow, ...compRows],
    one_liner: "",
  };
}

function avg(xs: number[]): number | null {
  if (!xs.length) return null;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

// ----------------------------------------------------------------------
// The Math (Section 6) — World Amenities case-study methodology (v4)
// ----------------------------------------------------------------------

import { computeLegionEconomics, type LegionInputs } from "@/lib/math/legion-economics";

export interface MathContext {
  trailing_12mo_revenue: number | null;
  /** Reserved for future use; the v4 framework no longer takes the
   * brand-controlled share into the math, but we keep the field on the
   * context so callers don't need to change shape. */
  brand_controlled_pct: number | null;
  current_profit: number | null;
  keepaDate: string | null;
  assumptions: ReportAssumptions;
  /** Source string for the revenue line. Defaults to "Keepa, <date>". */
  revenueSource?: string;
  /** When revenue is estimator-derived, append this footnote to math.notes. */
  revenueFootnote?: string | null;
  /** Badge to render next to the revenue value:
   *   "actual"   — SP-API or imported real number (green)
   *   "estimate" — Keepa BSR + price (amber, with footnote)
   * Default null (no badge). */
  revenueBadge?: "actual" | "estimate" | null;
}

const PCT_FMT = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`;

export function computeMath(ctx: MathContext): NarrativeMath {
  const a = ctx.assumptions;
  const revenue = ctx.trailing_12mo_revenue;
  const keepaSrc = ctx.keepaDate ? `Keepa, ${ctx.keepaDate.slice(0, 10)}` : "Keepa";
  const revenueSrc = ctx.revenueSource ?? keepaSrc;

  // When revenue is missing we still emit the row set so the page can
  // render the structure, with values coerced to null.
  const haveRevenue = revenue != null && Number.isFinite(revenue);
  const inputs: LegionInputs = {
    revenue: haveRevenue ? (revenue as number) : 0,
    reseller_markup_pct: a.reseller_markup_pct,
    outbound_shipping_pct: a.outbound_shipping_pct,
    outbound_shipping_payer: a.outbound_shipping_payer,
    reseller_net_margin_pct: a.reseller_net_margin_pct,
    current_profit_margin_pct: a.current_profit_margin_pct,
    ebitda_multiple: a.ebitda_multiple,
    labor_cost_override: a.labor_cost_override ?? null,
  };
  const out = computeLegionEconomics(inputs);
  const v = (n: number) => (haveRevenue ? n : null);

  const payerSource =
    a.outbound_shipping_payer === "reseller"
      ? "Brand pays: NO (reseller absorbs shipping; not recoupable)"
      : a.outbound_shipping_payer === "unknown"
        ? "Brand pays: unknown — assumed YES (toggle if reseller absorbs)"
        : "Brand pays: YES (recoupable under direct model)";

  const lines: MathLine[] = [
    {
      key: "revenue",
      label: "Trailing 12mo Amazon revenue",
      value: revenue,
      format: "money",
      source: revenueSrc,
      editable: true,
      badge: ctx.revenueBadge ?? null,
    },
    {
      key: "wholesale_invoice",
      label: "Wholesale invoice (manuf → reseller)",
      value: v(out.wholesale_invoice),
      format: "money",
      source: `calc: revenue ÷ (1 + ${PCT_FMT(a.reseller_markup_pct, 0)} markup)`,
    },
    {
      key: "wholesale_outbound_shipping",
      label: "Wholesale outbound shipping",
      value: v(out.wholesale_outbound_shipping),
      format: "money",
      source: `Assumption: ${PCT_FMT(a.outbound_shipping_pct, 1)} of wholesale invoice`,
      editable: true,
    },
    {
      key: "effective_markup_pct",
      label: "Effective markup % (incl. shipping)",
      value: v(out.effective_markup_pct),
      format: "percent",
      source: "calc: revenue ÷ (wholesale − shipping) − 1",
    },
    {
      key: "effective_wholesale",
      label: "Effective wholesale price (COGS)",
      value: v(out.effective_wholesale),
      format: "money",
      source: "calc: wholesale invoice − outbound shipping",
    },
    {
      key: "current_profit",
      label: "Current manufacturer profit",
      value: v(out.current_profit),
      format: "money",
      source: `Assumption: ${PCT_FMT(a.current_profit_margin_pct, 0)} margin × effective wholesale`,
      editable: true,
    },
    {
      key: "reseller_margin",
      label: "Reseller net margin captured (recoverable)",
      value: v(out.reseller_margin_captured),
      format: "money",
      source: `Assumption: ${PCT_FMT(a.reseller_net_margin_pct, 1)} of revenue (post-Amazon-fees / FBA / ads / returns)`,
      editable: true,
    },
    {
      key: "recouped_shipping",
      label: "Recouped outbound shipping",
      value: v(out.recouped_shipping),
      format: "money",
      source: payerSource,
      editable: true,
    },
    {
      key: "labor_cost",
      label: "Labor cost (in-house Amazon team)",
      value: v(-Math.abs(out.labor_cost)),
      format: "money",
      source: laborSource(out.labor_tier, a.labor_cost_override),
      editable: true,
    },
    {
      key: "new_profit",
      label: "New profit (under brand-direct model)",
      value: v(out.new_profit),
      format: "money",
      source: "calc: current profit + reseller margin + recouped shipping − labor",
    },
    {
      key: "delta_profit",
      label: "Δ Additional profit per year",
      value: v(out.delta_profit),
      format: "money",
      source: "calc: new profit − current profit",
      is_total: true,
    },
    {
      key: "exit_lift",
      label: `${a.ebitda_multiple}× EBITDA exit-value lift`,
      value: v(out.exit_lift),
      format: "money",
      source: `Assumption: ${a.ebitda_multiple}× multiple on incremental EBITDA`,
      is_total: true,
      editable: true,
    },
  ];

  return { lines, notes: "" };
}

function laborSource(
  tier: "under_2m" | "2m_to_10m" | "over_10m",
  override: number | null,
): string {
  if (override != null) return "Override: in-house team cost (annual)";
  if (tier === "under_2m") return "Tier: revenue < $2M → $30,000/yr";
  if (tier === "2m_to_10m") return "Tier: $2M ≤ revenue < $10M → $130,000/yr";
  return "Tier: revenue ≥ $10M → $250,000/yr";
}
