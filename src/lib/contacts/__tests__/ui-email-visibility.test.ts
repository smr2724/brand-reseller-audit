/**
 * Phase 64 — UI behavior assertion. The ContactDiscovery row must show
 * the email in the Email column whenever `contact.email` is populated,
 * regardless of whether the verifier returned 'verified', 'unknown',
 * or no status at all. Hiding an Apollo-verified email behind a
 * "Not found" pill because MillionVerifier was inconclusive was the
 * UX symptom of the live Phase 63 test.
 *
 * We can't easily render React without a test framework, so we encode
 * the rendering decisions as pure predicates that mirror the JSX:
 *
 *   - shouldShowEmail(contact) → true when c.email is truthy.
 *   - emailPillLabel(status, hasEmail) → the user-visible pill label.
 *
 * Both predicates are duplicated from ContactDiscovery.tsx; if the
 * component drifts, this test must drift with it. The point is to
 * lock the post-Phase-64 behavior in a checked place.
 *
 * Run with:
 *   npx tsx src/lib/contacts/__tests__/ui-email-visibility.test.ts
 */

interface Contact {
  email: string | null;
  email_status: string | null;
  enrichment_state: "discovered" | "enriching" | "enriched" | "error" | null;
}

function shouldShowEmail(c: Contact): boolean {
  // Matches the JSX at ContactRow > Email column:
  //   {c.email ? <code>{c.email}</code> : ...}
  return !!c.email;
}

function emailPillLabel(status: string | null, hasEmail: boolean): string {
  // Matches the EmailPill function post-Phase-64.
  if (!hasEmail) return "Not found";
  const map: Record<string, string> = {
    verified: "Verified ✓",
    likely: "Likely",
    risky: "Risky",
    catch_all: "Catch-all",
    bounced: "Bounced",
    invalid: "Invalid",
    guessed: "Guessed",
    unknown: "Unknown",
    not_found: "Unknown",
    found: "Verified ✓",
  };
  if (status && map[status]) return map[status];
  return "Unknown";
}

let failures = 0;
let passes = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) passes += 1;
  else {
    failures += 1;
    console.error(`FAIL: ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

// Case 1: Apollo unlocked, MV returned 'unknown', email_status='verified'
// (kept verified per the no-downgrade rule). Email must show.
const c1: Contact = {
  email: "jleggatt@shearwater.com",
  email_status: "verified",
  enrichment_state: "enriched",
};
check("c1: shows email", shouldShowEmail(c1) === true);
check("c1: pill label is 'Verified ✓'", emailPillLabel(c1.email_status, true) === "Verified ✓");

// Case 2: Apollo unlocked but pipeline somehow lost email_status. Email
// is real and must still show; pill falls back to 'Unknown'.
const c2: Contact = {
  email: "jleggatt@shearwater.com",
  email_status: null,
  enrichment_state: "enriched",
};
check("c2: shows email even with null status", shouldShowEmail(c2) === true);
check("c2: pill label falls back to 'Unknown' (NOT dash, NOT 'Not found')", emailPillLabel(c2.email_status, true) === "Unknown");

// Case 3: status='unknown' (MV+ZB both inconclusive, Apollo wasn't
// definite). Email is real and must show; pill says 'Unknown'.
const c3: Contact = {
  email: "ceo@somecompany.com",
  email_status: "unknown",
  enrichment_state: "enriched",
};
check("c3: shows email when status is 'unknown'", shouldShowEmail(c3) === true);
check("c3: pill label is 'Unknown'", emailPillLabel(c3.email_status, true) === "Unknown");

// Case 4: status='not_found' with email — defensive case; if email
// somehow exists alongside 'not_found' (shouldn't, but) show the email.
const c4: Contact = {
  email: "x@y.com",
  email_status: "not_found",
  enrichment_state: "enriched",
};
check("c4: shows email even with stale 'not_found' status", shouldShowEmail(c4) === true);
check("c4: pill maps 'not_found' to 'Unknown' when email is present", emailPillLabel(c4.email_status, true) === "Unknown");

// Case 5: genuinely no email — pill says 'Not found'.
const c5: Contact = {
  email: null,
  email_status: "not_found",
  enrichment_state: "enriched",
};
check("c5: does NOT show email when email is null", shouldShowEmail(c5) === false);
check("c5: pill says 'Not found' when no email", emailPillLabel(c5.email_status, false) === "Not found");

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
