/**
 * Drill 8 — finisher to cross 25. 12 surgical seeds in hottest proven lanes.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { runScan } from "../src/lib/scan";

const SEEDS: { seed: string; vertical: string }[] = [
  // Marker / wall lane (3 winners so far)
  { seed: "wall mark eraser commercial", vertical: "Specialty Cleaner" },
  { seed: "crayon remover wall", vertical: "Specialty Cleaner" },
  { seed: "scuff remover wall", vertical: "Specialty Cleaner" },
  // Stone floor lane (2 winners so far)
  { seed: "stone restoration polishing powder", vertical: "Floor Pro" },
  { seed: "tile and grout cleaner concentrate", vertical: "Floor Pro" },
  { seed: "concrete densifier sealer", vertical: "Floor Pro" },
  // Descaler lane (2 winners so far)
  { seed: "milk frother descaler", vertical: "Descaler Pro" },
  { seed: "dishwasher delimer concentrate", vertical: "Descaler Pro" },
  // Weld prep lane (2 winners so far)
  { seed: "metal etching solution", vertical: "Weld Pro" },
  { seed: "metal pre paint cleaner", vertical: "Weld Pro" },
  // Pool cell lane (2 winners so far)
  { seed: "swimming pool salt cell descaler", vertical: "Pool Specialty" },
  { seed: "pool equipment descaler concentrate", vertical: "Pool Specialty" },
];

const SCAN_TIMEOUT_MS = 90_000;

async function scanWithTimeout(args: any, ms: number) {
  return await Promise.race([
    runScan(args),
    new Promise((_, rej) => setTimeout(() => rej(new Error("scan timeout")), ms)),
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

  const { data: existing } = await supabase.from("opportunities").select("main_keyword");
  const already = new Set((existing ?? []).map((r: any) => (r.main_keyword || "").toLowerCase()));
  const fresh = SEEDS.filter(s => !already.has(s.seed.toLowerCase()));
  console.log(`${fresh.length} new seeds.\n`);

  let winners = 0;
  for (let i = 0; i < fresh.length; i++) {
    const { seed, vertical } = fresh[i];
    const t0 = Date.now();
    try {
      const { data: scan } = await supabase.from("scans").insert({
        user_id: userId, seed_keyword: seed, marketplace: "amazon_us",
        scan_depth: "standard", status: "running", started_at: new Date().toISOString(),
        raw_input: { vertical, source: "drill8_finisher" },
      }).select().single();

      const result: any = await scanWithTimeout({
        scanId: scan!.id, userId, seedKeyword: seed, depth: "standard",
        supabase, skipKeepa: true,
      }, SCAN_TIMEOUT_MS);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const reviews = result.score.metrics.top_10_avg_reviews;
      const winner = result.score.legion_score >= 80 && reviews < 500;
      const flag = winner ? "★ WINNER" : (reviews < 500 ? "" : "(reviews 500+)");
      console.log(`[${i + 1}/${fresh.length}] ${seed.padEnd(48)} score=${String(result.score.legion_score).padStart(2)} reviews=${String(reviews).padStart(6)} ${flag} (${dt}s)`);
      if (winner) winners++;
    } catch (e: any) {
      console.error(`[${i + 1}/${fresh.length}] ${seed.padEnd(48)} FAIL: ${e?.message ?? e}`);
    }
  }

  const { data: top } = await supabase
    .from("opportunities")
    .select("name, legion_score")
    .gte("legion_score", 80).lt("top_10_avg_reviews", 500)
    .order("legion_score", { ascending: false });
  console.log(`\nTOTAL WINNERS NOW: ${top?.length ?? 0}`);
  console.log(`Drill8 winners this sweep: ${winners}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
