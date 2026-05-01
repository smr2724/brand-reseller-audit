/**
 * Combined validation scoring — Keepa (channel control) + DataForSEO (market demand).
 *
 * `validation_score` is on a 0..100 scale, higher = bigger opportunity for
 * RCG to take the channel back. The score must move when the DataForSEO
 * signal flips (acceptance criterion in the Phase 4.5 spec).
 *
 * --------------------------------------------------------------------
 * Pillar weights (sum to 100, applied on top of a 50-point baseline so a
 * brand with no signal at all sits near 50):
 *
 *   CHANNEL CONTROL  (Keepa)            45 pts
 *     - top-seller share              -30 pts × topShare
 *     - brand-controlled share        +20 pts × (1 - brandCtrl)
 *     - unique sellers                + up to 15 pts (0.75 / seller, cap 20)
 *     - non-US top seller              +10 pts
 *     - asin breadth (catalog mass)    + up to 10 pts (0.5 / asin, cap 20)
 *
 *   MARKET DEMAND    (DataForSEO)       35 pts
 *     - branded search volume          + up to 25 pts
 *         (log-scaled: 25 * log10(1 + volume) / log10(1 + 100k))
 *     - branded trend                  +/- 10 pts × clamp(trendPct/50, -1..1)
 *
 *   COMPETITIVE PRESSURE (DataForSEO)   20 pts
 *     - top competitor SERP share      + up to 15 pts × competitorShare
 *     - competitor count               + up to 5 pts (1 / competitor, cap 5)
 *
 * Final score is clamped to [0, 100] and rounded to 2dp.
 * --------------------------------------------------------------------
 */

export interface ValidationSignals {
  // Keepa side (existing — preserved for backward compatibility)
  top_seller_share_pct: number | null;     // 0..1
  brand_controlled_pct: number | null;     // 0..1
  unique_seller_count: number | null;
  asin_count: number | null;
  top_seller_country: string | null;       // 'US' or other
}

export interface DataForSeoSignals {
  branded_search_volume: number | null;
  branded_trend_pct: number | null;        // -100..+inf
  competitor_top_share: number | null;     // 0..1 — share of SERP of leading competitor
  competitor_count: number | null;
}

/**
 * Legacy single-pillar score — Keepa-only. Preserved exactly so existing
 * code paths (Phase 4 enrichBrandWithKeepa) keep producing comparable
 * numbers when DataForSEO data isn't yet available.
 */
export function computeValidationScore(s: ValidationSignals): number | null {
  if ((s.asin_count ?? 0) === 0) return null;

  let score = 50;

  const topShare = clamp01(s.top_seller_share_pct ?? 0);
  score += -30 * topShare;

  const brandCtrl = clamp01(s.brand_controlled_pct ?? 0);
  score += 20 * (1 - brandCtrl);

  const uniques = Math.max(0, s.unique_seller_count ?? 0);
  score += Math.min(uniques, 20) * 0.75;

  if (s.top_seller_country && s.top_seller_country.toUpperCase() !== "US") {
    score += 10;
  }

  const asins = Math.max(0, s.asin_count ?? 0);
  score += Math.min(asins, 20) * 0.5;

  if (score < 0) score = 0;
  if (score > 100) score = 100;
  return Math.round(score * 100) / 100;
}

/**
 * Combined score using Keepa channel signals + DataForSEO demand signals.
 * Returns null only if BOTH inputs are empty (no asins and no demand).
 */
