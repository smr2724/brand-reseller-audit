/**
 * Phase 76 — buildSteveOutreachEmail tests.
 *
 * No test runner is installed; run directly via:
 *   npx tsx src/lib/outreach/__tests__/steve-template.test.ts
 */
import { buildSteveOutreachEmail } from "../steve-template";

let failures = 0;
let passes = 0;

function assert(label: string, cond: boolean): void {
  if (cond) {
    passes++;
  } else {
    failures++;
    console.error(`FAIL: ${label}`);
  }
}

// Subject — Additional Profit + Brand.
{
  const out = buildSteveOutreachEmail({
    brandName: "CARNA4",
    firstName: "Jane",
    additionalProfit: 203541.32869458137,
  });
  assert(
    "subject is `$203,541 Profit for CARNA4`",
    out.subject === "$203,541 Profit for CARNA4",
  );
  assert("brand case preserved (CARNA4)", out.html.includes("CARNA4"));
  assert("first name appears with comma", out.html.includes("<p>Jane,</p>"));
  assert(
    "body contains 'Are you the right person to send it to?'",
    out.text.includes("Are you the right person to send it to?"),
  );
  assert(
    "body contains 'I put together a report to show you what our team found with detailed numbers.'",
    out.text.includes(
      "I put together a report to show you what our team found with detailed numbers.",
    ),
  );
  assert(
    "html has report sentence in its own <p>",
    out.html.includes(
      "<p>I put together a report to show you what our team found with detailed numbers.</p>",
    ),
  );
  assert(
    "html has the right-person sentence in its own <p>",
    out.html.includes("<p>Are you the right person to send it to?</p>"),
  );
  assert(
    "html signs off with 'Steve Rolle' in its own <p>",
    out.html.includes("<p>Steve Rolle</p>"),
  );
}

// First name fallback.
{
  const out = buildSteveOutreachEmail({
    brandName: "Realspace",
    firstName: null,
    additionalProfit: 1424789.30,
  });
  assert("fallback first name 'there'", out.html.startsWith("<p>there,</p>"));
  assert("Realspace case preserved", out.html.includes("Realspace"));
  assert(
    "subject is `$1,424,789 Profit for Realspace`",
    out.subject === "$1,424,789 Profit for Realspace",
  );
}

// Empty/whitespace first name falls back too.
{
  const out = buildSteveOutreachEmail({
    brandName: "ACME",
    firstName: "   ",
    additionalProfit: 1000,
  });
  assert("whitespace-only first name → 'there'", out.text.startsWith("there,\n"));
  assert("subject is `$1,000 Profit for ACME`", out.subject === "$1,000 Profit for ACME");
}

// Null additional_profit guard rail — $0 in subject, draft still goes out.
{
  const out = buildSteveOutreachEmail({
    brandName: "ACME",
    firstName: "Sam",
    additionalProfit: null,
  });
  assert("null additional_profit → `$0` in subject", out.subject === "$0 Profit for ACME");
}

// HTML escapes brand + first name to prevent injection through brand fields.
{
  const out = buildSteveOutreachEmail({
    brandName: "<script>alert(1)</script>",
    firstName: "Bobby \"Drop\" Tables",
    additionalProfit: 5,
  });
  assert("html escapes brand <script>", out.html.includes("&lt;script&gt;"));
  assert(
    "html escapes quotes in first name",
    out.html.includes("Bobby &quot;Drop&quot; Tables,"),
  );
  // Subject is plaintext (no HTML), so the raw script tag flows through. That's
  // expected — the subject is delivered as a Graph message subject string, not
  // HTML — but document the behavior in case the assumption changes.
  assert("subject is raw text", out.subject === "$5 Profit for <script>alert(1)</script>");
}

console.log(`\nbuildSteveOutreachEmail: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
