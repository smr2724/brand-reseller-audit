/**
 * Phase 19 — temporary admin endpoint to re-run the revenue estimator
 * (Keepa /product BSR + price → category-aware bracket → TTM) for an
 * existing report and persist the recomputed math + cover hero fields,
 * WITHOUT disturbing seller dossier / ASIN cards / keywords / competitors.
 *
 * Auth: x-internal-token must match INTERNAL_JOB_TOKEN (server env).
 * Body: { report_id: string }
 *
 * Safe to remove after the OXO + Yeti backfill in phase19_rescan_oxo_yeti_brief.md.
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { getProductDetails, isKeepaConfigured } from "@/lib/keepa";
import {
  estimateBrandTtmRevenue,
  type RevenueEstimate,
} from "@/lib/enrichment/revenue-estimator";
import { getBrandEnrichmentBundle } from "@/lib/enrichment";
import { enrichBrandWithKeepa } from "@/lib/enrichment/keepa-brand";
import { computeLegionEconomics, type LegionInputs } from "@/lib/math/legion-economics";
import {
  DEFAULT_ASSUMPTIONS,
  type NarrativeV2,
  type ReportAssumptions,
  type MathLine,
} from "@/lib/report/v2/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function pctSrc(n: number, digits = 1) {
  return `${(n * 100).toFixed(digits)}%`;
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

function rebuildMathLines(
  revenueValue: number | null,
  revenueSource: string,
  revenueBadge: "actual" | "estimate" | null,
  a: ReportAssumptions,
): { lines: MathLine[]; out: ReturnType<typeof computeLegionEconomics> } {
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
  };
  const out = computeLegionEconomics(inputs);
  const v = (n: number) => (haveRev ? n : null);

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

  const lines: MathLine[] = [
    { key: "revenue", label: "Trailing 12mo Amazon revenue", value: revenueValue, format: "money", source: revenueSource, editable: true, badge: revenueBadge },
    { key: "wholesale_invoice", label: "Wholesale invoice (manuf → reseller)", value: v(out.wholesale_invoice), format: "money", source: `calc: revenue ÷ (1 + ${pctSrc(a.reseller_markup_pct, 0)} markup)` },
    { key: "wholesale_outbound_shipping", label: "Wholesale outbound shipping", value: v(out.wholesale_outbound_shipping), format: "money", source: `Assumption: ${pctSrc(a.outbound_shipping_pct, 1)} of wholesale invoice`, editable: true },
    { key: "effective_markup_pct", label: "Effective markup % (incl. shipping)", value: v(out.effective_markup_pct), format: "percent", source: "calc: revenue ÷ (wholesale − shipping) − 1" },
    { key: "effective_wholesale", label: "Effective wholesale price (COGS)", value: v(out.effective_wholesale), format: "money", source: "calc: wholesale invoice − outbound shipping" },
    { key: "current_profit", label: "Current manufacturer profit", value: v(out.current_profit), format: "money", source: `Assumption: ${pctSrc(a.current_profit_margin_pct, 0)} margin × effective wholesale`, editable: true },
    { key: "reseller_margin", label: "Reseller net margin captured (recoverable)", value: v(out.reseller_margin_captured), format: "money", source: `Assumption: ${pctSrc(a.reseller_net_margin_pct, 1)} of revenue (post-Amazon-fees / FBA / ads / returns)`, editable: true },
    { key: "recouped_shipping", label: "Recouped outbound shipping", value: v(out.recouped_shipping), format: "money", source: payerSource, editable: true },
    { key: "labor_cost", label: "Labor cost (in-house Amazon team)", value: haveRev ? -Math.abs(out.labor_cost) : null, format: "money", source: laborSource, editable: true },
    { key: "new_profit", label: "New profit (under brand-direct model)", value: v(out.new_profit), format: "money", source: "calc: current profit + reseller margin + recouped shipping − labor" },
    { key: "delta_profit", label: "Δ Additional profit per year", value: v(out.delta_profit), format: "money", source: "calc: new profit − current profit", is_total: true },
    { key: "exit_lift", label: `${a.ebitda_multiple}× EBITDA exit-value lift`, value: v(out.exit_lift), format: "money", source: `Assumption: ${a.ebitda_multiple}× multiple on incremental EBITDA`, is_total: true, editable: true },
  ];
  return { lines, out };
}

interface Body {
  report_id?: string;
  /** When true, force the Keepa brand-search to re-run even if the
   * brand row's keepa_last_enriched_at is still inside the freshness
   * window. Default: false (we re-pull /product details unconditionally
   * because the per-ASIN cache is what feeds the estimator). */
  force_brand_search?: boolean;
}

