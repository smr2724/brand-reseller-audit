/**
 * Phase 25 — Unit tests for the ASIN/URL extractor used by the picker's
 * "I have an ASIN or storefront URL" fallback.
 *
 * Run: npx tsx scripts/test-resolve-asin.ts
 */
import { extractAsinOrUrl } from "../src/lib/brand-search/resolve-asin";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} :: ${name}${detail ? " :: " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

{
  const r = extractAsinOrUrl("B07XKZTC4M");
  check("bare ASIN", r.asin === "B07XKZTC4M");
}
{
  const r = extractAsinOrUrl("b07xkztc4m");
  check("lowercase ASIN gets uppercased", r.asin === "B07XKZTC4M");
}
{
  const r = extractAsinOrUrl("https://www.amazon.com/dp/B07XKZTC4M");
  check("dp/ URL", r.asin === "B07XKZTC4M");
}
{
  const r = extractAsinOrUrl(
    "https://www.amazon.com/Yeti-Rambler/dp/B07XKZTC4M?ref=foo",
  );
  check("slug + dp + querystring", r.asin === "B07XKZTC4M");
}
{
  const r = extractAsinOrUrl("https://www.amazon.com/gp/product/B07XKZTC4M");
  check("gp/product URL", r.asin === "B07XKZTC4M");
}
{
  const r = extractAsinOrUrl("https://www.amazon.com/stores/page/ABC123-XYZ");
  check(
    "storefront URL → storefrontId",
    r.storefrontId === "ABC123-XYZ" && r.asin === null,
  );
}
{
  const r = extractAsinOrUrl("not a real input");
  check("garbage → null/null", r.asin === null && r.storefrontId === null);
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
