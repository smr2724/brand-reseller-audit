// Default column-name → brand field mappings, per source_type.
// Headers are matched case-insensitively after collapsing whitespace.

export type SourceType = "smartscout_raw" | "initial_targets_analysis";

export type BrandField =
  | "name"
  | "category"
  | "brand_score"
  | "est_monthly_revenue"
  | "trailing_12_months"
  | "avg_sellers"
  | "avg_fba_sellers"
  | "dominant_seller_sales_pct"
  | "dominant_seller_country"
  | "dominant_seller_name"
  | "has_storefront"
  | "total_products"
  | "monthly_growth_pct"
  | "trailing_12_growth_pct"
  | "manual_notes"
  | "outreach_activity"
  | "current_profit"
  | "resellers_margin"
  | "recouped_shipping"
  | "labor_cost"
  | "additional_profit"
  | "rcg_fees"
  | "new_profit"
  | "seven_x_multiple_value";

export const TARGET_FIELDS: BrandField[] = [
  "name",
  "category",
  "brand_score",
  "est_monthly_revenue",
  "trailing_12_months",
  "avg_sellers",
  "avg_fba_sellers",
  "dominant_seller_sales_pct",
  "dominant_seller_country",
  "dominant_seller_name",
  "has_storefront",
  "total_products",
  "monthly_growth_pct",
  "trailing_12_growth_pct",
  "manual_notes",
  "outreach_activity",
  "current_profit",
  "resellers_margin",
  "recouped_shipping",
  "labor_cost",
  "additional_profit",
  "rcg_fees",
  "new_profit",
  "seven_x_multiple_value",
];

export function normalizeHeader(h: string | null | undefined): string {
  if (!h) return "";
  return String(h).replace(/\s+/g, " ").trim().toLowerCase();
}

const SHARED_SMARTSCOUT_HEADERS: Record<string, BrandField> = {
  "brand name": "name",
  "brand score": "brand_score",
  "primary main category": "category",
  "est monthly revenue": "est_monthly_revenue",
  "trailing 12 months": "trailing_12_months",
  "avg sellers": "avg_sellers",
  "avg fba sellers": "avg_fba_sellers",
  "dominant seller sales pct": "dominant_seller_sales_pct",
  "dominant seller country": "dominant_seller_country",
  "dominant seller name": "dominant_seller_name",
  "has storefront": "has_storefront",
  "total products": "total_products",
  "1 month growth": "monthly_growth_pct",
  "12 month growth": "trailing_12_growth_pct",
  "notes": "manual_notes",
};

const INITIAL_TARGETS_OVERLAY: Record<string, BrandField> = {
  "brand name": "name",
  "brand score": "brand_score",
  "notes": "manual_notes",
  "activity": "outreach_activity",
  "current profit": "current_profit",
  "reseller's margin": "resellers_margin",
  "resellers margin": "resellers_margin",
  "recouped shipping": "recouped_shipping",
  "price of labor": "labor_cost",
  "additional profit": "additional_profit",
  "rcg fees": "rcg_fees",
  "new profit": "new_profit",
  "7x multiple value": "seven_x_multiple_value",
  // Inherited SmartScout columns (overlay file repeats them)
  "primary main category": "category",
  "est monthly revenue": "est_monthly_revenue",
  "trailing 12 months": "trailing_12_months",
  "avg sellers": "avg_sellers",
  "avg fba sellers": "avg_fba_sellers",
  "dominant seller sales pct": "dominant_seller_sales_pct",
  "dominant seller country": "dominant_seller_country",
  "dominant seller name": "dominant_seller_name",
  "has storefront": "has_storefront",
  "total products": "total_products",
  "1 month growth": "monthly_growth_pct",
  "12 month growth": "trailing_12_growth_pct",
};

export function defaultMapping(source: SourceType): Record<string, BrandField> {
  return source === "smartscout_raw"
    ? { ...SHARED_SMARTSCOUT_HEADERS }
    : { ...INITIAL_TARGETS_OVERLAY };
}

/**
 * Build a header→field map by combining defaults with user overrides.
 * Overrides may set target_field to "ignore" to suppress a column.
 */
export function buildMapping(
  source: SourceType,
  overrides: Array<{ source_column: string; target_field: string }> = []
): Record<string, BrandField | "ignore"> {
  const base = defaultMapping(source) as Record<string, BrandField | "ignore">;
  for (const o of overrides) {
    base[normalizeHeader(o.source_column)] = o.target_field as BrandField | "ignore";
  }
  return base;
}
