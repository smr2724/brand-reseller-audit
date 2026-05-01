/**
 * Drill sweep — adjacent sub-niches of the 8 near-miss categories that
 * scored 70-79 with low reviews. Hunting for strict winners (score>=80, reviews<300).
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { runScan } from "../src/lib/scan";

const SEEDS: { seed: string; vertical: string }[] = [
  // --- Stainless Steel Weld Cleaner adjacency (winner cluster) ---
  { seed: "weld discoloration remover", vertical: "Weld/Metal" },
  { seed: "weld cleaning gel", vertical: "Weld/Metal" },
  { seed: "stainless steel passivation gel", vertical: "Weld/Metal" },
  { seed: "pickling paste stainless", vertical: "Weld/Metal" },
  { seed: "electrochemical weld cleaner", vertical: "Weld/Metal" },
  { seed: "weld cleaning brush kit", vertical: "Weld/Metal" },
  { seed: "stainless steel rouge remover", vertical: "Weld/Metal" },
  { seed: "anodizing cleaner aluminum", vertical: "Weld/Metal" },
  { seed: "metal etching cream", vertical: "Weld/Metal" },
  { seed: "rust converter for steel", vertical: "Weld/Metal" },

  // --- Wax stripper / VCT adjacency (79/471) ---
  { seed: "no rinse wax stripper", vertical: "Floor Pro" },
  { seed: "wax stripper for terrazzo", vertical: "Floor Pro" },
  { seed: "vinyl plank floor stripper", vertical: "Floor Pro" },
  { seed: "ammoniated wax stripper", vertical: "Floor Pro" },
  { seed: "low odor floor stripper", vertical: "Floor Pro" },
  { seed: "rubber floor cleaner gym", vertical: "Floor Pro" },
  { seed: "epoxy floor cleaner garage", vertical: "Floor Pro" },
  { seed: "polished concrete cleaner", vertical: "Floor Pro" },

  // --- Urinal / restroom janitorial (71/283) ---
  { seed: "toilet bowl descaler commercial", vertical: "Restroom Pro" },
  { seed: "lime scale remover urinal", vertical: "Restroom Pro" },
  { seed: "enzyme drain cleaner commercial", vertical: "Restroom Pro" },
  { seed: "no touch urinal cleaner", vertical: "Restroom Pro" },
  { seed: "stall partition cleaner", vertical: "Restroom Pro" },

  // --- Polyurethane stripper / specialty stripper (72/814) ---
  { seed: "polyurethane stripper for floors", vertical: "Coating Stripper" },
  { seed: "epoxy stripper", vertical: "Coating Stripper" },
  { seed: "silicone caulk remover gel", vertical: "Coating Stripper" },
  { seed: "powder coating stripper", vertical: "Coating Stripper" },
  { seed: "varnish remover gel", vertical: "Coating Stripper" },
  { seed: "shellac remover", vertical: "Coating Stripper" },

  // --- Epoxy resin cleaner / maker industrial (70/605) ---
  { seed: "uncured epoxy cleanup", vertical: "Maker Industrial" },
  { seed: "resin cleaning solution", vertical: "Maker Industrial" },
  { seed: "tool cleaner for epoxy", vertical: "Maker Industrial" },
  { seed: "fiberglass resin cleaner", vertical: "Maker Industrial" },
  { seed: "silicone mold cleaner", vertical: "Maker Industrial" },

  // --- Ceramic kiln cleaner adjacency (75/335) ---
  { seed: "kiln shelf wash", vertical: "Ceramics/Glass" },
  { seed: "kiln furniture cleaner", vertical: "Ceramics/Glass" },
  { seed: "glass kiln cleaner", vertical: "Ceramics/Glass" },
  { seed: "pottery wheel cleaner", vertical: "Ceramics/Glass" },
  { seed: "glaze remover", vertical: "Ceramics/Glass" },

  // --- Pool waterline / specialty pool (82/371 was a near miss) ---
  { seed: "pool tile scum line cleaner", vertical: "Pool Specialty" },
  { seed: "pool calcium scale remover", vertical: "Pool Specialty" },
  { seed: "pool stain identification kit", vertical: "Pool Specialty" },
  { seed: "fiberglass pool cleaner", vertical: "Pool Specialty" },

  // --- Boiler descaler adjacency (75/925) ---
  { seed: "tankless water heater descaler", vertical: "HVAC Descale" },
  { seed: "hydronic boiler cleaner", vertical: "HVAC Descale" },
  { seed: "steam boiler cleaner", vertical: "HVAC Descale" },
  { seed: "heat exchanger cleaner", vertical: "HVAC Descale" },
  { seed: "radiator descaler", vertical: "HVAC Descale" },

  // --- Specialty B2B trade categories (untested) ---
  { seed: "concrete bond breaker", vertical: "Concrete Specialty" },
  { seed: "concrete sealer penetrating", vertical: "Concrete Specialty" },
  { seed: "concrete densifier", vertical: "Concrete Specialty" },
  { seed: "concrete countertop sealer", vertical: "Concrete Specialty" },
  { seed: "concrete stamp release", vertical: "Concrete Specialty" },

  // --- Specialty marine pro ---
  { seed: "boat fiberglass oxidation remover", vertical: "Marine Pro" },
  { seed: "boat hull rust stain remover", vertical: "Marine Pro" },
  { seed: "boat vinyl seat cleaner", vertical: "Marine Pro" },
  { seed: "marine teak cleaner", vertical: "Marine Pro" },
  { seed: "outboard salt away", vertical: "Marine Pro" },

  // --- Specialty laundry / textile pro ---
  { seed: "industrial laundry sour", vertical: "Laundry Pro" },
  { seed: "rust stain remover laundry", vertical: "Laundry Pro" },
  { seed: "blood stain remover commercial", vertical: "Laundry Pro" },
  { seed: "uniform brightener", vertical: "Laundry Pro" },
  { seed: "wet floor sign", vertical: "Janitorial Specialty" },
  { seed: "carpet stain extractor solution", vertical: "Janitorial Specialty" },
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

  const { data: existing } = await supabase.from("opportunities").select("main_keyword");
  const already = new Set((existing ?? []).map((r: any) => (r.main_keyword || "").toLowerCase()));
  const fresh = SEEDS.filter(s => !already.has(s.seed.toLowerCase()));
  console.log(`${fresh.length} new seeds (${SEEDS.length - fresh.length} already scanned).\n`);

  let winners = 0;
  for (let i = 0; i < fresh.length; i++) {
    const { seed, vertical } = fresh[i];
    const t0 = Date.now();
    try {
      const { data: scan, error: scanErr } = await supabase
        .from("scans").insert({
          user_id: userId, seed_keyword: seed, marketplace: "amazon_us",
          scan_depth: "standard", status: "running", started_at: new Date().toISOString(),
          raw_input: { vertical, source: "drill_sweep" },
        }).select().single();
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

  const { data: top } = await supabase
    .from("opportunities")
    .select("name, legion_score, recommended_path, top_10_avg_reviews, top_10_avg_rating, monthly_search_volume, total_cluster_search_volume, avg_price")
    .gte("legion_score", 80)
    .lt("top_10_avg_reviews", 300)
    .order("legion_score", { ascending: false });
  console.log(`\n=== STRICT WINNERS (score>=80 AND top-10 reviews<300) — total ${top?.length ?? 0} ===\n`);
  for (const o of top ?? []) {
    console.log(`  ${o.legion_score}  reviews=${String(o.top_10_avg_reviews).padStart(4)}  sv=${String(o.monthly_search_volume ?? 0).padStart(6)}  cluster=${String(o.total_cluster_search_volume ?? 0).padStart(6)}  $${o.avg_price}  ${o.recommended_path}  →  ${o.name}`);
  }
  console.log(`\nDrill winners this sweep: ${winners}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
