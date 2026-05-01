/**
 * Phase 6 — Outreach draft smoke test.
 *
 * Usage:
 *   npx tsx scripts/test-outreach-draft.ts
 *
 * Prints the three tone variants generated for a synthetic brand+contact
 * payload. Useful for tuning the system prompt without touching the DB.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { generateOutreachDraftVariants } from "../src/lib/outreach/draft";

async function main() {
  const bundle = await generateOutreachDraftVariants({
    brand: {
      id: "test-brand-id",
      name: "Hawthorne & Sage",
      category: "Home Goods",
      est_monthly_revenue: 87_500,
      trailing_12_months: 1_050_000,
      dominant_seller_sales_pct: 62,
      dominant_seller_name: "Brightline Trading",
      dominant_seller_country: "CN",
      total_products: 42,
      avg_sellers: 4.3,
    },
    contact: {
      id: "test-contact-id",
      full_name: "Jordan Reilly",
      first_name: "Jordan",
      title: "Chief Executive Officer",
    },
  });

  console.log("model:", bundle.model);
  console.log("signal:", bundle.signal_used);
  console.log("---");
  for (const v of bundle.variants) {
    console.log(`\n=== ${v.tone.toUpperCase()} ===`);
    console.log(`Subject: ${v.subject}`);
    console.log(v.body_text);
    console.log(`(${v.body_text.split(/\s+/).filter(Boolean).length} words)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
