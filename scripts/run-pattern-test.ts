/**
 * Pattern-test sweep — 1 best-bet seed per Legion-shaped vertical.
 * Goal: find which non-chemical categories score 80+ before going wide.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { runScan } from "../src/lib/scan";

const SEEDS: { seed: string; vertical: string }[] = [
  { seed: "mole repellent", vertical: "Pest & Wildlife" },
  { seed: "headlight restoration kit", vertical: "Auto Detailing" },
  { seed: "pool stain remover", vertical: "Pool & Spa" },
  { seed: "dishwasher descaler", vertical: "HVAC & Appliance" },
  { seed: "stump remover", vertical: "Lawn & Turf" },
  { seed: "cat urine enzyme cleaner", vertical: "Pet Odor & Utility" },
  { seed: "stripped screw extractor", vertical: "Tools Specialty" },
  { seed: "rv holding tank treatment", vertical: "Marine & RV" },
];

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { data: signIn, error: signInError } = await supabase.auth.signInWithPassword({
    email: "steve@rollemanagementgroup.com",
    password: "LegionScan2026!",
  });
  if (signInError) { console.error("Sign-in failed:", signInError); process.exit(1); }
  const userId = signIn.user!.id;
  console.log(`Signed in (${userId})`);
  console.log(`Running ${SEEDS.length} pattern-test scans...\n`);

  for (let i = 0; i < SEEDS.length; i++) {
    const { seed, vertical } = SEEDS[i];
    const t0 = Date.now();
    console.log(`[${i + 1}/${SEEDS.length}] ${vertical}: "${seed}"`);
    try {
      const { data: scan, error: scanErr } = await supabase
        .from("scans")
        .insert({
          user_id: userId,
          seed_keyword: seed,
          marketplace: "amazon_us",
          scan_depth: "standard",
          status: "running",
          started_at: new Date().toISOString(),
          raw_input: { vertical, source: "pattern_test" },
        })
        .select().single();
      if (scanErr) throw scanErr;

      const result = await runScan({
        scanId: scan.id, userId, seedKeyword: seed, depth: "standard",
        supabase, skipKeepa: true,
      });
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ✓ score=${result.score.legion_score} path=${result.score.recommended_path} (${dt}s)`);
    } catch (e: any) {
      console.error(`  ✗ FAIL:`, e?.message ?? e);
    }
  }

  console.log("\n=== Pattern-Test Results (this sweep) ===");
  const { data: opps } = await supabase
    .from("opportunities")
    .select("name, legion_score, recommended_path, status, monthly_search_volume, total_cluster_search_volume, top_10_avg_reviews, top_10_avg_rating, avg_price")
    .in("main_keyword", SEEDS.map(s => s.seed))
    .order("legion_score", { ascending: false });
  if (opps) {
    for (const o of opps) {
      console.log(`  ${o.legion_score}  ${(o.recommended_path ?? "—").padEnd(8)}  ${(o.status ?? "—").padEnd(10)}  ${o.name}  (sv ${o.monthly_search_volume ?? "?"}, cluster ${o.total_cluster_search_volume ?? "?"})`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
