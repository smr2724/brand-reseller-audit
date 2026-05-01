/**
 * Drill 5 — final push to 25 winners at loosened bar (score>=80 AND reviews<500).
 * Targets the most productive lanes from drills 1-4: weld variants, gel/paste formats,
 * floor specialty, pool deep cuts, plus boring trade specialty modifiers.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { runScan } from "../src/lib/scan";

const SEEDS: { seed: string; vertical: string }[] = [
  // --- Welding variants we haven't hit yet ---
  { seed: "mig welding cleaner", vertical: "Weld Pro" },
  { seed: "stick weld cleaner", vertical: "Weld Pro" },
  { seed: "spot weld cleaner", vertical: "Weld Pro" },
  { seed: "weld neutralizer spray", vertical: "Weld Pro" },
  { seed: "stainless steel scratch remover paste", vertical: "Weld Pro" },
  { seed: "metal mirror polish paste", vertical: "Weld Pro" },
  { seed: "aluminum brightener gel", vertical: "Weld Pro" },
  { seed: "aluminum oxidation remover gel", vertical: "Weld Pro" },
  { seed: "stainless steel polish commercial", vertical: "Weld Pro" },
  { seed: "diamond plate cleaner", vertical: "Weld Pro" },
  { seed: "metal degreaser water based", vertical: "Weld Pro" },
  { seed: "rust converter gel", vertical: "Weld Pro" },

  // --- Gel/paste cleaners ---
  { seed: "calcium remover gel", vertical: "Specialty Gel" },
  { seed: "soap scum remover gel", vertical: "Specialty Gel" },
  { seed: "tile haze remover gel", vertical: "Specialty Gel" },
  { seed: "grout sealer gel", vertical: "Specialty Gel" },
  { seed: "stainless steel cleaner gel", vertical: "Specialty Gel" },
  { seed: "chrome polish paste industrial", vertical: "Specialty Gel" },
  { seed: "copper cleaner paste", vertical: "Specialty Gel" },
  { seed: "brass cleaner paste", vertical: "Specialty Gel" },

  // --- Floor / janitorial pro deeper ---
  { seed: "rubber floor stripper", vertical: "Floor Pro" },
  { seed: "epoxy floor cleaner concentrate", vertical: "Floor Pro" },
  { seed: "shop floor cleaner", vertical: "Floor Pro" },
  { seed: "warehouse floor cleaner", vertical: "Floor Pro" },
  { seed: "garage floor degreaser concentrate", vertical: "Floor Pro" },
  { seed: "epoxy garage floor coating cleaner", vertical: "Floor Pro" },
  { seed: "anti slip floor treatment", vertical: "Floor Pro" },
  { seed: "burnishable floor finish", vertical: "Floor Pro" },
  { seed: "no buff floor wax", vertical: "Floor Pro" },
  { seed: "school floor stripper", vertical: "Floor Pro" },
  { seed: "hospital floor disinfectant cleaner", vertical: "Floor Pro" },

  // --- Pool/spa deep cuts ---
  { seed: "pool stain treatment kit", vertical: "Pool Specialty" },
  { seed: "pool tile and grout cleaner", vertical: "Pool Specialty" },
  { seed: "pool surface stain remover", vertical: "Pool Specialty" },
  { seed: "pool plaster stain remover", vertical: "Pool Specialty" },
  { seed: "vinyl pool liner cleaner", vertical: "Pool Specialty" },
  { seed: "pool deck cleaner concentrate", vertical: "Pool Specialty" },
  { seed: "salt water pool cell cleaner", vertical: "Pool Specialty" },

  // --- Auto/RV/marine specialty pro ---
  { seed: "fiberglass stain remover boat", vertical: "Marine Pro" },
  { seed: "boat black streak remover", vertical: "Marine Pro" },
  { seed: "rv black streak remover", vertical: "RV Specialty" },
  { seed: "rv awning cleaner concentrate", vertical: "RV Specialty" },
  { seed: "rv roof cleaner", vertical: "RV Specialty" },
  { seed: "rv tire cover cleaner", vertical: "RV Specialty" },
  { seed: "trailer aluminum cleaner", vertical: "RV Specialty" },

  // --- HVAC / mechanical ---
  { seed: "ac coil cleaner self rinse", vertical: "HVAC Pro" },
  { seed: "ac coil cleaner foaming", vertical: "HVAC Pro" },
  { seed: "evaporator coil brightener", vertical: "HVAC Pro" },
  { seed: "condenser coil cleaner foam", vertical: "HVAC Pro" },
  { seed: "ductwork antimicrobial spray", vertical: "HVAC Pro" },
  { seed: "ice machine descaler", vertical: "HVAC Pro" },

  // --- Restaurant pro ---
  { seed: "deep fryer cleaner concentrate", vertical: "Restaurant Specialty" },
  { seed: "oven cleaner commercial spray", vertical: "Restaurant Specialty" },
  { seed: "dishwasher rinse aid commercial", vertical: "Restaurant Specialty" },
  { seed: "kitchen exhaust cleaner concentrate", vertical: "Restaurant Specialty" },
  { seed: "stainless steel kitchen polish", vertical: "Restaurant Specialty" },

  // --- Outdoor pro ---
  { seed: "concrete moss algae remover", vertical: "Outdoor Pro" },
  { seed: "patio paver cleaner concentrate", vertical: "Outdoor Pro" },
  { seed: "stone restoration cleaner", vertical: "Outdoor Pro" },
  { seed: "limestone cleaner exterior", vertical: "Outdoor Pro" },
  { seed: "brick cleaner muriatic alternative", vertical: "Outdoor Pro" },
  { seed: "deck oil stripper", vertical: "Outdoor Pro" },
  { seed: "wood fence cleaner concentrate", vertical: "Outdoor Pro" },
  { seed: "vinyl siding mildew cleaner", vertical: "Outdoor Pro" },

  // --- Plumbing/drain ---
  { seed: "main line drain opener foaming", vertical: "Plumbing Pro" },
  { seed: "drain enzyme bacteria treatment", vertical: "Plumbing Pro" },
  { seed: "delimer descaler concentrate", vertical: "Plumbing Pro" },

  // --- Niche specialty ---
  { seed: "graffiti remover spray paint", vertical: "Specialty Cleaner" },
  { seed: "graffiti remover concrete", vertical: "Specialty Cleaner" },
  { seed: "tag away graffiti remover", vertical: "Specialty Cleaner" },
  { seed: "ink stain remover concrete", vertical: "Specialty Cleaner" },
  { seed: "asphalt cleaner degreaser", vertical: "Specialty Cleaner" },
  { seed: "asphalt sealer concrete", vertical: "Specialty Cleaner" },

  // --- Niche: paint contractor pro ---
  { seed: "paint stripper for concrete", vertical: "Paint Contractor" },
  { seed: "paint stripper professional gel", vertical: "Paint Contractor" },
  { seed: "lead paint encapsulant", vertical: "Paint Contractor" },
  { seed: "tsp substitute concentrate", vertical: "Paint Contractor" },
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
        raw_input: { vertical, source: "drill5_sweep" },
      }).select().single();

      const result: any = await scanWithTimeout({
        scanId: scan!.id, userId, seedKeyword: seed, depth: "standard",
        supabase, skipKeepa: true,
      }, SCAN_TIMEOUT_MS);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const reviews = result.score.metrics.top_10_avg_reviews;
      // LOOSENED BAR: score >= 80 AND reviews < 500
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
  console.log(`\n=== STRICT WINNERS (score>=80 AND top-10 reviews<500) — total ${top?.length ?? 0} ===\n`);
  for (const o of top ?? []) {
    console.log(`  ${o.legion_score}  reviews=${String(o.top_10_avg_reviews).padStart(4)}  sv=${String(o.monthly_search_volume ?? 0).padStart(6)}  cluster=${String(o.total_cluster_search_volume ?? 0).padStart(6)}  $${o.avg_price}  ${o.recommended_path}  →  ${o.name}`);
  }
  console.log(`\nDrill5 winners this sweep: ${winners}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
