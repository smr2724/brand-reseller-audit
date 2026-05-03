/**
 * Math framework v4 — backfill the math + cover headlines on existing
 * v2 reports without re-running Keepa / DFS enrichment.
 *
 * Reads the persisted `narrative_json.math.lines` for the revenue row
 * + revenue source/badge, recomputes the 11-row math via
 * `computeLegionEconomics`, rewrites the math.lines, refreshes the
 * cover headline / kpis / delta_profit / exit_lift, and persists the
 * new `ReportAssumptions` shape.
 *
 * Run:
 *   NEXT_PUBLIC_SUPABASE_URL=... \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   npx tsx scripts/backfill-legion-math.ts <reportId>...
 *
 * Or with no args: backfills the three completed test reports the
 * Math v4 brief calls out (World Amenities, OXO, Yeti).
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { computeLegionEconomics, defaultLegionInputs, type LegionInputs } from "../src/lib/math/legion-economics";
import { DEFAULT_ASSUMPTIONS, type NarrativeV2, type ReportAssumptions } from "../src/lib/report/v2/types";

const TEST_REPORTS = [
  { id: "6b7a11fd-0a61-4b47-ae35-57805031888d", name: "World Amenities" },
  { id: "e65caf43-26e4-4dff-82f0-ebb5cd42bd41", name: "OXO" },
  { id: "3ff56afa-9c2f-4fb0-b7e4-3d0cf0924edd", name: "Yeti" },
];

function pctSrc(n: number, digits = 1) {
  return `${(n * 100).toFixed(digits)}%`;
}

function rebuildMathLines(
  revenueValue: number | null,
  revenueSource: string,
  revenueBadge: "actual" | "estimate" | null,
  a: ReportAssumptions,
  brandControlledPct: number | null,
) {
  const haveRev = revenueValue != null && Number.isFinite(revenueValue);
  const inputs: LegionInputs = {
    revenue: haveRev ? (revenueValue as number) : 0,
    reseller_markup_pct: a.reseller_markup_pct,
    outbound_shipping_pct: a.outbound_shipping_pct,
    outbound_shipping_payer: a.outbound_shipping_payer,
    reseller_net_margin_pct: a.reseller_net_margin_pct,
    current_profit_margin_pct: a.current_profit_margin_pct,
    ebitda_multiple: a.ebitda_multiple,
    labor_cost_override: a.labor_cost_override ?? null,
    brand_controlled_pct: brandControlledPct,
  };
  const out = computeLegionEconomics(inputs);
  const v = (n: number) => (haveRev ? n : null);
  const hasBcGate = brandControlledPct != null && brandControlledPct > 0;
  const baseLabel = hasBcGate ? "recoverable revenue" : "revenue";
  const marginSource = hasBcGate
    ? `Assumption: ${pctSrc(a.reseller_net_margin_pct, 1)} of recoverable revenue (revenue × ${pctSrc(1 - (brandControlledPct as number), 1)} reseller share, post-Amazon-fees / FBA / ads / returns)`
    : `Assumption: ${pctSrc(a.reseller_net_margin_pct, 1)} of revenue (post-Amazon-fees / FBA / ads / returns)`;

  const payerSource =
    a.outbound_shipping_payer === "reseller"
      ? "Brand pays: NO (reseller absorbs shipping; not recoupable)"
      : a.outbound_shipping_payer === "unknown"
        ? "Brand pays: unknown — assumed YES (toggle if reseller absorbs)"
        : "Brand pays: YES (recoupable under direct model)";

  const laborSource =
    a.labor_cost_override != null
      ? "Override: in-house team cost (annual)"
      : out.labor_tier === "under_2m"
        ? "Tier: revenue < $2M → $30,000/yr"
        : out.labor_tier === "2m_to_10m"
          ? "Tier: $2M ≤ revenue < $10M → $130,000/yr"
          : "Tier: revenue ≥ $10M → $250,000/yr";

  return {
    out,
    lines: [
      { key: "revenue", label: "Trailing 12mo Amazon revenue", value: revenueValue, format: "money" as const, source: revenueSource, editable: true, badge: revenueBadge },
      { key: "wholesale_invoice", label: "Wholesale invoice (manuf → reseller)", value: v(out.wholesale_invoice), format: "money" as const, source: `calc: ${baseLabel} ÷ (1 + ${pctSrc(a.reseller_markup_pct, 0)} markup)` },
      { key: "wholesale_outbound_shipping", label: "Wholesale outbound shipping", value: v(out.wholesale_outbound_shipping), format: "money" as const, source: `Assumption: ${pctSrc(a.outbound_shipping_pct, 1)} of wholesale invoice`, editable: true },
      { key: "effective_markup_pct", label: "Effective markup % (incl. shipping)", value: v(out.effective_markup_pct), format: "percent" as const, source: `calc: ${baseLabel} ÷ (wholesale − shipping) − 1` },
      { key: "effective_wholesale", label: "Effective wholesale price (COGS)", value: v(out.effective_wholesale), format: "money" as const, source: "calc: wholesale invoice − outbound shipping" },
      { key: "current_profit", label: "Current manufacturer profit", value: v(out.current_profit), format: "money" as const, source: `Assumption: ${pctSrc(a.current_profit_margin_pct, 0)} margin × effective wholesale`, editable: true },
      { key: "reseller_margin", label: "Reseller net margin captured (recoverable)", value: v(out.reseller_margin_captured), format: "money" as const, source: marginSource, editable: true },
      { key: "recouped_shipping", label: "Recouped outbound shipping", value: v(out.recouped_shipping), format: "money" as const, source: payerSource, editable: true },
      { key: "labor_cost", label: "Labor cost (in-house Amazon team)", value: haveRev ? -Math.abs(out.labor_cost) : null, format: "money" as const, source: laborSource, editable: true },
      { key: "new_profit", label: "New profit (under brand-direct model)", value: v(out.new_profit), format: "money" as const, source: "calc: current profit + reseller margin + recouped shipping − labor" },
      { key: "delta_profit", label: "Δ Additional profit per year", value: v(out.delta_profit), format: "money" as const, source: "calc: new profit − current profit", is_total: true },
      { key: "exit_lift", label: `${a.ebitda_multiple}× EBITDA exit-value lift`, value: v(out.exit_lift), format: "money" as const, source: `Assumption: ${a.ebitda_multiple}× multiple on incremental EBITDA`, is_total: true, editable: true },
    ],
  };
}

function money(n: number | null): string {
  if (n == null) return "— not measured";
  return `$${Math.round(Number(n)).toLocaleString("en-US")}`;
}

function buildCoverHeadline(brandName: string, deltaProfit: number | null, exitLift: number | null): string {
  if (deltaProfit != null && exitLift != null) {
    return `${brandName}, you can recapture ${money(deltaProfit)} in annual profit and ${money(exitLift)} in business value — without adding a single new customer.`;
  }
  if (deltaProfit != null) {
    return `${brandName}, you can recapture ${money(deltaProfit)} in annual profit — without adding a single new customer.`;
  }
  return `${brandName}, you can recapture significant profit and business value from your Amazon channel — without adding a single new customer.`;
}

function buildCoverKpis(deltaProfit: number | null, exitLift: number | null) {
  const kpis: { label: string; value: string; sub: string | null }[] = [];
  if (deltaProfit != null) {
    kpis.push({
      label: "Annual profit recovered",
      value: money(deltaProfit),
      sub: "Keepa + math model · see Section 5",
    });
  }
  if (exitLift != null) {
    kpis.push({
      label: "Business value created",
      value: money(exitLift),
      sub: "7× EBITDA on the new annual profit",
    });
  }
  return kpis;
}

interface ReportRow {
  id: string;
  narrative_json: NarrativeV2 | null;
  report_assumptions: Partial<ReportAssumptions> | null;
  brand_id: string | null;
}

async function backfillOne(admin: any, reportId: string, label: string) {
  console.log(`\n[backfill] ${label}  id=${reportId}`);
  const { data, error } = await admin
    .from("reports")
    .select("id, narrative_json, report_assumptions, brand_id")
    .eq("id", reportId)
    .maybeSingle();
  if (error) throw new Error(`lookup ${reportId}: ${error.message}`);
  const report = data as ReportRow | null;
  if (!report) {
    console.error(`  not found: ${reportId}`);
    return;
  }
  const narrative = report.narrative_json as NarrativeV2 | null;
  if (!narrative || (narrative as any).version !== 2) {
    console.error(`  not a v2 narrative; skipping`);
    return;
  }

  // Pull revenue + source/badge from the persisted math.lines so we
  // don't need to re-enrich.
  const oldLines = narrative.math?.lines ?? [];
  const revLine = oldLines.find((l) => l.key === "revenue");
  const revenueValue = typeof revLine?.value === "number" ? revLine.value : null;
  const revenueSource = revLine?.source ?? "Keepa";
  const revenueBadge = (revLine?.badge as "actual" | "estimate" | null | undefined) ?? null;

  // Migrate old assumptions shape → new. Any v4 fields already on the
  // row win; otherwise fall back to defaults.
  const oldA = (report.report_assumptions ?? {}) as Partial<ReportAssumptions>;
  const a: ReportAssumptions = {
    reseller_markup_pct: oldA.reseller_markup_pct ?? DEFAULT_ASSUMPTIONS.reseller_markup_pct,
    outbound_shipping_pct: oldA.outbound_shipping_pct ?? DEFAULT_ASSUMPTIONS.outbound_shipping_pct,
    outbound_shipping_payer: oldA.outbound_shipping_payer ?? DEFAULT_ASSUMPTIONS.outbound_shipping_payer,
    reseller_net_margin_pct: oldA.reseller_net_margin_pct ?? DEFAULT_ASSUMPTIONS.reseller_net_margin_pct,
    current_profit_margin_pct: oldA.current_profit_margin_pct ?? DEFAULT_ASSUMPTIONS.current_profit_margin_pct,
    ebitda_multiple: oldA.ebitda_multiple ?? DEFAULT_ASSUMPTIONS.ebitda_multiple,
    labor_cost_override: oldA.labor_cost_override ?? null,
  };

  // Phase 27 — pass brand_controlled_pct through so the backfilled
  // numbers match the recoverable-slice gating in production.
  const bcRaw = (narrative as any).brand_controlled_pct;
  const brandControlledPct =
    bcRaw == null || !Number.isFinite(Number(bcRaw))
      ? null
      : Math.max(0, Math.min(1, Number(bcRaw)));

  const { lines, out } = rebuildMathLines(
    revenueValue,
    revenueSource,
    revenueBadge,
    a,
    brandControlledPct,
  );

  // Brand name (for headline rewrite).
  let brandName = narrative.brand_name;
  if (!brandName && report.brand_id) {
    const { data: br } = await admin.from("brands").select("name").eq("id", report.brand_id).maybeSingle();
    brandName = (br as any)?.name ?? "Your brand";
  }

  const deltaProfit = revenueValue != null ? out.delta_profit : null;
  const exitLift = revenueValue != null ? out.exit_lift : null;

  // Strip any "Revenue note: …" the old assemble.ts appended; the new
  // page surfaces it separately under Tier 2.
  const oldNotes = narrative.math?.notes ?? "";
  const cleanedNotes = oldNotes.replace(/\n*Revenue note:[\s\S]*$/, "").trim();

  const updatedNarrative: NarrativeV2 = {
    ...narrative,
    cover: {
      ...narrative.cover,
      headline: buildCoverHeadline(brandName ?? "Your brand", deltaProfit, exitLift),
      kpis: buildCoverKpis(deltaProfit, exitLift),
      delta_profit: deltaProfit,
      exit_lift: exitLift,
    },
    math: {
      lines,
      notes: cleanedNotes,
    },
  };

  console.log(`  revenue=${money(revenueValue)}  delta=${money(deltaProfit)}  exit_lift=${money(exitLift)}  labor_tier=${out.labor_tier}`);

  const { error: updErr } = await admin
    .from("reports")
    .update({
      narrative_json: updatedNarrative as any,
      report_assumptions: a as any,
    } as never)
    .eq("id", reportId);
  if (updErr) throw new Error(`update ${reportId}: ${updErr.message}`);
  console.log(`  ✓ persisted`);
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const args = process.argv.slice(2);
  const targets = args.length > 0 ? args.map((id) => ({ id, name: id })) : TEST_REPORTS;
  for (const t of targets) {
    try {
      await backfillOne(admin, t.id, t.name);
    } catch (e) {
      console.error(`  FAILED:`, e);
    }
  }
  console.log("\n[backfill] done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
