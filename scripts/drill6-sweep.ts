/**
 * Drill 6 — final push to 25 (loosened bar: score>=80 AND reviews<500).
 * Heavy focus on weld+gel+graffiti+descaler+pool lanes that just produced winners.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { runScan } from "../src/lib/scan";

const SEEDS: { seed: string; vertical: string }[] = [
  // --- More graffiti format/surface variants (graffiti gel + concrete both won) ---
  { seed: "anti graffiti coating", vertical: "Specialty Cleaner" },
  { seed: "graffiti barrier sacrificial", vertical: "Specialty Cleaner" },
  { seed: "spray paint remover gel", vertical: "Specialty Cleaner" },
  { seed: "marker remover wall", vertical: "Specialty Cleaner" },
  { seed: "permanent marker remover spray", vertical: "Specialty Cleaner" },
  { seed: "sharpie remover wall", vertical: "Specialty Cleaner" },

  // --- Descaler/delimer adjacencies (delimer descaler won 85/459) ---
  { seed: "delimer concentrate", vertical: "Descaler Pro" },
  { seed: "lime away commercial concentrate", vertical: "Descaler Pro" },
  { seed: "scale away commercial", vertical: "Descaler Pro" },
  { seed: "industrial descaler chemical", vertical: "Descaler Pro" },
  { seed: "industrial descaler liquid", vertical: "Descaler Pro" },
  { seed: "boiler delimer", vertical: "Descaler Pro" },
  { seed: "kettle descaler commercial", vertical: "Descaler Pro" },
  { seed: "espresso machine descaler commercial", vertical: "Descaler Pro" },
  { seed: "phosphoric acid cleaner concentrate", vertical: "Descaler Pro" },
  { seed: "muriatic acid commercial", vertical: "Descaler Pro" },
  { seed: "sulfamic acid cleaner", vertical: "Descaler Pro" },
  { seed: "citric acid cleaner concentrate", vertical: "Descaler Pro" },

  // --- Weld variants we haven't tried yet ---
  { seed: "weld cleaning machine fluid", vertical: "Weld Pro" },
  { seed: "stainless steel rouge remover", vertical: "Weld Pro" },
  { seed: "stainless steel discoloration cleaner", vertical: "Weld Pro" },
  { seed: "weld blue color remover", vertical: "Weld Pro" },
  { seed: "stainless restoration paste", vertical: "Weld Pro" },
  { seed: "metal surface conditioner stainless", vertical: "Weld Pro" },
  { seed: "weld preparation cleaner", vertical: "Weld Pro" },
  { seed: "weld root cleaner", vertical: "Weld Pro" },
  { seed: "tig finger heat shield", vertical: "Weld Pro" },

  // --- Pool/spa more ---
  { seed: "pool stain treatment ascorbic", vertical: "Pool Specialty" },
  { seed: "metal stain remover pool", vertical: "Pool Specialty" },
  { seed: "salt cell cleaner pool", vertical: "Pool Specialty" },
  { seed: "salt chlorinator descaler", vertical: "Pool Specialty" },
  { seed: "pool heater descaler", vertical: "Pool Specialty" },
  { seed: "pool plumbing descaler", vertical: "Pool Specialty" },

  // --- More floor specialty ---
  { seed: "vct stripper concentrate commercial", vertical: "Floor Pro" },
  { seed: "floor finish neutralizer", vertical: "Floor Pro" },
  { seed: "wax remover commercial concentrate", vertical: "Floor Pro" },
  { seed: "floor scrubber detergent", vertical: "Floor Pro" },
  { seed: "marble floor cleaner ph neutral", vertical: "Floor Pro" },
  { seed: "stone floor cleaner concentrate", vertical: "Floor Pro" },
  { seed: "linoleum floor cleaner", vertical: "Floor Pro" },

  // --- More gel/paste specialty ---
  { seed: "limescale remover gel", vertical: "Specialty Gel" },
  { seed: "rust converter paste", vertical: "Specialty Gel" },
  { seed: "tile rust stain remover gel", vertical: "Specialty Gel" },
  { seed: "concrete rust stain gel", vertical: "Specialty Gel" },
  { seed: "battery terminal cleaner gel", vertical: "Specialty Gel" },

  // --- Wood / deck pro ---
  { seed: "deck cleaner concentrate sodium percarbonate", vertical: "Outdoor Pro" },
  { seed: "wood brightener concentrate", vertical: "Outdoor Pro" },
  { seed: "ipe wood cleaner", vertical: "Outdoor Pro" },
  { seed: "cedar deck cleaner", vertical: "Outdoor Pro" },
  { seed: "log home cleaner", vertical: "Outdoor Pro" },

  // --- Anti-microbial / antimicrobial (specialty trade) ---
  { seed: "mildewcide additive paint", vertical: "Restoration Pro" },
  { seed: "antimicrobial paint additive", vertical: "Restoration Pro" },
  { seed: "broad spectrum disinfectant concentrate", vertical: "Restoration Pro" },
  { seed: "tuberculocidal disinfectant", vertical: "Restoration Pro" },
  { seed: "virucidal cleaner concentrate", vertical: "Restoration Pro" },

  // --- Asphalt / pavement specialty ---
  { seed: "asphalt rejuvenator", vertical: "Pavement Pro" },
  { seed: "asphalt patch material", vertical: "Pavement Pro" },
  { seed: "tar emulsion driveway sealer", vertical: "Pavement Pro" },
  { seed: "asphalt release agent truck bed", vertical: "Pavement Pro" },
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
        raw_input: { vertical, source: "drill6_sweep" },
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
  console.log(`\nDrill6 winners this sweep: ${winners}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
