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
  const top_sellers: ResellerRow[] = sellers.slice(0, 10).map((s, i) => ({
    rank: i + 1,
    seller_name: s.seller_name,
    share_pct: s.share_pct ?? null,
    asins_won: s.asins_won ?? null,
    is_fba: s.is_fba ?? null,
    country: null,
  }));
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
  const top = bundle.keepa.sellers?.[0];
  const topShare = bundle.keepa.top_seller_share_pct ?? top?.share_pct ?? null;
  const topName = bundle.keepa.top_seller ?? top?.seller_name ?? null;

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
): Omit<NarrativeCxAudit, "whats_broken"> {
  const dfs = bundle.dataforseo;
  const detailsByAsin = new Map<string, KeepaAsinDetail>();
  for (const d of asinDetails) detailsByAsin.set(d.asin, d);

  // Score 0-100. When we have real listing fields from Keepa /product,
  // each piece of the listing pulls weight:
  //   • images       (≤6: scaled out of 25)
  //   • bullets      (≤5 features: scaled out of 15)
  //   • A+ / video   (10 each)
  //   • rating       (out of 20: ≥4.5 = full, <3.5 = 0)
  //   • reviews      (log-scaled to 20)
  // When the listing fields are null (no /product data), fall back to
  // the prior heuristic so existing reports don't regress.
  const asin_scores: CxAuditAsinScore[] = (bundle.keepa.asins ?? [])
    .slice(0, 3)
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
      };
    });

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
// The Math (Section 6) — fully transparent
// ----------------------------------------------------------------------

export interface MathContext {
  trailing_12mo_revenue: number | null;
  brand_controlled_pct: number | null;
  current_profit: number | null;
  keepaDate: string | null;
  assumptions: ReportAssumptions;
  /** Source string for the revenue line. Defaults to "Keepa, <date>". */
  revenueSource?: string;
  /** When revenue is estimator-derived, append this footnote to math.notes. */
  revenueFootnote?: string | null;
}

export function computeMath(ctx: MathContext): NarrativeMath {
  const lines: MathLine[] = [];
  const a = ctx.assumptions;
  const revenue = ctx.trailing_12mo_revenue;
  // Bug fix: brand_controlled_pct null vs 0 used to coerce to null down
  // the chain, zeroing reseller_revenue. Treat null = unknown (skip the
  // calc) and 0 = the brand controls 0% of buy boxes (full revenue is
  // reseller-controlled).
  const brandPct =
    a.brand_controlled_pct_override != null
      ? a.brand_controlled_pct_override
      : ctx.brand_controlled_pct;

  const keepaSrc = ctx.keepaDate ? `Keepa, ${ctx.keepaDate.slice(0, 10)}` : "Keepa";
  const revenueSrc = ctx.revenueSource ?? keepaSrc;

  lines.push({
    key: "revenue",
    label: "Trailing 12mo Amazon revenue",
    value: revenue,
    format: "money",
    source: revenueSrc,
  });

  lines.push({
    key: "brand_pct",
    label: "Brand-controlled share of buy box",
    value: brandPct != null ? brandPct : null,
    format: "percent",
    source:
      a.brand_controlled_pct_override != null
        ? `Override: ${(a.brand_controlled_pct_override * 100).toFixed(0)}%`
        : keepaSrc,
    editable: true,
  });

  const resellerRevenue =
    revenue != null && brandPct != null ? revenue * (1 - brandPct) : null;
  lines.push({
    key: "reseller_revenue",
    label: "Reseller-controlled revenue",
    value: resellerRevenue,
    format: "money",
    source: "calc: revenue × (1 − brand-controlled %)",
  });

  const marginCaptured =
    resellerRevenue != null ? resellerRevenue * a.reseller_margin_pct : null;
  lines.push({
    key: "reseller_margin",
    label: "Reseller margin captured (recoverable)",
    value: marginCaptured,
    format: "money",
    source: `Assumption: ${(a.reseller_margin_pct * 100).toFixed(0)}% blended margin × reseller revenue`,
    editable: true,
  });

  const opsSavings =
    resellerRevenue != null ? resellerRevenue * a.ops_savings_pct : null;
  lines.push({
    key: "ops_savings",
    label: "Operational savings (3PL consolidation)",
    value: opsSavings,
    format: "money",
    source: `Assumption: ${(a.ops_savings_pct * 100).toFixed(0)}% of reseller-controlled revenue`,
    editable: true,
  });

  const mcfUplift =
    resellerRevenue != null ? resellerRevenue * a.mcf_uplift_pct : null;
  lines.push({
    key: "mcf_uplift",
    label: "MCF / fulfillment uplift",
    value: mcfUplift,
    format: "money",
    source: `Assumption: ${(a.mcf_uplift_pct * 100).toFixed(0)}% of reseller-controlled revenue`,
    editable: true,
  });

  lines.push({
    key: "rcg_retainer",
    label: "RCG retainer / fee (annual)",
    value: a.rcg_retainer,
    format: "money",
    source: a.rcg_retainer == null ? "Placeholder — replaced by deal terms" : "Deal terms",
    editable: true,
  });

  const newProfitDelta = sumOrNull([
    marginCaptured,
    opsSavings,
    mcfUplift,
    a.rcg_retainer != null ? -a.rcg_retainer : 0,
  ]);
  lines.push({
    key: "delta_profit",
    label: "Δ profit per year (new minus current)",
    value: newProfitDelta,
    format: "money",
    source: "calc: margin captured + ops savings + MCF uplift − RCG fee",
    is_total: true,
  });

  lines.push({
    key: "current_profit",
    label: "Current profit (per import)",
    value: ctx.current_profit,
    format: "money",
    source: "Imported brand row",
  });

  const newProfit =
    ctx.current_profit != null && newProfitDelta != null
      ? ctx.current_profit + newProfitDelta
      : null;
  lines.push({
    key: "new_profit",
    label: "New annual profit",
    value: newProfit,
    format: "money",
    source: "calc: current profit + Δ",
    is_total: true,
  });

  const exitLift =
    newProfitDelta != null ? newProfitDelta * a.ebitda_multiple : null;
  lines.push({
    key: "exit_lift",
    label: `${a.ebitda_multiple}× EBITDA exit-value lift`,
    value: exitLift,
    format: "money",
    source: `Assumption: ${a.ebitda_multiple}× multiple on incremental EBITDA`,
    is_total: true,
    editable: true,
  });

  return { lines, notes: "" };
}

function sumOrNull(xs: (number | null)[]): number | null {
  if (xs.some((x) => x == null)) return null;
  return xs.reduce<number>((a, b) => (a ?? 0) + (b ?? 0), 0);
}
