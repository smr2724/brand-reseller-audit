/**
 * Phase 25 — Bug A unit test for the seller-classification backfill.
 *
 * Verifies that backfillSellerClassification:
 *   1. Skips when every row already has a non-null is_brand_controlled.
 *   2. Updates the rows whose is_brand_controlled is null by running
 *      the deterministic classifier (Fantaswick LLC → true, Couples
 *      Coffee LLC → false against brand "Fantaswick").
 *   3. Soft-fails when the column doesn't exist (pre-migration env)
 *      without throwing.
 *
 * Uses an in-memory fake admin client so the test stays I/O free.
 *
 * Run: `npx tsx scripts/test-seller-backfill.ts`
 */
import { backfillSellerClassification } from "../src/lib/report/v2/enrich";
import type { BrandEnrichmentBundle } from "../src/lib/enrichment";

interface SellerRow {
  brand_id: string;
  seller_name: string;
  seller_id: string | null;
  is_brand_controlled: boolean | null;
  classification_reason: string | null;
}

function makeFakeAdmin(state: {
  rows: SellerRow[];
  shouldErrorWith?: string | null;
}): any {
  const builder = (table: string) => {
    if (table !== "brand_sellers") {
      return { update: () => ({ eq: () => ({ eq: () => ({ is: () => ({ error: null }) }) }) }) };
    }
    return {
      update: (patch: Partial<SellerRow>) => {
        const filters: Array<(r: SellerRow) => boolean> = [];
        const wrap = () => ({
          eq: (col: keyof SellerRow, val: any) => {
            filters.push((r) => (r as any)[col] === val);
            return wrap();
          },
          is: (col: keyof SellerRow, val: any) => {
            filters.push((r) => (r as any)[col] === val);
            // terminal — Supabase chain ends here
            return Promise.resolve(
              state.shouldErrorWith
                ? { error: { message: state.shouldErrorWith } }
                : (() => {
                    state.rows = state.rows.map((r) =>
                      filters.every((f) => f(r)) ? { ...r, ...patch } : r,
                    );
                    return { error: null };
                  })(),
            );
          },
        });
        return wrap();
      },
    };
  };
  return { from: builder };
}

let pass = 0;
let fail = 0;
function assertEq(name: string, got: unknown, expect: unknown) {
  if (JSON.stringify(got) === JSON.stringify(expect)) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}\n  got:    ${JSON.stringify(got)}\n  expect: ${JSON.stringify(expect)}`);
  }
}

function bundleFromSellers(brandName: string, sellers: SellerRow[]): BrandEnrichmentBundle {
  return {
    brandId: "brand-id",
    brandName,
    keepa: {
      asin_count: 40,
      unique_seller_count: sellers.length,
      brand_controlled_pct: 0.7027,
      top_seller: sellers[0]?.seller_name ?? null,
      top_seller_share_pct: null,
      top_seller_country: null,
      avg_offers: null,
      last_enriched_at: new Date().toISOString(),
      asins: [],
      sellers: sellers.map((s) => ({
        seller_name: s.seller_name,
        seller_id: s.seller_id,
        share_pct: null,
        asins_won: null,
        is_fba: null,
        is_brand_controlled: s.is_brand_controlled,
        classification_reason: s.classification_reason,
      })),
    },
    dataforseo: {
      branded_search_volume: null,
      branded_trend_pct: null,
      top_keywords: [],
      competitor_brands: [],
      serp_positions: [],
      organic_traffic_value: null,
      captured_at: null,
    },
    validationScore: null,
    valueAddSignals: [],
    freshness: { keepa: null, dataforseo: null },
  };
}

(async () => {
  // 1. Both rows null — should backfill both.
  {
    const rows: SellerRow[] = [
      {
        brand_id: "brand-id",
        seller_name: "Fantaswick LLC",
        seller_id: null,
        is_brand_controlled: null,
        classification_reason: null,
      },
      {
        brand_id: "brand-id",
        seller_name: "Couples Coffee LLC",
        seller_id: null,
        is_brand_controlled: null,
        classification_reason: null,
      },
    ];
    const state = { rows };
    const admin = makeFakeAdmin(state);
    const updated = await backfillSellerClassification(
      admin,
      "brand-id",
      "Fantaswick",
      bundleFromSellers("Fantaswick", rows),
    );
    assertEq("returns true when rows backfilled", updated, true);
    const fanta = state.rows.find((r) => r.seller_name === "Fantaswick LLC");
    const couples = state.rows.find((r) => r.seller_name === "Couples Coffee LLC");
    assertEq("Fantaswick LLC marked brand-controlled", fanta?.is_brand_controlled, true);
    assertEq("Couples Coffee LLC marked NOT brand-controlled", couples?.is_brand_controlled, false);
    assertEq("classification_reason set on Fantaswick", typeof fanta?.classification_reason === "string" && fanta!.classification_reason!.length > 0, true);
  }

  // 2. All rows already classified — no-op.
  {
    const rows: SellerRow[] = [
      {
        brand_id: "brand-id",
        seller_name: "Fantaswick LLC",
        seller_id: null,
        is_brand_controlled: true,
        classification_reason: "preexisting",
      },
    ];
    const state = { rows };
    const admin = makeFakeAdmin(state);
    const updated = await backfillSellerClassification(
      admin,
      "brand-id",
      "Fantaswick",
      bundleFromSellers("Fantaswick", rows),
    );
    assertEq("returns false when nothing to backfill", updated, false);
    assertEq("preexisting classification preserved", state.rows[0].classification_reason, "preexisting");
  }

  // 3. Pre-migration: column-missing error → soft-fail with false return.
  {
    const rows: SellerRow[] = [
      {
        brand_id: "brand-id",
        seller_name: "Fantaswick LLC",
        seller_id: null,
        is_brand_controlled: null,
        classification_reason: null,
      },
    ];
    const state = {
      rows,
      shouldErrorWith: 'column "is_brand_controlled" of relation "brand_sellers" does not exist',
    };
    const admin = makeFakeAdmin(state);
    const updated = await backfillSellerClassification(
      admin,
      "brand-id",
      "Fantaswick",
      bundleFromSellers("Fantaswick", rows),
    );
    assertEq("soft-fails on missing column", updated, false);
  }

  // 4. Other errors should throw.
  {
    const rows: SellerRow[] = [
      {
        brand_id: "brand-id",
        seller_name: "Fantaswick LLC",
        seller_id: null,
        is_brand_controlled: null,
        classification_reason: null,
      },
    ];
    const state = { rows, shouldErrorWith: "permission denied for table brand_sellers" };
    const admin = makeFakeAdmin(state);
    let threw = false;
    try {
      await backfillSellerClassification(
        admin,
        "brand-id",
        "Fantaswick",
        bundleFromSellers("Fantaswick", rows),
      );
    } catch (e) {
      threw = true;
    }
    assertEq("hard error throws", threw, true);
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
})();
