/**
 * Phase 23 — sanity test for the seller classifier and Amazon-1P
 * predicate. Run with `npx tsx scripts/test-seller-classification.ts`.
 *
 * No I/O — pure unit tests against the in-memory classifier.
 */
import {
  classifySeller,
  aggregateBrandControlledShare,
  isAmazon1pBrand,
  amazon1pThreshold,
  AMAZON_RETAIL_SELLER_ID,
  tokenJaccard,
  normalizeName,
} from "../src/lib/enrichment/seller-classification";

interface Case {
  name: string;
  brand: string;
  seller: string;
  seller_id?: string;
  expect_brand_controlled: boolean;
  expect_method?: string;
}

const CASES: Case[] = [
  {
    name: "Fantaswick LLC matches Fantaswick",
    brand: "Fantaswick",
    seller: "Fantaswick LLC",
    expect_brand_controlled: true,
    expect_method: "exact",
  },
  {
    name: "Couples Coffee LLC does NOT match Fantaswick",
    brand: "Fantaswick",
    seller: "Couples Coffee LLC",
    expect_brand_controlled: false,
  },
  {
    name: "OXO matches OXO Inc.",
    brand: "OXO",
    seller: "OXO Inc.",
    expect_brand_controlled: true,
    expect_method: "exact",
  },
  {
    name: "Amazon.com (raw name, no id) does NOT match a brand",
    brand: "Yeti",
    seller: "Amazon.com",
    expect_brand_controlled: false,
  },
  {
    name: "Amazon Retail by id is never brand-controlled",
    brand: "Anything",
    seller: "Amazon.com",
    seller_id: AMAZON_RETAIL_SELLER_ID,
    expect_brand_controlled: false,
    expect_method: "exact",
  },
  {
    name: "Amazon Global Store UK is NOT amazon retail (different id)",
    brand: "Yeti",
    seller: "Amazon Global Store UK",
    seller_id: "A2QFXIBOY51TWG",
    expect_brand_controlled: false,
  },
  {
    name: "Acme Brands International matches Acme (corporate-suffix strip)",
    brand: "Acme",
    seller: "Acme Brands International",
    expect_brand_controlled: true,
    expect_method: "exact",
  },
  {
    name: "Random reseller doesn't match",
    brand: "Acme",
    seller: "Best Deals Outlet",
    expect_brand_controlled: false,
  },
];

let pass = 0;
let fail = 0;

(async () => {
  console.log("normalizeName('Fantaswick LLC') →", normalizeName("Fantaswick LLC"));
  console.log("normalizeName('Couples Coffee LLC') →", normalizeName("Couples Coffee LLC"));
  console.log(
    "tokenJaccard(['acme'], ['acme', 'brands', 'international']) =",
    tokenJaccard(["acme"], ["acme", "brands", "international"]),
  );
  console.log("");

  for (const c of CASES) {
    // Don't burn LLM budget in tests — keep budget at 0 so we exercise
    // only the deterministic paths.
    const v = await classifySeller({
      brand_name: c.brand,
      seller_name: c.seller,
      seller_id: c.seller_id ?? null,
      llm_budget_remaining: 0,
    });
    const ok =
      v.is_brand_controlled === c.expect_brand_controlled &&
      (!c.expect_method || v.method === c.expect_method);
    if (ok) {
      pass += 1;
      console.log(`PASS  ${c.name}`);
      console.log(`        → brand_controlled=${v.is_brand_controlled} method=${v.method} reason="${v.reason}"`);
    } else {
      fail += 1;
      console.log(`FAIL  ${c.name}`);
      console.log(`        expected brand_controlled=${c.expect_brand_controlled} method=${c.expect_method ?? "*"}`);
      console.log(`        got      brand_controlled=${v.is_brand_controlled} method=${v.method}`);
      console.log(`        reason   ${v.reason}`);
    }
  }

  // Aggregation tests
  const fantaswickClassified = [
    {
      seller_name: "Fantaswick LLC",
      seller_id: null,
      share_pct: 0.7027,
      asins_won: 26,
      classification: {
        is_brand_controlled: true,
        reason: "substring",
        method: "substring" as const,
        confidence: 0.95,
      },
    },
    {
      seller_name: "Couples Coffee LLC",
      seller_id: null,
      share_pct: 0.2973,
      asins_won: 11,
      classification: {
        is_brand_controlled: false,
        reason: "no overlap",
        method: "fallback" as const,
        confidence: 0,
      },
    },
  ];
  const agg = aggregateBrandControlledShare(fantaswickClassified);
  if (agg && Math.abs(agg - 0.7027) < 0.01) {
    pass += 1;
    console.log(`PASS  aggregateBrandControlledShare → ${agg.toFixed(4)} (≈ 0.7027)`);
  } else {
    fail += 1;
    console.log(`FAIL  aggregateBrandControlledShare → ${agg}`);
  }

  // Amazon-1P predicate tests
  const t = amazon1pThreshold();
  console.log(`amazon1pThreshold() = ${t}`);
  const amzCases: { share: number | null; expect: boolean }[] = [
    { share: 0.0, expect: false },
    { share: 0.05, expect: false },
    { share: 0.10, expect: true },
    { share: 0.5, expect: true },
    { share: null, expect: false },
  ];
  for (const c of amzCases) {
    const got = isAmazon1pBrand(c.share);
    if (got === c.expect) {
      pass += 1;
      console.log(`PASS  isAmazon1pBrand(${c.share}) === ${c.expect}`);
    } else {
      fail += 1;
      console.log(`FAIL  isAmazon1pBrand(${c.share}) === ${c.expect} got ${got}`);
    }
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
})();
