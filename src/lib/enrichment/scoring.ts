/**
 * Pure validation-score function for Phase 4 Keepa enrichment.
 * Higher score = bigger opportunity for RCG to take the channel back.
 */

export interface ValidationSignals {
  top_seller_share_pct: number | null;     // 0..1
  brand_controlled_pct: number | null;     // 0..1
  unique_seller_count: number | null;
  asin_count: number | null;
  top_seller_country: string | null;       // 'US' or other
}

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

function clamp01(n: number) {
  if (!isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
