/**
 * Batch scan driver — runs the scan pipeline for a list of seed keywords
 * and persists results into Supabase as Steve's user.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { runScan } from "../src/lib/scan";

const SEEDS = [
  "concrete remover",
  "rust stain remover",
  "rust remover for concrete",
  "graffiti remover",
  "commercial degreaser",
  "industrial degreaser",
  "oil stain remover for concrete",
  "grout haze remover",
  "adhesive remover",
  "floor stripper",
  "commercial descaler",
  "ice machine cleaner",
  "boat hull cleaner",
  "rv roof cleaner",
  "mold stain remover",
  "hard water stain remover",
  "equipment cleaner",
  "odor eliminator",
  "asphalt release agent",
  "commercial kitchen degreaser",
];

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  console.log("Signing in as Steve...");
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email: "steve@rollemanagementgroup.com",
    password: "LegionScan2026!",
  });
  if (signInError) {
    console.error("Sign-in failed:", signInError);
    process.exit(1);
  }
  const userId = signInData.user!.id;
  console.log(`Signed in as ${signInData.user!.email} (${userId})`);

  const limitArg = process.argv[2];
  const seeds = limitArg ? SEEDS.slice(0, Number(limitArg)) : SEEDS;
  console.log(`Running ${seeds.length} scans...`);

  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    const t0 = Date.now();
    console.log(`\n[${i + 1}/${seeds.length}] ${seed}`);
    try {
      // Create scan row
      const { data: scan, error: scanErr } = await supabase
        .from("scans")
        .insert({
          user_id: userId,
          seed_keyword: seed,
          marketplace: "amazon_us",
          scan_depth: "standard",
          status: "running",
          started_at: new Date().toISOString(),
        })
        .select()
        .single();
      if (scanErr) throw scanErr;

      const result = await runScan({
        scanId: scan.id,
        userId,
        seedKeyword: seed,
        depth: "standard",
        supabase,
        skipKeepa: true, // batch run — conserve tokens
      });
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ✓ score=${result.score.legion_score} path=${result.score.recommended_path} (${dt}s)`);
      if (result.errors.length) console.log(`  errors: ${result.errors.join(" | ")}`);
      if (Object.values(result.usedMock).some(Boolean)) {
        console.log(`  used mock for: ${Object.entries(result.usedMock).filter(([_, v]) => v).map(([k]) => k).join(", ")}`);
      }
    } catch (e: any) {
      console.error(`  ✗ FAIL:`, e?.message ?? e);
      // Continue to next seed
    }
  }

  // Print final ranked summary
  console.log("\n=== Final Ranked Results ===");
  const { data: opps } = await supabase
    .from("opportunities")
    .select("name, legion_score, recommended_path, status, demand_score, competition_weakness_score, product_advantage_score, visual_demo_score, economics_score, partner_score")
    .order("legion_score", { ascending: false });
  if (opps) {
    for (const o of opps) {
      console.log(`  ${o.legion_score}  ${(o.recommended_path ?? "—").padEnd(8)}  ${(o.status ?? "—").padEnd(10)}  ${o.name}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
