/**
 * Drill 4 — wide expansion to push toward 25 strict winners.
 * Targeting under-served B2B/pro/janitorial/industrial niches with very specific modifiers.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { runScan } from "../src/lib/scan";

const SEEDS: { seed: string; vertical: string }[] = [
  // --- Welding deep cuts (most productive lane) ---
  { seed: "weld cleaner electrolyte solution", vertical: "Weld Pro" },
  { seed: "tig weld cleaning fluid", vertical: "Weld Pro" },
  { seed: "stainless weld bead cleaner", vertical: "Weld Pro" },
  { seed: "weld pickling paste stainless", vertical: "Weld Pro" },
  { seed: "electropolishing solution stainless", vertical: "Weld Pro" },
  { seed: "weld scale remover", vertical: "Weld Pro" },
  { seed: "weld heat tint remover", vertical: "Weld Pro" },
  { seed: "stainless steel restoration kit", vertical: "Weld Pro" },
  { seed: "weld cleaner brush", vertical: "Weld Pro" },

  // --- Janitorial pro (highly fragmented B2B lane) ---
  { seed: "neutral floor cleaner concentrate", vertical: "Janitorial Pro" },
  { seed: "quaternary disinfectant concentrate", vertical: "Janitorial Pro" },
  { seed: "enzymatic drain maintainer", vertical: "Janitorial Pro" },
  { seed: "carpet extraction defoamer", vertical: "Janitorial Pro" },
  { seed: "carpet pre spray traffic lane", vertical: "Janitorial Pro" },
  { seed: "carpet rinse acidic", vertical: "Janitorial Pro" },
  { seed: "urinal block deodorizer", vertical: "Janitorial Pro" },
  { seed: "metered air freshener refill", vertical: "Janitorial Pro" },
  { seed: "auto scrubber detergent", vertical: "Janitorial Pro" },
  { seed: "wet look floor finish", vertical: "Janitorial Pro" },
  { seed: "high solids floor finish", vertical: "Janitorial Pro" },

  // --- Concrete/masonry pro ---
  { seed: "concrete densifier lithium", vertical: "Concrete Pro" },
  { seed: "concrete curing compound", vertical: "Concrete Pro" },
  { seed: "concrete form release agent", vertical: "Concrete Pro" },
  { seed: "concrete bonding adhesive primer", vertical: "Concrete Pro" },
  { seed: "concrete retarder", vertical: "Concrete Pro" },
  { seed: "concrete penetrating sealer commercial", vertical: "Concrete Pro" },
  { seed: "muriatic acid replacement safer", vertical: "Concrete Pro" },
  { seed: "concrete oil stain remover", vertical: "Concrete Pro" },
  { seed: "tire mark remover concrete", vertical: "Concrete Pro" },
  { seed: "rust stain remover concrete", vertical: "Concrete Pro" },

  // --- Restoration / abatement / fire damage ---
  { seed: "smoke residue cleaner", vertical: "Restoration Pro" },
  { seed: "fire damage soot cleaner", vertical: "Restoration Pro" },
  { seed: "thermal fogging deodorizer", vertical: "Restoration Pro" },
  { seed: "ozone treatment solution", vertical: "Restoration Pro" },
  { seed: "mold remediation cleaner concentrate", vertical: "Restoration Pro" },
  { seed: "antimicrobial spray restoration", vertical: "Restoration Pro" },
  { seed: "pet urine pretreatment carpet", vertical: "Restoration Pro" },
  { seed: "biohazard cleanup solution", vertical: "Restoration Pro" },

  // --- Pool/spa specialty deeper ---
  { seed: "pool filter cleaner cartridge", vertical: "Pool Specialty" },
  { seed: "pool filter degreaser", vertical: "Pool Specialty" },
  { seed: "phosphate remover pool concentrated", vertical: "Pool Specialty" },
  { seed: "pool clarifier enzyme", vertical: "Pool Specialty" },
  { seed: "pool surface scale remover", vertical: "Pool Specialty" },
  { seed: "spa surface cleaner concentrate", vertical: "Pool Specialty" },
  { seed: "hot tub line cleaner", vertical: "Pool Specialty" },

  // --- Industrial coatings/maintenance ---
  { seed: "rust converter primer industrial", vertical: "Coatings Pro" },
  { seed: "metal etch primer", vertical: "Coatings Pro" },
  { seed: "epoxy primer two part metal", vertical: "Coatings Pro" },
  { seed: "anti corrosion spray industrial", vertical: "Coatings Pro" },
  { seed: "cold galvanizing compound", vertical: "Coatings Pro" },
  { seed: "high temp paint silicone industrial", vertical: "Coatings Pro" },
  { seed: "chassis paint black", vertical: "Coatings Pro" },

  // --- Auto detail pro deeper ---
  { seed: "iron remover paint decontamination", vertical: "Auto Detail Pro" },
  { seed: "tar remover automotive", vertical: "Auto Detail Pro" },
  { seed: "bug remover concentrate", vertical: "Auto Detail Pro" },
  { seed: "wheel cleaner acid free", vertical: "Auto Detail Pro" },
  { seed: "leather cleaner conditioner pro", vertical: "Auto Detail Pro" },
  { seed: "ceramic coating primer", vertical: "Auto Detail Pro" },
  { seed: "headliner cleaner foam", vertical: "Auto Detail Pro" },
  { seed: "convertible top cleaner", vertical: "Auto Detail Pro" },

  // --- Marine pro ---
  { seed: "boat aluminum cleaner", vertical: "Marine Pro" },
  { seed: "boat vinyl seat cleaner", vertical: "Marine Pro" },
  { seed: "boat carpet cleaner", vertical: "Marine Pro" },
  { seed: "boat bilge cleaner concentrate", vertical: "Marine Pro" },
  { seed: "boat hull bottom cleaner", vertical: "Marine Pro" },
  { seed: "marine grade waterline cleaner", vertical: "Marine Pro" },
  { seed: "yacht teak cleaner two part", vertical: "Marine Pro" },

  // --- HVAC / mechanical pro ---
  { seed: "coil cleaner alkaline foam", vertical: "HVAC Pro" },
  { seed: "coil brightener acidic", vertical: "HVAC Pro" },
  { seed: "ice machine cleaner nickel safe", vertical: "HVAC Pro" },
  { seed: "humidifier scale remover", vertical: "HVAC Pro" },
  { seed: "air filter cleaner reusable", vertical: "HVAC Pro" },
  { seed: "drain line treatment ac", vertical: "HVAC Pro" },

  // --- Restaurant/foodservice specialty ---
  { seed: "grease trap treatment commercial", vertical: "Restaurant Specialty" },
  { seed: "grill cleaner non caustic", vertical: "Restaurant Specialty" },
  { seed: "hood filter cleaner soak", vertical: "Restaurant Specialty" },
  { seed: "fryer boil out cleaner", vertical: "Restaurant Specialty" },
  { seed: "dishmachine descaler delimer", vertical: "Restaurant Specialty" },
  { seed: "cutting board sanitizer food safe", vertical: "Restaurant Specialty" },
  { seed: "ceramic stove top cleaner cream", vertical: "Restaurant Specialty" },

  // --- Lawn/turf/agriculture pro ---
  { seed: "ice melt liquid commercial", vertical: "Outdoor Pro" },
  { seed: "calcium chloride flake bulk", vertical: "Outdoor Pro" },
  { seed: "moss killer roof", vertical: "Outdoor Pro" },
  { seed: "algae killer roof shingle", vertical: "Outdoor Pro" },
  { seed: "concrete moss remover", vertical: "Outdoor Pro" },
  { seed: "outdoor wood deck stripper", vertical: "Outdoor Pro" },
  { seed: "deck brightener oxalic", vertical: "Outdoor Pro" },
  { seed: "fence cleaner vinyl", vertical: "Outdoor Pro" },
  { seed: "siding cleaner soft wash", vertical: "Outdoor Pro" },
  { seed: "house wash concentrate sodium hypochlorite", vertical: "Outdoor Pro" },

  // --- Niche/boring trades ---
  { seed: "floor squeegee commercial 24 inch", vertical: "Niche Trade" },
  { seed: "drum funnel safety", vertical: "Niche Trade" },
  { seed: "spill kit oil only", vertical: "Niche Trade" },
  { seed: "absorbent socks oil", vertical: "Niche Trade" },
  { seed: "secondary containment berm", vertical: "Niche Trade" },
  { seed: "chemical resistant gloves nitrile heavy", vertical: "Niche Trade" },

  // --- Plumbing pro ---
  { seed: "drain opener industrial sulfuric", vertical: "Plumbing Pro" },
  { seed: "root killer foaming", vertical: "Plumbing Pro" },
  { seed: "septic system enzyme treatment", vertical: "Plumbing Pro" },
  { seed: "urinal opener acid", vertical: "Plumbing Pro" },
  { seed: "boiler scale remover concentrate", vertical: "Plumbing Pro" },
  { seed: "water heater flush kit", vertical: "Plumbing Pro" },

  // --- Painting/refinishing ---
  { seed: "paint stripper for metal industrial", vertical: "Paint Contractor" },
  { seed: "paint stripper for fiberglass", vertical: "Paint Contractor" },
  { seed: "wood deglosser liquid sander", vertical: "Paint Contractor" },
  { seed: "shellac remover", vertical: "Paint Contractor" },
  { seed: "varnish remover wood", vertical: "Paint Contractor" },
  { seed: "powder coat remover", vertical: "Paint Contractor" },

  // --- Industrial textile/fabric care ---
  { seed: "industrial laundry detergent", vertical: "Laundry Pro" },
  { seed: "shop towel detergent", vertical: "Laundry Pro" },
  { seed: "rust stain remover laundry", vertical: "Laundry Pro" },
  { seed: "grease cutting laundry pretreat", vertical: "Laundry Pro" },
  { seed: "uniform laundry softener", vertical: "Laundry Pro" },

  // --- Electronics / precision cleaning ---
  { seed: "pcb cleaner spray", vertical: "Precision Clean" },
  { seed: "contact cleaner electrical degreaser", vertical: "Precision Clean" },
  { seed: "fiber optic cleaner solvent", vertical: "Precision Clean" },
  { seed: "isopropyl alcohol 99 gallon", vertical: "Precision Clean" },
  { seed: "flux remover spray", vertical: "Precision Clean" },
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
        raw_input: { vertical, source: "drill4_sweep" },
      }).select().single();

      const result: any = await scanWithTimeout({
        scanId: scan!.id, userId, seedKeyword: seed, depth: "standard",
        supabase, skipKeepa: true,
      }, SCAN_TIMEOUT_MS);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const reviews = result.score.metrics.top_10_avg_reviews;
      const winner = result.score.legion_score >= 80 && reviews < 300;
      const flag = winner ? "★ WINNER" : (reviews < 300 ? "" : "(too many reviews)");
      console.log(`[${i + 1}/${fresh.length}] ${seed.padEnd(48)} score=${String(result.score.legion_score).padStart(2)} reviews=${String(reviews).padStart(6)} ${flag} (${dt}s)`);
      if (winner) winners++;
    } catch (e: any) {
      console.error(`[${i + 1}/${fresh.length}] ${seed.padEnd(48)} FAIL: ${e?.message ?? e}`);
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
  console.log(`\nDrill4 winners this sweep: ${winners}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
