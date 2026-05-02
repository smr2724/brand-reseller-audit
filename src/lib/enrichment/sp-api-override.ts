/**
 * SP-API override path for the v2 revenue estimator.
 *
 * When a brand has a row in `brand_sp_api_links`, the audit pipeline
 * pulls its trailing-12mo revenue and ASIN list from the seller's
 * actual Amazon SP-API account (via the
 * `amazon_selling_partner__pipedream` connector) instead of estimating
 * from Keepa BSR + price.
 *
 * Cold prospects (no override row) keep using the Keepa estimator with
 * the recalibrated category-aware rank table.
 *
 * ## Connector wiring
 *
 * The Pipedream-hosted `amazon_selling_partner__pipedream` connector is
 * exposed to this codebase as an HTTP-callable tool. The brief expects
 * one of these SP-API endpoints to be available:
 *
 *   • `getSalesAndTrafficReport`   — trailing-period sales by ASIN
 *   • `getOrders`                  — line items, last 365 days
 *   • `getReportDocument`          — fetch document for a report id
 *
 * When the connector tool surface is reachable, set
 * `SP_API_CONNECTOR_TOOL` to the tool name (e.g.
 * `amazon_selling_partner__pipedream/getSalesAndTrafficReport`) and
 * implement `callConnector()` below to dispatch HTTP calls. Until then,
 * the connector is **interface-only**: production runs return
 * `{ ok: false, reason: "connector_unavailable" }` and the pipeline
 * falls back to the Keepa estimator.
 *
 * The mock path (used in unit tests and `--dry-run` backfills) is
 * exposed via `setMockSpApiResponse()` and lets you test the override
 * flow end-to-end without an actual seller account.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface SpApiAsinSale {
  asin: string;
  units: number;
  ordered_revenue: number;
}

export interface SpApiTrailingResult {
  ok: true;
  brand_id: string;
  marketplace_id: string;
  trailing_12mo_revenue: number;
  asins: SpApiAsinSale[];
  pulled_at: string;
  source_note: string;
}

export interface SpApiOverrideMiss {
  ok: false;
  reason:
    | "no_link"               // brand has no row in brand_sp_api_links
    | "connector_unavailable" // no connector tool wired up at runtime
    | "connector_no_access"   // connector account doesn't cover this brand
    | "connector_error";      // generic upstream failure
  detail?: string;
}

export type SpApiOverrideResult = SpApiTrailingResult | SpApiOverrideMiss;

export interface BrandSpApiLink {
  brand_id: string;
  marketplace_id: string;
  connector_account: string | null;
  notes: string | null;
  configured_at: string;
}

/**
 * Read the override row for a brand. Returns null when no link is
 * configured (cold prospect path).
 */
export async function getBrandSpApiLink(
  admin: SupabaseClient<any, any, any>,
  brandId: string,
): Promise<BrandSpApiLink | null> {
  try {
    const { data } = await admin
      .from("brand_sp_api_links")
      .select("brand_id, marketplace_id, connector_account, notes, configured_at")
      .eq("brand_id", brandId)
      .maybeSingle();
    return (data as BrandSpApiLink | null) ?? null;
  } catch (e) {
    console.warn("[sp-api-override] link lookup failed:", e);
    return null;
  }
}

// =============================================================
// Connector dispatch — production + mock
// =============================================================

let MOCK_RESPONSE: SpApiTrailingResult | SpApiOverrideMiss | null = null;

/**
 * Set a mocked SP-API response for the next `pullTrailing12FromSpApi`
 * call. The mock is consumed once and then cleared. Used by unit tests
 * and the `--dry-run` flag on the backfill script. NOT exposed to the
 * report pipeline at runtime — production builds never call this.
 */
export function setMockSpApiResponse(
  resp: SpApiTrailingResult | SpApiOverrideMiss | null,
): void {
  MOCK_RESPONSE = resp;
}

/**
 * Whether a real connector tool has been wired up. Today this is
 * always false — the connector is on `steve@diversifiedhospitality.com`
 * which doesn't cover the brands we audit, so we ship interface-only
 * and gracefully degrade. Flip this to true (and implement
 * `callConnector` below) when the right Seller Central account is
 * connected.
 */
function isConnectorWired(): boolean {
  return !!process.env.SP_API_CONNECTOR_TOOL;
}