export async function POST(req: Request) {
  // Auth: same shared INTERNAL_JOB_TOKEN as /api/jobs/run.
  const expected = process.env.INTERNAL_JOB_TOKEN;
  if (!expected) return NextResponse.json({ error: "INTERNAL_JOB_TOKEN not set" }, { status: 500 });
  const tok = req.headers.get("x-internal-token");
  if (tok !== expected) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  if (!isKeepaConfigured()) {
    return NextResponse.json({ error: "KEEPA_API_KEY missing" }, { status: 500 });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY not set" }, { status: 500 });

  const body = (await req.json().catch(() => ({}))) as Body;
  const reportId = (body.report_id ?? "").trim();
  if (!reportId) return NextResponse.json({ error: "report_id required" }, { status: 400 });

  // 1. Load report.
  const { data: reportRow, error: rErr } = await admin
    .from("reports")
    .select("id, brand_id, narrative_json, report_assumptions")
    .eq("id", reportId)
    .maybeSingle();
  if (rErr) return NextResponse.json({ error: `report lookup: ${rErr.message}` }, { status: 500 });
  if (!reportRow) return NextResponse.json({ error: "report not found" }, { status: 404 });
  const report = reportRow as any;

  const narrative = report.narrative_json as NarrativeV2 | null;
  if (!narrative || (narrative as any).version !== 2) {
    return NextResponse.json({ error: "report is not v2 narrative" }, { status: 400 });
  }
  if (!report.brand_id) {
    return NextResponse.json({ error: "report has no brand_id" }, { status: 400 });
  }

  // 2. Load brand.
  const { data: brandRow, error: bErr } = await admin
    .from("brands")
    .select("id, name, user_id, keepa_last_enriched_at")
    .eq("id", report.brand_id)
    .maybeSingle();
  if (bErr) return NextResponse.json({ error: `brand lookup: ${bErr.message}` }, { status: 500 });
  if (!brandRow) return NextResponse.json({ error: "brand not found" }, { status: 404 });
  const brand = brandRow as any;

  // 3. Optionally re-run Keepa brand search to refresh the ASIN list
  // and per-ASIN snapshot rows.
  if (body.force_brand_search) {
    try {
      const summary = await enrichBrandWithKeepa(admin as any, {
        brand_id: brand.id,
        brand_name: brand.name,
        user_id: brand.user_id,
      });
      if (summary.enrichment_error) {
        return NextResponse.json({ error: `keepa: ${summary.enrichment_error.slice(0, 200)}` }, { status: 500 });
      }
    } catch (e: any) {
      return NextResponse.json({ error: `keepa: ${e?.message ?? String(e)}` }, { status: 500 });
    }
  }

  // 4. Pull the brand's ASIN list from the existing keepa snapshot.
  const bundle = await getBrandEnrichmentBundle(admin as any, brand.id);
  const asins: string[] = ((bundle?.keepa?.asins ?? []) as any[]).map((a: any) => a.asin).filter(Boolean);
  if (!asins.length) {
    return NextResponse.json({ error: "no Keepa ASINs on brand bundle (try force_brand_search=true)" }, { status: 500 });
  }

  // 5. Pull /product details (BSR + buy-box price) for those ASINs and
  //    run the revenue estimator.
  const products = await getProductDetails(asins, 5);
  const estimate: RevenueEstimate = estimateBrandTtmRevenue(
    products.map((p) => ({
      asin: p.asin,
      sales_rank_avg365: p.sales_rank_avg365 ?? null,
      sales_rank_current: p.sales_rank_current ?? null,
      buy_box_avg365: p.buy_box_avg365 ?? null,
      buy_box_current: p.buy_box_current ?? null,
      buy_box_now: p.buy_box_price ?? null,
      product_group: p.product_group ?? null,
      root_category: p.root_category ?? null,
      category_path: p.category_tree?.map((c: any) => c.name).join(" > ") ?? null,
    })),
  );

  const newRevenue = estimate.total_ttm_revenue;
  if (newRevenue == null) {
    return NextResponse.json({
      error: "revenue estimate produced null (insufficient ASIN signal)",
      estimate,
    }, { status: 500 });
  }

  // 6. Migrate / load assumptions.
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

  const { lines, out } = rebuildMathLines(
    newRevenue,
    "Keepa BSR + price · 365-day avg",
    "estimate",
    a,
  );

  // 7. Pre/post snapshot for the response.
  const oldRevenueLine = (narrative.math?.lines ?? []).find((l) => l.key === "revenue");
  const preRevenue = typeof oldRevenueLine?.value === "number" ? oldRevenueLine.value : null;

  const brandName = narrative.brand_name || brand.name || "Your brand";
  const deltaProfit = out.delta_profit;
  const exitLift = out.exit_lift;

  const oldNotes = narrative.math?.notes ?? "";
  const cleanedNotes = oldNotes.replace(/\n*Revenue note:[\s\S]*$/, "").trim();

  const updatedNarrative: NarrativeV2 = {
    ...narrative,
    cover: {
      ...narrative.cover,
      headline: buildCoverHeadline(brandName, deltaProfit, exitLift),
      kpis: buildCoverKpis(deltaProfit, exitLift),
      delta_profit: deltaProfit,
      exit_lift: exitLift,
    },
    math: {
      lines,
      notes: cleanedNotes,
    },
  };

  // 8. Persist.
  const { error: updErr } = await admin
    .from("reports")
    .update({
      narrative_json: updatedNarrative as any,
      report_assumptions: a as any,
    } as any)
    .eq("id", reportId);
  if (updErr) return NextResponse.json({ error: `update: ${updErr.message}` }, { status: 500 });

  return NextResponse.json({
    ok: true,
    report_id: reportId,
    brand_name: brandName,
    pre_revenue: preRevenue,
    post_revenue: newRevenue,
    asins_in_sum: estimate.asins_in_sum,
    asins_excluded: estimate.asins_excluded,
    delta_profit: deltaProfit,
    exit_lift: exitLift,
    labor_tier: out.labor_tier,
    new_profit: out.new_profit,
    current_profit: out.current_profit,
  });
}
