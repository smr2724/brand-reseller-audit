/**
 * Drill 7 — final 4+ winners. Bias hard toward newly proven lanes:
 * descaler/delimer, weld prep, stone/specialty floor, marker/spray paint remover, pool cell/heater.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { runScan } from "../src/lib/scan";

const SEEDS: { seed: string; vertical: string }[] = [
  // --- Descaler/delimer adjacencies (just won 2 here) ---
  { seed: "coffee equipment descaler", vertical: "Descaler Pro" },
  { seed: "ice maker descaler concentrate", vertical: "Descaler Pro" },
  { seed: "industrial dishwasher delimer", vertical: "Descaler Pro" },
  { seed: "boiler chemical descaler", vertical: "Descaler Pro" },
  { seed: "tankless water heater descaler kit", vertical: "Descaler Pro" },
  { seed: "humidifier descaler", vertical: "Descaler Pro" },
  { seed: "steam cleaner descaler", vertical: "Descaler Pro" },
  { seed: "lime scale dissolver concentrate", vertical: "Descaler Pro" },

  // --- Marker / paint / ink remover variants ---
  { seed: "ink remover spray industrial", vertical: "Specialty Cleaner" },
  { seed: "stamp ink remover", vertical: "Specialty Cleaner" },
  { seed: "dry erase marker stain remover", vertical: "Specialty Cleaner" },
  { seed: "highlighter stain remover", vertical: "Specialty Cleaner" },
  { seed: "graffiti remover safer alternative", vertical: "Specialty Cleaner" },
  { seed: "paint overspray remover", vertical: "Specialty Cleaner" },

  // --- Stone / specialty floor pro ---
  { seed: "natural stone cleaner ph neutral", vertical: "Floor Pro" },
  { seed: "limestone floor cleaner concentrate", vertical: "Floor Pro" },
  { seed: "marble cleaner commercial concentrate", vertical: "Floor Pro" },
  { seed: "granite countertop cleaner concentrate", vertical: "Floor Pro" },
  { seed: "travertine floor cleaner concentrate", vertical: "Floor Pro" },
  { seed: "slate floor cleaner concentrate", vertical: "Floor Pro" },
  { seed: "quartz cleaner concentrate", vertical: "Floor Pro" },

  // --- Weld prep / weld lane more ---
  { seed: "weld surface conditioner", vertical: "Weld Pro" },
  { seed: "weld cleaning solution concentrate", vertical: "Weld Pro" },
  { seed: "metal prep solution welding", vertical: "Weld Pro" },
  { seed: "weld discoloration neutralizer", vertical: "Weld Pro" },
  { seed: "stainless cleaning solution", vertical: "Weld Pro" },
  { seed: "phosphoric weld cleaner", vertical: "Weld Pro" },

  // --- Pool/spa specialty more ---
  { seed: "salt chlorinator cell cleaner", vertical: "Pool Specialty" },
  { seed: "pool heat exchanger descaler", vertical: "Pool Specialty" },
  { seed: "pool plumbing cleaner concentrate", vertical: "Pool Specialty" },
  { seed: "spa jet cleaner concentrate", vertical: "Pool Specialty" },
  { seed: "hot tub flush cleaner", vertical: "Pool Specialty" },

  // --- Niche specialty trade ---
  { seed: "concrete sealer remover gel", vertical: "Concrete Pro" },
  { seed: "efflorescence remover concrete", vertical: "Concrete Pro" },
  { seed: "stucco cleaner concentrate", vertical: "Concrete Pro" },
  { seed: "tile cleaner concentrate commercial", vertical: "Floor Pro" },
  { seed: "porcelain tile haze remover", vertical: "Floor Pro" },
  { seed: "thinset remover concrete", vertical: "Floor Pro" },

  // --- More floor finish niches ---
  { seed: "vct sealer concentrate", vertical: "Floor Pro" },
  { seed: "concrete polish liquid", vertical: "Floor Pro" },
  { seed: "polyurethane floor finish remover", vertical: "Floor Pro" },
  { seed: "zinc free floor finish", vertical: "Floor Pro" },
  { seed: "two coat floor finish commercial", vertical: "Floor Pro" },
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
  console.log(`${fresh.length} new seeds (${SEEDS.length - fresh.length} already scanned).\n`);

  let winners = 0;
  for (let i = 0; i < fresh.length; i++) {
    const { seed, vertical } = fresh[i];
    const t0 = Date.now();
    try {
      const { data: scan } = await supabase.from("scans").insert({
        user_id: userId, seed_keyword: seed, marketplace: "amazon_us",
        scan_depth: "standard", status: "running", started_at: new Date().toISOString(),
        raw_input: { vertical, source: "drill7_sweep" },
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
    .select("name, legion_score, recommended_path, top_10_avg_reviews, monthly_search_volume, total_cluster_search_volume, avg_price")
    .gte("legion_score", 80).lt("top_10_avg_reviews", 500)
    .order("legion_score", { ascending: false });
  console.log(`\n=== WINNERS (score>=80 AND top-10 reviews<500) — total ${top?.length ?? 0} ===\n`);
  for (const o of top ?? []) {
    console.log(`  ${o.legion_score}  reviews=${String(o.top_10_avg_reviews).padStart(4)}  sv=${String(o.monthly_search_volume ?? 0).padStart(6)}  cluster=${String(o.total_cluster_search_volume ?? 0).padStart(6)}  $${o.avg_price}  ${o.recommended_path}  →  ${o.name}`);
  }
  console.log(`\nDrill7 winners this sweep: ${winners}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
