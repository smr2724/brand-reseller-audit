/**
 * Drill 2 — go deeper into the productive lanes (weld/metal, floor stripper, pool specialty)
 * plus untested adjacent verticals. Hunting for 5 more strict winners.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { runScan } from "../src/lib/scan";

const SEEDS: { seed: string; vertical: string }[] = [
  // --- More weld/metal/passivation (winners' lane) ---
  { seed: "weld cleaning machine", vertical: "Weld Pro" },
  { seed: "tig weld cleaner", vertical: "Weld Pro" },
  { seed: "mig weld cleaner", vertical: "Weld Pro" },
  { seed: "weld bead cleaner", vertical: "Weld Pro" },
  { seed: "stainless steel post weld cleaner", vertical: "Weld Pro" },
  { seed: "aluminum weld cleaner", vertical: "Weld Pro" },
  { seed: "passivation solution citric", vertical: "Weld Pro" },
  { seed: "stainless steel pickling gel", vertical: "Weld Pro" },
  { seed: "metal preparation cleaner", vertical: "Weld Pro" },
  { seed: "industrial metal degreaser citrus", vertical: "Weld Pro" },

  // --- More floor stripper / VCT pro ---
  { seed: "high speed floor stripper", vertical: "Floor Pro" },
  { seed: "low foam floor stripper", vertical: "Floor Pro" },
  { seed: "no scrub floor stripper", vertical: "Floor Pro" },
  { seed: "concentrated floor stripper", vertical: "Floor Pro" },
  { seed: "floor finish remover commercial", vertical: "Floor Pro" },
  { seed: "marble floor cleaner commercial", vertical: "Floor Pro" },
  { seed: "linoleum floor cleaner commercial", vertical: "Floor Pro" },
  { seed: "rubber floor stripper", vertical: "Floor Pro" },
  { seed: "epoxy floor stripper", vertical: "Floor Pro" },

  // --- More pool specialty (winner lane) ---
  { seed: "pool calcium silicate remover", vertical: "Pool Specialty" },
  { seed: "pool tile cleaner gel", vertical: "Pool Specialty" },
  { seed: "pool spa surface cleaner", vertical: "Pool Specialty" },
  { seed: "pool acid wash", vertical: "Pool Specialty" },
  { seed: "pool oil absorber", vertical: "Pool Specialty" },
  { seed: "pool waterline scum remover", vertical: "Pool Specialty" },
  { seed: "pool deck cleaner concrete", vertical: "Pool Specialty" },
  { seed: "pool plaster brightener", vertical: "Pool Specialty" },

  // --- Tile / grout pro (untested) ---
  { seed: "grout colorant", vertical: "Tile/Grout Pro" },
  { seed: "grout sealer applicator", vertical: "Tile/Grout Pro" },
  { seed: "grout reviver", vertical: "Tile/Grout Pro" },
  { seed: "grout brightener pen", vertical: "Tile/Grout Pro" },
  { seed: "tile haze remover", vertical: "Tile/Grout Pro" },
  { seed: "porcelain tile cleaner heavy duty", vertical: "Tile/Grout Pro" },
  { seed: "natural stone cleaner commercial", vertical: "Tile/Grout Pro" },
  { seed: "saltillo tile sealer", vertical: "Tile/Grout Pro" },

  // --- Specialty industrial cleaning gels/pastes ---
  { seed: "rust dissolver gel", vertical: "Specialty Gel" },
  { seed: "calcium dissolver gel", vertical: "Specialty Gel" },
  { seed: "lime dissolver gel", vertical: "Specialty Gel" },
  { seed: "graffiti remover gel", vertical: "Specialty Gel" },
  { seed: "concrete dissolver gel", vertical: "Specialty Gel" },
  { seed: "paint stripper gel", vertical: "Specialty Gel" },
  { seed: "cleaning gel for car interior", vertical: "Specialty Gel" },

  // --- Specialty paint contractor ---
  { seed: "drywall mud cleaner", vertical: "Paint Contractor" },
  { seed: "spray gun cleaner", vertical: "Paint Contractor" },
  { seed: "paint roller cleaner", vertical: "Paint Contractor" },
  { seed: "lacquer thinner pro", vertical: "Paint Contractor" },
  { seed: "paint overspray cleaner concrete", vertical: "Paint Contractor" },
  { seed: "stucco patch", vertical: "Paint Contractor" },

  // --- Specialty kitchen/restaurant pro deeper ---
  { seed: "pizza oven cleaner", vertical: "Restaurant Specialty" },
  { seed: "deep fryer cleaner", vertical: "Restaurant Specialty" },
  { seed: "carbon remover for oven", vertical: "Restaurant Specialty" },
  { seed: "stainless steel polish food grade", vertical: "Restaurant Specialty" },
  { seed: "walk in cooler cleaner", vertical: "Restaurant Specialty" },

  // --- Specialty automotive shop pro ---
  { seed: "engine bay cleaner", vertical: "Auto Shop Pro" },
  { seed: "brake parts cleaner non chlorinated", vertical: "Auto Shop Pro" },
  { seed: "transmission flush concentrate", vertical: "Auto Shop Pro" },
  { seed: "diesel particulate filter cleaner", vertical: "Auto Shop Pro" },
  { seed: "intake valve cleaner", vertical: "Auto Shop Pro" },
  { seed: "throttle body cleaner", vertical: "Auto Shop Pro" },

  // --- Specialty industrial outdoor ---
  { seed: "playground equipment cleaner", vertical: "Outdoor Pro" },
  { seed: "pavement marking remover", vertical: "Outdoor Pro" },
  { seed: "concrete efflorescence remover", vertical: "Outdoor Pro" },
  { seed: "shipping container cleaner", vertical: "Outdoor Pro" },
  { seed: "cargo trailer floor cleaner", vertical: "Outdoor Pro" },
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
        raw_input: { vertical, source: "drill2_sweep" },
      }).select().single();

      const result: any = await scanWithTimeout({
        scanId: scan!.id, userId, seedKeyword: seed, depth: "standard",
        supabase, skipKeepa: true,
      }, SCAN_TIMEOUT_MS);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const reviews = result.score.metrics.top_10_avg_reviews;
      const winner = result.score.legion_score >= 80 && reviews < 300;
      const flag = winner ? "★ WINNER" : (reviews < 300 ? "" : "(too many reviews)");
      console.log(`[${i + 1}/${fresh.length}] ${seed.padEnd(40)} score=${String(result.score.legion_score).padStart(2)} reviews=${String(reviews).padStart(6)} ${flag} (${dt}s)`);
      if (winner) winners++;
    } catch (e: any) {
      console.error(`[${i + 1}/${fresh.length}] ${seed.padEnd(40)} FAIL: ${e?.message ?? e}`);
    }
  }

  const { data: top } = await supabase
    .from("opportunities")
    .select("name, legion_score, recommended_path, top_10_avg_reviews, monthly_search_volume, total_cluster_search_volume, avg_price")
    .gte("legion_score", 80).lt("top_10_avg_reviews", 300)
    .order("legion_score", { ascending: false });
  console.log(`\n=== STRICT WINNERS (score>=80 AND top-10 reviews<300) — total ${top?.length ?? 0} ===\n`);
  for (const o of top ?? []) {
    console.log(`  ${o.legion_score}  reviews=${String(o.top_10_avg_reviews).padStart(4)}  sv=${String(o.monthly_search_volume ?? 0).padStart(6)}  cluster=${String(o.total_cluster_search_volume ?? 0).padStart(6)}  $${o.avg_price}  ${o.recommended_path}  →  ${o.name}`);
  }
  console.log(`\nDrill2 winners this sweep: ${winners}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