/**
 * Dispatch a single SP-API call through the Pipedream connector.
 *
 * Today this is a stub — the production code returns
 * `connector_unavailable`. To wire the real connector:
 *
 *   1. Confirm the connector account in
 *      `amazon_selling_partner__pipedream` has Seller Central access
 *      to the audited brand.
 *   2. Set env `SP_API_CONNECTOR_TOOL` to the tool name (e.g.
 *      `amazon_selling_partner__pipedream/getSalesAndTrafficReport`).
 *   3. Replace the body of this function with a call to your tool
 *      runtime (claude.ai MCP-proxy, Pipedream HTTP, etc.).
 *
 * The shape of `args` is whatever the chosen SP-API endpoint expects.
 */
async function callConnector(
  toolName: string,
  args: Record<string, any>,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  // Intentionally not implemented — see file-level docstring.
  void toolName;
  void args;
  return { ok: false, error: "connector_runtime_not_wired" };
}

/**
 * Pull the seller's actual trailing-12mo Amazon revenue for a brand.
 *
 * Decision tree:
 *   1. No override row → returns `{ ok: false, reason: "no_link" }`.
 *      Caller falls back to the Keepa estimator. This is the cold-
 *      prospect path.
 *   2. Mock response set → returns the mock (drained). Used in tests.
 *   3. Connector wired → calls the connector and returns parsed data.
 *   4. Connector NOT wired → returns `connector_unavailable`. Caller
 *      falls back to the Keepa estimator.
 */
export async function pullTrailing12FromSpApi(
  admin: SupabaseClient<any, any, any>,
  brandId: string,
): Promise<SpApiOverrideResult> {
  const link = await getBrandSpApiLink(admin, brandId);
  if (!link) return { ok: false, reason: "no_link" };

  if (MOCK_RESPONSE) {
    const r = MOCK_RESPONSE;
    MOCK_RESPONSE = null;
    return r;
  }

  if (!isConnectorWired()) {
    return {
      ok: false,
      reason: "connector_unavailable",
      detail:
        "SP-API connector tool not configured (SP_API_CONNECTOR_TOOL env unset). Falling back to Keepa estimator.",
    };
  }

  const toolName = process.env.SP_API_CONNECTOR_TOOL!;
  const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  try {
    const resp = await callConnector(toolName, {
      marketplace_id: link.marketplace_id,
      reportType: "GET_SALES_AND_TRAFFIC_REPORT",
      dataStartTime: since,
    });
    if (!resp.ok) {
      return {
        ok: false,
        reason: "connector_error",
        detail: resp.error ?? "unknown",
      };
    }
    return parseTrailing12FromConnectorResponse(
      brandId,
      link.marketplace_id,
      resp.data,
    );
  } catch (e) {
    return {
      ok: false,
      reason: "connector_error",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Parse a connector response into our canonical
 * `SpApiTrailingResult`. Exported so the mock path and the production
 * path share parsing rules.
 *
 * Expected shape (`getSalesAndTrafficReport`-style):
 *   {
 *     reportSpecification: { ... },
 *     salesAndTrafficByAsin: [
 *       { childAsin: "B0...", salesByAsin: { orderedProductSales: { amount: 12345.67 }, unitsOrdered: 100 }, ... }
 *     ]
 *   }
 *
 * If the connector returns an `Orders`-style payload instead, callers
 * can pre-aggregate before passing in here.
 */
export function parseTrailing12FromConnectorResponse(
  brandId: string,
  marketplaceId: string,
  data: any,
): SpApiTrailingResult | SpApiOverrideMiss {
  if (!data || typeof data !== "object") {
    return { ok: false, reason: "connector_error", detail: "empty payload" };
  }

  const rows: any[] = Array.isArray(data?.salesAndTrafficByAsin)
    ? data.salesAndTrafficByAsin
    : Array.isArray(data?.asins)
    ? data.asins
    : [];

  if (!rows.length) {
    return {
      ok: false,
      reason: "connector_no_access",
      detail: "report contained no ASIN rows for this seller",
    };
  }

  const asins: SpApiAsinSale[] = [];
  let total = 0;
  for (const r of rows) {
    const asin = String(r?.childAsin ?? r?.asin ?? "").toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
    const revenue =
      Number(r?.salesByAsin?.orderedProductSales?.amount ?? r?.ordered_revenue ?? 0) || 0;
    const units = Number(r?.salesByAsin?.unitsOrdered ?? r?.units ?? 0) || 0;
    asins.push({ asin, units, ordered_revenue: revenue });
    total += revenue;
  }

  if (!asins.length || total <= 0) {
    return {
      ok: false,
      reason: "connector_no_access",
      detail: "no measurable ASIN-level sales in the response",
    };
  }

  return {
    ok: true,
    brand_id: brandId,
    marketplace_id: marketplaceId,
    trailing_12mo_revenue: Math.round(total),
    asins,
    pulled_at: new Date().toISOString(),
    source_note: "Amazon SP-API · trailing 12 months",
  };
}
