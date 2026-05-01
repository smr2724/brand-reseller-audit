/**
 * Run supplier scans for all winning opportunities (legion_score>=80, reviews<500).
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { runSupplierScan } from "../src/lib/suppliers";

const SCAN_TIMEOUT_MS = 240_000; // 4 min per opportunity (8 SERP queries + enrichment + Amazon check + memos)

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms)),
  ]);
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { data: signIn } = await supabase.auth.signInWithPassword({
    email: "steve@rollemanagementgroup.com", password: "LegionScan2026!",
  });
  const userId = signIn!.user!.id;

  const { data: opps } = await supabase
    .from("opportunities")
    .select("id, name, main_keyword, legion_score, top_10_avg_reviews")
    .gte("legion_score", 80).lt("top_10_avg_reviews", 500)
    .order("legion_score", { ascending: false });

  console.log(`Running supplier scans for ${opps?.length ?? 0} winning opportunities.\n`);

  let i = 0;
  for (const o of opps ?? []) {
    i++;
    const t0 = Date.now();
    try {
      // Skip if already scanned
      const { count } = await supabase
        .from("opportunity_suppliers")
        .select("*", { count: "exact", head: true })
        .eq("opportunity_id", o.id);
      if ((count ?? 0) > 0) {
        console.log(`[${i}/${opps?.length}] ${o.name}  -> already has ${count} suppliers, skipping`);
        continue;
      }

      const { data: scan } = await supabase.from("supplier_scans").insert({
        user_id: userId,
        opportunity_id: o.id,
        status: "running",
        started_at: new Date().toISOString(),
        raw_input: { source: "backfill_25_winners" },
      }).select().single();

      const result = await withTimeout(
        runSupplierScan({
          scanId: scan!.id,
          userId,
          opportunityId: o.id,
          seedKeyword: o.main_keyword,
          opportunityName: o.name,
          supabase,
          topN: 8,
        }),
        SCAN_TIMEOUT_MS,
        o.name,
      );

      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[${i}/${opps?.length}] ${o.name.padEnd(40)}  -> ${result.qualified} suppliers from ${result.candidates} candidates (${dt}s)`);
      const top3 = result.top.slice(0, 3);
      for (const s of top3) {
        console.log(`     #${s.supplier_score}  ${s.geo_tier}  ${s.channel_type}  ${s.sells_on_amazon ? "AMAZON" : "clean"}  ${s.company_name}  (${s.domain})`);
      }
    } catch (e: any) {
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`[${i}/${opps?.length}] ${o.name}  -> FAIL (${dt}s): ${e?.message ?? e}`);
    }
  }

  const { count: totalSuppliers } = await supabase.from("suppliers").select("*", { count: "exact", head: true });
  const { count: totalPairs } = await supabase.from("opportunity_suppliers").select("*", { count: "exact", head: true });
  console.log(`\nDone. Total suppliers: ${totalSuppliers}. Total pairs: ${totalPairs}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
