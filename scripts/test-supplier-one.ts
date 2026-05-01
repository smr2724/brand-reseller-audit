/**
 * Test supplier scan for ONE opportunity (Electrochemical Weld Cleaner — score 90).
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { runSupplierScan } from "../src/lib/suppliers";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { data: signIn } = await supabase.auth.signInWithPassword({
    email: "steve@rollemanagementgroup.com", password: "LegionScan2026!",
  });
  const userId = signIn!.user!.id;

  const { data: opp } = await supabase
    .from("opportunities")
    .select("id, name, main_keyword")
    .eq("name", "Electrochemical Weld Cleaner")
    .single();
  if (!opp) { console.error("Opportunity not found"); process.exit(1); }

  console.log(`Test scanning supplier for: ${opp.name}\n`);

  const { data: scan } = await supabase.from("supplier_scans").insert({
    user_id: userId,
    opportunity_id: opp.id,
    status: "running",
    started_at: new Date().toISOString(),
    raw_input: { source: "test_one" },
  }).select().single();

  const t0 = Date.now();
  try {
    const result = await runSupplierScan({
      scanId: scan!.id,
      userId,
      opportunityId: opp.id,
      seedKeyword: opp.main_keyword,
      opportunityName: opp.name,
      supabase,
      topN: 8,
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\nDone in ${dt}s. ${result.qualified} suppliers qualified from ${result.candidates} candidates.\n`);
    console.log(`Top suppliers ranked:\n`);
    for (let i = 0; i < result.top.length; i++) {
      const s = result.top[i];
      console.log(`#${i+1}. SCORE ${s.supplier_score}  -> ${s.company_name}  (${s.domain})`);
      console.log(`     channel=${s.channel_type}  manufacturer=${s.is_manufacturer}  sells_on_amazon=${s.sells_on_amazon}`);
      console.log(`     geo: ${s.hq_city ?? "?"}, ${s.hq_state ?? "?"}, ${s.hq_country ?? "?"} (${s.geo_tier}, score ${s.geo_score})`);
      console.log(`     scores: not_amazon=${s.not_on_amazon_score} turnkey=${s.turnkey_score} geo=${s.geo_score} qual=${s.quality_score} reach=${s.reachability_score}`);
      console.log(`     path: ${s.recommended_path}`);
      if (s.fit_summary) console.log(`     fit: ${s.fit_summary}`);
      if (s.outreach_angle) console.log(`     pitch: ${s.outreach_angle}`);
      console.log();
    }
  } catch (e: any) {
    console.error(`FAIL: ${e?.message ?? e}\n${e?.stack ?? ""}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
