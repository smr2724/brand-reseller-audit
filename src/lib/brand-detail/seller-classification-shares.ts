/**
 * Phase 39 — Aggregate the 4-bucket share breakdown from a list of
 * classified brand_sellers rows.
 *
 * Used both at report-generation time (snapshot persisted on the
 * reports row) and on the brand-page financial model (live shares from
 * the current brand_sellers state). Returns shares as 0..1 decimals.
 *
 * The "non-reseller" share — what flows into computeLegionEconomics as
 * `brand_controlled_pct` — equals brand_owned + authorized + amazon.
 * Only the reseller bucket is recoverable revenue.
 */

export type SellerClassification =
  | "brand_owned"
  | "authorized"
  | "amazon"
  | "reseller";

export interface ClassifiedSellerInput {
  seller_id?: string | null;
  seller_name?: string | null;
  share_pct?: number | null;
  classification?: SellerClassification | string | null;
}

export interface ClassificationShares {
  brand_owned_share_pct: number;
  authorized_share_pct: number;
  amazon_share_pct: number;
  reseller_share_pct: number;
  /** brand_owned + authorized + amazon — what the legacy `brand_controlled_pct`
   *  input on `computeLegionEconomics` represents (the slice of revenue
   *  that is NOT recoverable through reseller removal). */
  non_reseller_share_pct: number;
  /** True when at least one row has a real share_pct value we could
   *  total. False ⇒ shares are all zero because no input had a share. */
  has_data: boolean;
}

const VALID: ReadonlySet<SellerClassification> = new Set([
  "brand_owned",
  "authorized",
  "amazon",
  "reseller",
]) as ReadonlySet<SellerClassification>;

function safe(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

export function aggregateClassificationShares(
  rows: ClassifiedSellerInput[],
): ClassificationShares {
  let brandOwned = 0;
  let authorized = 0;
  let amazon = 0;
  let reseller = 0;
  let total = 0;
  for (const r of rows) {
    const share = typeof r.share_pct === "number" ? safe(r.share_pct) : 0;
    if (share <= 0) continue;
    total += share;
    const rawCls = r.classification ?? null;
    const cls: SellerClassification =
      rawCls && VALID.has(rawCls as SellerClassification)
        ? (rawCls as SellerClassification)
        : "reseller";
    if (cls === "brand_owned") brandOwned += share;
    else if (cls === "authorized") authorized += share;
    else if (cls === "amazon") amazon += share;
    else reseller += share;
  }

  // Normalize to 0..1 — brand_sellers.share_pct is already 0..1 in this
  // codebase, but external callers (snapshot from the modal) may pass
  // raw 0..1 fractions that don't sum to exactly 1 due to rounding /
  // sellers excluded from the top-N. We renormalize anyway so the four
  // buckets always sum to 1.0 when there's any data.
  if (total <= 0) {
    return {
      brand_owned_share_pct: 0,
      authorized_share_pct: 0,
      amazon_share_pct: 0,
      reseller_share_pct: 0,
      non_reseller_share_pct: 0,
      has_data: false,
    };
  }
  const norm = (n: number) => Math.max(0, Math.min(1, n / total));
  const brandOwnedPct = norm(brandOwned);
  const authorizedPct = norm(authorized);
  const amazonPct = norm(amazon);
  const resellerPct = norm(reseller);
  const nonReseller = Math.max(0, Math.min(1, brandOwnedPct + authorizedPct + amazonPct));
  return {
    brand_owned_share_pct: brandOwnedPct,
    authorized_share_pct: authorizedPct,
    amazon_share_pct: amazonPct,
    reseller_share_pct: resellerPct,
    non_reseller_share_pct: nonReseller,
    has_data: true,
  };
}