export function computeCombinedValidationScore(
  keepa: ValidationSignals,
  dfs: DataForSeoSignals,
): number | null {
  const hasKeepa = (keepa.asin_count ?? 0) > 0;
  const hasDfs =
    (dfs.branded_search_volume ?? 0) > 0 ||
    (dfs.competitor_count ?? 0) > 0 ||
    (dfs.branded_trend_pct ?? null) != null;

  if (!hasKeepa && !hasDfs) return null;

  let score = 50;

  // ----- Channel control (Keepa) — 45 pts envelope -----
  if (hasKeepa) {
    const topShare = clamp01(keepa.top_seller_share_pct ?? 0);
    score += -30 * topShare;

    const brandCtrl = clamp01(keepa.brand_controlled_pct ?? 0);
    score += 20 * (1 - brandCtrl);

    const uniques = Math.max(0, keepa.unique_seller_count ?? 0);
    score += Math.min(uniques, 20) * 0.75;

    if (
      keepa.top_seller_country &&
      keepa.top_seller_country.toUpperCase() !== "US"
    ) {
      score += 10;
    }

    const asins = Math.max(0, keepa.asin_count ?? 0);
    score += Math.min(asins, 20) * 0.5;
  }

  // ----- Market demand (DataForSEO) — 35 pts envelope -----
  if (hasDfs) {
    const vol = Math.max(0, dfs.branded_search_volume ?? 0);
    if (vol > 0) {
      // Log-scaled so the move from 0 → 1k is meaningful and 100k+ saturates.
      const norm = Math.min(1, Math.log10(1 + vol) / Math.log10(1 + 100_000));
      score += 25 * norm;
    }

    const trend = dfs.branded_trend_pct ?? null;
    if (trend != null) {
      const tNorm = Math.max(-1, Math.min(1, trend / 50));
      score += 10 * tNorm;
    }

    // ----- Competitive pressure — 20 pts envelope -----
    const compShare = clamp01(dfs.competitor_top_share ?? 0);
    score += 15 * compShare;

    const compCount = Math.max(0, dfs.competitor_count ?? 0);
    score += Math.min(compCount, 5);
  }

  if (score < 0) score = 0;
  if (score > 100) score = 100;
  return Math.round(score * 100) / 100;
}

/**
 * Translate the combined signals into short value-add bullets the report
 * can render. These are used by `getBrandEnrichmentBundle.valueAddSignals`
 * and the LLM context block.
 *
 * Each bullet is a one-liner the report can safely render verbatim.
 */
export function deriveValueAddSignals(
  keepa: ValidationSignals,
  dfs: DataForSeoSignals,
): string[] {
  const out: string[] = [];

  const topShare = keepa.top_seller_share_pct;
  const brandCtrl = keepa.brand_controlled_pct;
  const vol = dfs.branded_search_volume;
  const trend = dfs.branded_trend_pct;
  const compShare = dfs.competitor_top_share;

  if ((vol ?? 0) > 0 && (topShare ?? 0) >= 0.5) {
    out.push(
      `High branded demand (${formatVolume(vol!)}/mo) is being captured by a single dominant reseller (~${pct(topShare)} of buy-box wins).`,
    );
  }
  if ((vol ?? 0) >= 1000 && (brandCtrl ?? 1) <= 0.2) {
    out.push(
      `Customers are searching for the brand by name (${formatVolume(vol!)}/mo) but the brand wins fewer than ${pct(brandCtrl)} of its own buy boxes.`,
    );
  }
  if (trend != null && trend > 10 && (brandCtrl ?? 1) < 0.5) {
    out.push(
      `Branded demand is trending up ${trend.toFixed(1)}% — every additional searcher today reaches a reseller, not the brand.`,
    );
  }
  if ((compShare ?? 0) >= 0.2 && (brandCtrl ?? 1) < 0.5) {
    out.push(
      `Top SERP competitor occupies ~${pct(compShare)} of branded search results — the brand's own listings are losing shelf space on its own terms.`,
    );
  }
  if ((keepa.unique_seller_count ?? 0) >= 8) {
    out.push(
      `${keepa.unique_seller_count} distinct sellers competing on listings — pricing and packaging variance is hurting customer experience.`,
    );
  }
  if (keepa.top_seller_country && keepa.top_seller_country.toUpperCase() !== "US") {
    out.push(
      `Dominant buy-box seller is based outside the US (${keepa.top_seller_country}) — sourcing path needs scrutiny.`,
    );
  }
  if (!out.length) {
    if ((vol ?? 0) > 0)
      out.push(`Branded demand observed (${formatVolume(vol!)}/mo) — opportunity is in tightening the channel before resellers arrive.`);
    else if ((keepa.asin_count ?? 0) > 0)
      out.push(`Channel signals captured but branded demand is light — value-add is in driving demand, not just reclaiming it.`);
  }
  return out.slice(0, 6);
}

function clamp01(n: number) {
  if (!isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function pct(n: number | null | undefined): string {
  if (n == null || !isFinite(Number(n))) return "—";
  return `${Math.round(Number(n) * 100)}%`;
}

function formatVolume(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
