/**
 * Wide sweep — find Legion-shape opportunities where top-10 avg reviews < 300
 * and Legion Score >= 80. Targets ~100 hyper-specific, low-attention seeds
 * across boring/utilitarian verticals.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { runScan } from "../src/lib/scan";

const SEEDS: { seed: string; vertical: string }[] = [
  // --- Specialty trades supplies (HVAC / plumbing / electrical / roofing) ---
  { seed: "ac evaporator coil cleaner", vertical: "HVAC Pro" },
  { seed: "boiler descaler", vertical: "HVAC Pro" },
  { seed: "cooling tower biocide", vertical: "HVAC Pro" },
  { seed: "condensate pan tablets", vertical: "HVAC Pro" },
  { seed: "drain line treatment hvac", vertical: "HVAC Pro" },
  { seed: "duct sealant brushable", vertical: "HVAC Pro" },
  { seed: "electrical contact cleaner", vertical: "Electrical Pro" },
  { seed: "wire pulling lubricant", vertical: "Electrical Pro" },
  { seed: "anti-seize compound electrical", vertical: "Electrical Pro" },
  { seed: "cable lubricant gel", vertical: "Electrical Pro" },
  { seed: "pvc primer purple", vertical: "Plumbing Pro" },
  { seed: "thread sealant for gas lines", vertical: "Plumbing Pro" },
  { seed: "drain field treatment", vertical: "Plumbing Pro" },
  { seed: "septic tank enzyme treatment", vertical: "Plumbing Pro" },
  { seed: "well water sediment treatment", vertical: "Plumbing Pro" },
  { seed: "roof tar sealant", vertical: "Roofing Pro" },
  { seed: "rv roof rubber coating", vertical: "Roofing Pro" },
  { seed: "metal roof sealant", vertical: "Roofing Pro" },
  { seed: "flat roof sealant", vertical: "Roofing Pro" },
  { seed: "moss killer for roof", vertical: "Roofing Pro" },

  // --- Specialty livestock & farm ---
  { seed: "chicken coop cleaner", vertical: "Livestock" },
  { seed: "horse hoof oil", vertical: "Livestock" },
  { seed: "goat dewormer", vertical: "Livestock" },
  { seed: "cattle ear tag", vertical: "Livestock" },
  { seed: "pig wormer", vertical: "Livestock" },
  { seed: "beekeeping smoker fuel", vertical: "Livestock" },
  { seed: "varroa mite treatment", vertical: "Livestock" },
  { seed: "rabbit cage cleaner", vertical: "Livestock" },

  // --- Restoration / mitigation pro ---
  { seed: "smoke odor encapsulator", vertical: "Restoration" },
  { seed: "fire damage cleaner", vertical: "Restoration" },
  { seed: "soot sponge", vertical: "Restoration" },
  { seed: "water damage drying agent", vertical: "Restoration" },
  { seed: "mold encapsulant", vertical: "Restoration" },
  { seed: "asbestos encapsulant", vertical: "Restoration" },
  { seed: "lead paint encapsulant", vertical: "Restoration" },

  // --- Hyper-specific outdoor / deck ---
  { seed: "cedar deck cleaner", vertical: "Outdoor Wood" },
  { seed: "ipe wood cleaner", vertical: "Outdoor Wood" },
  { seed: "log home cleaner", vertical: "Outdoor Wood" },
  { seed: "pressure treated deck cleaner", vertical: "Outdoor Wood" },
  { seed: "fence brightener", vertical: "Outdoor Wood" },

  // --- Specialty pest sub-niches ---
  { seed: "carpenter ant killer outdoor", vertical: "Pest Specialty" },
  { seed: "yellow jacket trap bait", vertical: "Pest Specialty" },
  { seed: "no see um repellent", vertical: "Pest Specialty" },
  { seed: "deer repellent for plants", vertical: "Pest Specialty" },
  { seed: "armadillo repellent", vertical: "Pest Specialty" },
  { seed: "raccoon repellent", vertical: "Pest Specialty" },
  { seed: "groundhog repellent", vertical: "Pest Specialty" },
  { seed: "chipmunk repellent", vertical: "Pest Specialty" },
  { seed: "japanese beetle trap", vertical: "Pest Specialty" },
  { seed: "stink bug trap", vertical: "Pest Specialty" },
  { seed: "boxelder bug killer", vertical: "Pest Specialty" },

  // --- Specialty cleaning sub-niches ---
  { seed: "diamond plate aluminum cleaner", vertical: "Specialty Cleaning" },
  { seed: "stainless steel weld cleaner", vertical: "Specialty Cleaning" },
  { seed: "copper patina remover", vertical: "Specialty Cleaning" },
  { seed: "brass tarnish remover", vertical: "Specialty Cleaning" },
  { seed: "calcium remover for glass", vertical: "Specialty Cleaning" },
  { seed: "limescale remover for showerhead", vertical: "Specialty Cleaning" },
  { seed: "battery terminal corrosion cleaner", vertical: "Specialty Cleaning" },
  { seed: "evaporator coil foam cleaner", vertical: "Specialty Cleaning" },
  { seed: "vinyl siding cleaner", vertical: "Specialty Cleaning" },
  { seed: "stucco cleaner", vertical: "Specialty Cleaning" },

  // --- Specialty motorcycle / off-road / tractor ---
  { seed: "motorcycle chain cleaner", vertical: "Motorsport" },
  { seed: "dirt bike air filter oil", vertical: "Motorsport" },
  { seed: "atv tire sealant", vertical: "Motorsport" },
  { seed: "tractor radiator flush", vertical: "Motorsport" },
  { seed: "diesel injector cleaner heavy duty", vertical: "Motorsport" },
  { seed: "snowmobile clutch cleaner", vertical: "Motorsport" },
  { seed: "semi truck wash", vertical: "Motorsport" },

  // --- Specialty firearms / hunting maintenance ---
  { seed: "gun barrel cleaner", vertical: "Firearms Care" },
  { seed: "bore solvent", vertical: "Firearms Care" },
  { seed: "rust inhibitor for guns", vertical: "Firearms Care" },
  { seed: "scent eliminator for hunting", vertical: "Firearms Care" },

  // --- Specialty arts / industrial supplies ---
  { seed: "epoxy resin cleaner", vertical: "Maker / Industrial" },
  { seed: "mold release agent silicone", vertical: "Maker / Industrial" },
  { seed: "polyurethane stripper", vertical: "Maker / Industrial" },
  { seed: "ceramic kiln cleaner", vertical: "Maker / Industrial" },
  { seed: "3d printer bed adhesion", vertical: "Maker / Industrial" },
  { seed: "laser engraver lens cleaner", vertical: "Maker / Industrial" },
  { seed: "cnc coolant", vertical: "Maker / Industrial" },

  // --- Janitorial / facility deep cuts ---
  { seed: "urinal screen deodorizer", vertical: "Janitorial" },
  { seed: "drain fly killer commercial", vertical: "Janitorial" },
  { seed: "wax stripper for vct", vertical: "Janitorial" },
  { seed: "vct floor sealer", vertical: "Janitorial" },
  { seed: "carpet extractor solution", vertical: "Janitorial" },
  { seed: "encapsulation carpet cleaner", vertical: "Janitorial" },

  // --- Specialty pool / spa deep cuts ---
  { seed: "pool plaster stain remover", vertical: "Pool Specialty" },
  { seed: "pool waterline cleaner", vertical: "Pool Specialty" },
  { seed: "pool tile calcium remover", vertical: "Pool Specialty" },
  { seed: "salt cell cleaner", vertical: "Pool Specialty" },
  { seed: "pool filter cartridge cleaner", vertical: "Pool Specialty" },
  { seed: "pool metal stain remover", vertical: "Pool Specialty" },
  { seed: "spa filter cleaner", vertical: "Pool Specialty" },

  // --- Specialty kitchen / restaurant pro ---
  { seed: "fryer boil out", vertical: "Restaurant Pro" },
  { seed: "ice machine descaler", vertical: "Restaurant Pro" },
  { seed: "char broiler cleaner", vertical: "Restaurant Pro" },
  { seed: "hood filter degreaser", vertical: "Restaurant Pro" },
  { seed: "dish machine descaler", vertical: "Restaurant Pro" },
  { seed: "grease trap treatment", vertical: "Restaurant Pro" },

  // --- Lawn pro deep cuts ---
  { seed: "sewer line root killer", vertical: "Lawn Pro" },
  { seed: "nutsedge killer", vertical: "Lawn Pro" },
  { seed: "dollar weed killer", vertical: "Lawn Pro" },
  { seed: "wild violet killer", vertical: "Lawn Pro" },
  { seed: "lawn fungicide for brown patch", vertical: "Lawn Pro" },
  { seed: "moss killer for lawn", vertical: "Lawn Pro" },
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

  const { data: signIn, error: signInError } = await supabase.auth.signInWithPassword({
    email: "steve@rollemanagementgroup.com",
    password: "LegionScan2026!",
  });
  if (signInError) { console.error("Sign-in failed:", signInError); process.exit(1); }
  const userId = signIn.user!.id;

  // De-dup against already-scanned seeds in DB
  const { data: existing } = await supabase
    .from("opportunities")
    .select("main_keyword");
  const already = new Set((existing ?? []).map((r: any) => (r.main_keyword || "").toLowerCase()));
  const fresh = SEEDS.filter(s => !already.has(s.seed.toLowerCase()));
  console.log(`${fresh.length} new seeds to scan (${SEEDS.length - fresh.length} already scanned).\n`);

  let winners = 0;
  for (let i = 0; i < fresh.length; i++) {
    const { seed, vertical } = fresh[i];
    const t0 = Date.now();
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
          raw_input: { vertical, source: "wide_sweep" },
        })
        .select().single();
      if (scanErr) throw scanErr;

      const result: any = await scanWithTimeout({
        scanId: scan.id, userId, seedKeyword: seed, depth: "standard",
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

  console.log(`\nDone. Winners this sweep: ${winners}`);

  // Pull all 80+ winners with reviews <300 across the whole DB
  const { data: top } = await supabase
    .from("opportunities")
    .select("name, main_keyword, legion_score, recommended_path, status, top_10_avg_reviews, top_10_avg_rating, monthly_search_volume, total_cluster_search_volume, avg_price")
    .gte("legion_score", 80)
    .lt("top_10_avg_reviews", 300)
    .order("legion_score", { ascending: false });
  console.log(`\n=== ALL Legion-shape Winners (Score >= 80 AND Top-10 Avg Reviews < 300) ===`);
  console.log(`Total: ${top?.length ?? 0}\n`);
  for (const o of top ?? []) {
    console.log(`  ${o.legion_score}  reviews=${String(o.top_10_avg_reviews).padStart(4)}  sv=${String(o.monthly_search_volume ?? 0).padStart(6)}  cluster=${String(o.total_cluster_search_volume ?? 0).padStart(6)}  $${o.avg_price}  ${o.recommended_path}  →  ${o.name}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
