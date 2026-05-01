// Standalone end-to-end test for the Channel Ownership Audit report generator.
//
// Required env:
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   BRAND_ID                 (uuid of a brand in the live DB to render against)
// Optional env:
//   USER_ID                  (uuid of the brand owner; auto-detected from brand row if omitted)
//   OPENAI_API_KEY           (if missing, narrative falls back to a deterministic placeholder)
//   OPENAI_MODEL_REPORTS     (default gpt-4o-mini)
//   OUT_PATH                 (default /tmp/test-report.pdf)
//
// Run:
//   npx tsx scripts/test-report-generate.ts
//
// This script does NOT modify the reports table or Supabase Storage. It:
//   1. Reads the brand row directly via the service-role key.
//   2. Calls generateNarrative + renderAuditPdf.
//   3. Writes the resulting PDF to OUT_PATH locally.

import "dotenv/config";
import * as fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { generateNarrative, type BrandForReport } from "../src/lib/report/narrative";
import { renderAuditPdf } from "../src/lib/report/pdf";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const brandId = process.env.BRAND_ID;
  const outPath = process.env.OUT_PATH ?? "/tmp/test-report.pdf";

  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  if (!brandId) {
    console.error("Missing BRAND_ID env var");
    process.exit(1);
  }

  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`Loading brand ${brandId}…`);
  const { data: brand, error } = await admin
    .from("brands")
    .select("*")
    .eq("id", brandId)
    .maybeSingle();
  if (error) {
    console.error("brand lookup failed:", error.message);
    process.exit(1);
  }
  if (!brand) {
    console.error("brand not found");
    process.exit(1);
  }

  console.log(`Generating narrative for ${(brand as { name: string }).name}…`);
  const narrative = await generateNarrative(brand as BrandForReport);
  console.log(
    `  reseller_reality: ${narrative.reseller_reality_md.length} chars · ` +
      `opportunity: ${narrative.opportunity_narrative_md.length} chars · ` +
      `callouts: ${narrative.footprint_callouts_md.length}`
  );

  console.log("Rendering PDF…");
  const buffer = await renderAuditPdf({
    brand: brand as BrandForReport,
    narrative,
    bundle: null,
    contactEmail: "contact@rolleconsulting.com",
    generatedAt: new Date(),
  });

  fs.writeFileSync(outPath, buffer);
  console.log(`Wrote ${buffer.length} bytes → ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
