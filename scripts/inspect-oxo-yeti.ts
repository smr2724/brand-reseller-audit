import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const reports = [
    { id: "e65caf43-26e4-4dff-82f0-ebb5cd42bd41", name: "OXO" },
    { id: "3ff56afa-9c2f-4fb0-b7e4-3d0cf0924edd", name: "Yeti" },
  ];

  for (const r of reports) {
    const { data, error } = await admin
      .from("reports")
      .select("id, brand_id, lead_id, narrative_json, report_assumptions, revenue_estimate_dollars, revenue_estimate_method")
      .eq("id", r.id)
      .maybeSingle();
    if (error) {
      console.log(`${r.name} error:`, error.message);
      continue;
    }
    const rep = data as any;
    console.log(`\n=== ${r.name} ${r.id} ===`);
    console.log("brand_id:", rep?.brand_id, "lead_id:", rep?.lead_id);
    console.log("revenue_estimate_dollars:", rep?.revenue_estimate_dollars);
    console.log("revenue_estimate_method:", rep?.revenue_estimate_method);
    const nv = rep?.narrative_json;
    if (nv) {
      console.log("brand_name:", nv.brand_name);
      console.log("cover.delta_profit:", nv.cover?.delta_profit);
      console.log("cover.exit_lift:", nv.cover?.exit_lift);
      console.log("cover.kpis:", JSON.stringify(nv.cover?.kpis));
      const revLine = nv.math?.lines?.find((l: any) => l.key === "revenue");
      console.log("math revenue line:", JSON.stringify(revLine));
      console.log("data_sources:", JSON.stringify(nv.data_sources));
      console.log("cx asin_scores count:", nv.cx_audit?.asin_scores?.length);
    }

    // List per-asin enrichment
    const { data: asinDetails, count } = await admin
      .from("asin_details")
      .select("asin, sales_rank_avg365, sales_rank_current, buy_box_avg365, buy_box_current, buy_box_now, product_group, root_category, category_path, title", { count: "exact" })
      .eq("report_id", r.id);
    console.log(`asin_details rows for report: ${count ?? asinDetails?.length}`);
    if (asinDetails && asinDetails.length > 0) {
      console.log("first 3 asin_details samples:");
      for (const a of asinDetails.slice(0, 3)) {
        console.log(" ", JSON.stringify(a));
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
