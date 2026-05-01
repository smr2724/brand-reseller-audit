/**
 * Drill 3 — final push to hit 10 strict winners. Doubles down on proven productive lanes:
 * weld/metal specialty, gel/paste formats, floor sub-niches, plus untested boring trade specialties.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { runScan } from "../src/lib/scan";

const SEEDS: { seed: string; vertical: string }[] = [
  // --- Weld / metal deep cuts (winner lane) ---
  { seed: "weld discoloration remover", vertical: "Weld Pro" },
  { seed: "weld slag remover", vertical: "Weld Pro" },
  { seed: "weld spatter remover", vertical: "Weld Pro" },
  { seed: "weld fume neutralizer", vertical: "Weld Pro" },
  { seed: "metal blackening solution", vertical: "Weld Pro" },
  { seed: "stainless passivation gel", vertical: "Weld Pro" },
  { seed: "metal pickling paste", vertical: "Weld Pro" },
  { seed: "anti spatter spray welding", vertical: "Weld Pro" },
  { seed: "weld purge gel", vertical: "Weld Pro" },
  { seed: "stainless steel weld cleaning brush kit", vertical: "Weld Pro" },
  { seed: "tig torch cleaner", vertical: "Weld Pro" },
  { seed: "plasma cutter consumable cleaner", vertical: "Weld Pro" },

  // --- Gel / paste format specialty (gel format wins) ---
  { seed: "rust remover gel", vertical: "Specialty Gel" },
  { seed: "descaler gel", vertical: "Specialty Gel" },
  { seed: "lime remover gel", vertical: "Specialty Gel" },
  { seed: "mold remover gel", vertical: "Specialty Gel" },
  { seed: "hard water gel", vertical: "Specialty Gel" },
  { seed: "scale remover paste", vertical: "Specialty Gel" },
  { seed: "oxidation remover gel", vertical: "Specialty Gel" },
  { seed: "soot remover gel", vertical: "Specialty Gel" },

  // --- Floor specialty deeper ---
  { seed: "terrazzo stripper", vertical: "Floor Pro" },
  { seed: "terrazzo restoration", vertical: "Floor Pro" },
  { seed: "gym floor stripper", vertical: "Floor Pro" },
  { seed: "sealed concrete cleaner commercial", vertical: "Floor Pro" },
  { seed: "polished concrete cleaner", vertical: "Floor Pro" },
  { seed: "vct floor finish stripper", vertical: "Floor Pro" },
  { seed: "vinyl plank floor stripper", vertical: "Floor Pro" },

  // --- Boring industrial specialty (untested) ---
  { seed: "industrial deodorizer concentrate", vertical: "Industrial Specialty" },
  { seed: "smoke odor neutralizer commercial", vertical: "Industrial Specialty" },
  { seed: "foundry release agent", vertical: "Industrial Specialty" },
  { seed: "refractory cleaner", vertical: "Industrial Specialty" },
  { seed: "kiln shelf cleaner", vertical: "Industrial Specialty" },
  { seed: "oil dry compound", vertical: "Industrial Specialty" },
  { seed: "absorbent granules industrial", vertical: "Industrial Specialty" },
  { seed: "slip resistant additive floor", vertical: "Industrial Specialty" },
  { seed: "anti static spray industrial", vertical: "Industrial Specialty" },

  // --- Boring trade specialty (untested) ---
  { seed: "hvac evaporator coil cleaner", vertical: "HVAC Pro" },
  { seed: "hvac condensate pan tablet", vertical: "HVAC Pro" },
  { seed: "boiler descaler chemical", vertical: "HVAC Pro" },
  { seed: "cooling tower biocide", vertical: "HVAC Pro" },
  { seed: "ductwork sealant aerosol", vertical: "HVAC Pro" },
  { seed: "freezer floor cleaner", vertical: "Restaurant Specialty" },
  { seed: "smoker grill cleaner", vertical: "Restaurant Specialty" },

  // --- Marine / boat specialty pro ---
  { seed: "boat hull rust stain remover", vertical: "Marine Specialty" },
  { seed: "boat barnacle remover gel", vertical: "Marine Specialty" },
  { seed: "fiberglass oxidation remover gel", vertical: "Marine Specialty" },
  { seed: "boat fender cleaner", vertical: "Marine Specialty" },

  // --- Pool deep cuts ---
  { seed: "pool tile calcium gel", vertical: "Pool Specialty" },
  { seed: "pool grout cleaner", vertical: "Pool Specialty" },
  { seed: "pool stain remover ascorbic", vertical: "Pool Specialty" },
  { seed: "pool metal sequestrant concentrate", vertical: "Pool Specialty" },
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
        raw_input: { vertical, source: "drill3_sweep" },
      }).select().single();

      const result: any = await scanWithTimeout({
        scanId: scan!.id, userId, seedKeyword: seed, depth: "standard",
        supabase, skipKeepa: true,
      }, SCAN_TIMEOUT_MS);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const reviews = result.score.metrics.top_10_avg_reviews;
      const winner = result.score.legion_score >= 80 && reviews < 300;
      const flag = winner ? "★ WINNER" : (reviews < 300 ? "" : "(too many reviews)");
      console.log(`[${i + 1}/${fresh.length}] ${seed.padEnd(42)} score=${String(result.score.legion_score).padStart(2)} reviews=${String(reviews).padStart(6)} ${flag} (${dt}s)`);
      if (winner) winners++;
    } catch (e: any) {
      console.error(`[${i + 1}/${fresh.length}] ${seed.padEnd(42)} FAIL: ${e?.message ?? e}`);
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
  console.log(`\nDrill3 winners this sweep: ${winners}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
