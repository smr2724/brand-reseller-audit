/**
 * Phase 76 — money formatting helpers shared between the bulk worker
 * draft flow and the legacy per-row /api/outreach/send-to-outlook route.
 *
 * `formatAdditionalProfit` renders `brands.additional_profit` as a USD
 * subject-line token: leading `$`, comma-grouped thousands, rounded to
 * whole dollars, no cents. Null/NaN/invalid values render as `$0` (the
 * visible "something's off with this brand's economics" signal — Phase 76
 * decision: no gating, fall back to $0 in the subject).
 */

export function formatAdditionalProfit(
  value: number | string | null | undefined,
): string {
  const n = typeof value === "string" ? Number(value) : value ?? null;
  if (n == null || !Number.isFinite(n)) return "$0";
  return "$" + Math.round(n as number).toLocaleString("en-US");
}
