/**
 * Math framework v4 — single source of truth for the World Amenities
 * case-study P&L methodology.
 *
 * Replaces the legacy "10% blended margin × reseller revenue" shortcut
 * (and its ops_savings / mcf_uplift cousins) everywhere. The new
 * `reseller_net_margin_pct` (10.5%) is the consolidated figure — do not
 * stack the legacy assumptions on top of it.
 *
 * Pure functions; no I/O. Match the verification numbers in the brief
 * (World Amenities $1,047,538.87 revenue, all defaults, brand pays
 * shipping):
 *
 *   delta_profit              ≈ $105,898
 *   exit_lift                 ≈ $741,286
 *   reseller_margin_captured  ≈ $110,097
 *   recouped_shipping         ≈ $25,801
 *   labor_cost                = $30,000  (revenue < $2M tier)
 */

export type OutboundShippingPayer = "brand" | "reseller" | "unknown";
export type LaborTier = "under_2m" | "2m_to_10m" | "over_10m";

export interface LegionInputs {
  revenue: number;
  reseller_markup_pct: number;       // default 1.03
  outbound_shipping_pct: number;     // default 0.05
  outbound_shipping_payer: OutboundShippingPayer; // default "brand"
  reseller_net_margin_pct: number;   // default 0.105
  current_profit_margin_pct: number; // default 0.20
  ebitda_multiple: number;           // default 7
  labor_cost_override?: number | null;
}

export interface LegionOutputs {
  wholesale_invoice: number;
  wholesale_outbound_shipping: number;
  effective_markup_pct: number;
  effective_wholesale: number;
  current_profit: number;
  reseller_margin_captured: number;
  recouped_shipping: number;
  labor_cost: number;
  labor_tier: LaborTier;
  new_profit: number;
  delta_profit: number;
  exit_lift: number;
}

export const LEGION_DEFAULTS: Omit<LegionInputs, "revenue"> = {
  reseller_markup_pct: 1.03,
  outbound_shipping_pct: 0.05,
  outbound_shipping_payer: "brand",
  reseller_net_margin_pct: 0.105,
  current_profit_margin_pct: 0.20,
  ebitda_multiple: 7,
  labor_cost_override: null,
};

export function defaultLegionInputs(revenue: number): LegionInputs {
  return { revenue, ...LEGION_DEFAULTS };
}

/**
 * Apply the 11-row computation. Defensive against zero/negative revenue
 * (returns a zeroed-out output rather than NaN/Infinity) so we don't
 * blow up the renderer on a brand we couldn't size.
 */
export function computeLegionEconomics(inputs: LegionInputs): LegionOutputs {
  const revenue = Math.max(0, Number(inputs.revenue) || 0);
  const markup = Math.max(0, Number(inputs.reseller_markup_pct) || 0);
  const shipPct = Math.max(0, Number(inputs.outbound_shipping_pct) || 0);
  const netMarginPct = Math.max(0, Number(inputs.reseller_net_margin_pct) || 0);
  const curMarginPct = Math.max(0, Number(inputs.current_profit_margin_pct) || 0);
  const ebitdaMult = Math.max(0, Number(inputs.ebitda_multiple) || 0);
  // "unknown" is treated as "brand pays" so the prospect sees a
  // populated number; the UI surfaces an italic caveat for the unknown
  // case so they know it's an assumption.
  const payer: OutboundShippingPayer =
    inputs.outbound_shipping_payer === "reseller" ? "reseller" : "brand";

  // 1. Wholesale invoice — what the brand currently invoices the reseller.
  const wholesaleInvoice = revenue / (1 + markup);

  // 2. Wholesale outbound shipping — manuf → reseller leg.
  const wholesaleOutboundShipping = wholesaleInvoice * shipPct;

  // 3. Effective markup % including the shipping cost the brand bears.
  // Per the brief's formula table; collapses (with 4) to
  // effective_wholesale = wholesale_invoice − wholesale_outbound_shipping.
  const denom = wholesaleInvoice - wholesaleOutboundShipping;
  const effectiveMarkupPct = denom > 0 ? revenue / denom - 1 : 0;

  // 4. Effective wholesale (COGS-equivalent).
  const effectiveWholesale =
    1 + effectiveMarkupPct > 0 ? revenue / (1 + effectiveMarkupPct) : 0;

  // 5. Current manufacturer profit on the wholesale leg today.
  const currentProfit = effectiveWholesale * curMarginPct;

  // 6. Reseller net margin captured — the blended margin the brand
  //    recovers by removing the reseller (post-Amazon-fees / FBA / ads
  //    / returns / inbound-to-Amazon).
  const resellerMarginCaptured = revenue * netMarginPct;

  // 7. Recouped outbound shipping — only when the brand currently pays
  //    it (toggle); "unknown" is treated as "brand" upstream so the
  //    UI surfaces a caveat.
  const recoupedShipping = payer === "brand" ? wholesaleOutboundShipping : 0;

  // 8. Labor cost — tiered unless explicitly overridden.
  const laborTier: LaborTier =
    revenue < 2_000_000
      ? "under_2m"
      : revenue < 10_000_000
        ? "2m_to_10m"
        : "over_10m";
  const tieredLabor =
    laborTier === "under_2m" ? 30_000 : laborTier === "2m_to_10m" ? 130_000 : 250_000;
  const laborCost =
    inputs.labor_cost_override != null && inputs.labor_cost_override >= 0
      ? Number(inputs.labor_cost_override)
      : tieredLabor;

  // 9. New profit under the brand-direct model.
  const newProfit =
    currentProfit + resellerMarginCaptured + recoupedShipping - laborCost;

  // 10. Δ profit per year — the headline.
  const deltaProfit = newProfit - currentProfit;

  // 11. Enterprise value lift on the incremental EBITDA.
  const exitLift = deltaProfit * ebitdaMult;

  return {
    wholesale_invoice: wholesaleInvoice,
    wholesale_outbound_shipping: wholesaleOutboundShipping,
    effective_markup_pct: effectiveMarkupPct,
    effective_wholesale: effectiveWholesale,
    current_profit: currentProfit,
    reseller_margin_captured: resellerMarginCaptured,
    recouped_shipping: recoupedShipping,
    labor_cost: laborCost,
    labor_tier: laborTier,
    new_profit: newProfit,
    delta_profit: deltaProfit,
    exit_lift: exitLift,
  };
}

/**
 * Normalize a percent input that may arrive as 103, 1.03, or "103%".
 * Heuristic: any number ≥ 5 is treated as a literal percent (so 103 →
 * 1.03), and anything below is treated as already-decimal. Used by the
 * editable input panel on the report page so prospects can paste any
 * common format.
 */
export function normalizePercent(raw: string | number): number {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return 0;
    return raw >= 5 ? raw / 100 : raw;
  }
  const cleaned = String(raw).replace(/[%\s,]/g, "").trim();
  if (!cleaned) return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return 0;
  return n >= 5 ? n / 100 : n;
}
