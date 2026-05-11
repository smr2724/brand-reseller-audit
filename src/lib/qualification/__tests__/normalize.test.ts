/**
 * Phase 67 — Regression tests for LLM enum normalization.
 *
 * No test runner is installed; run directly via:
 *   npx tsx src/lib/qualification/__tests__/normalize.test.ts
 */
import {
  clampNote,
  normalizeDisqualificationPattern,
  normalizeIcpVerdict,
  normalizeLegalEntityType,
  normalizeOwnershipSignal,
} from "../normalize";

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

// disqualification_pattern
{
  const r = normalizeDisqualificationPattern(null);
  assert("null → null", r.value === null && r.originalIfClamped === null);
}
{
  const r = normalizeDisqualificationPattern("");
  assert("empty → null", r.value === null && r.originalIfClamped === null);
}
{
  const r = normalizeDisqualificationPattern("public_company");
  assert(
    "whitelist passthrough",
    r.value === "public_company" && r.originalIfClamped === null,
  );
}
{
  const r = normalizeDisqualificationPattern("  Public Company ");
  assert(
    "trim + lower + ws→_ normalizes to whitelist",
    r.value === "public_company" && r.originalIfClamped === null,
  );
}
{
  const r = normalizeDisqualificationPattern("private_label");
  assert(
    "private_label clamps to other",
    r.value === "other" && r.originalIfClamped === "private_label",
  );
}
{
  const r = normalizeDisqualificationPattern("Small Business");
  assert(
    "free-text clamps to other, preserves raw",
    r.value === "other" && r.originalIfClamped === "Small Business",
  );
}

// legal_entity_type
{
  const r = normalizeLegalEntityType("LLC");
  assert("LEGAL: LLC → llc", r.value === "llc" && r.originalIfClamped === null);
}
{
  const r = normalizeLegalEntityType("nonprofit");
  assert(
    "LEGAL: nonprofit → unknown clamped",
    r.value === "unknown" && r.originalIfClamped === "nonprofit",
  );
}

// ownership_signal
{
  const r = normalizeOwnershipSignal("family_owned");
  assert(
    "OWNERSHIP: family_owned → unknown clamped",
    r.value === "unknown" && r.originalIfClamped === "family_owned",
  );
}
{
  const r = normalizeOwnershipSignal("pe_owned");
  assert(
    "OWNERSHIP: pe_owned passthrough",
    r.value === "pe_owned" && r.originalIfClamped === null,
  );
}

// icp_verdict
{
  const r = normalizeIcpVerdict("qualified");
  assert(
    "VERDICT: qualified passthrough",
    r.value === "qualified" && r.originalIfClamped === null,
  );
}
{
  const r = normalizeIcpVerdict("maybe");
  assert(
    "VERDICT: maybe → needs_review clamped",
    r.value === "needs_review" && r.originalIfClamped === "maybe",
  );
}

// clampNote
{
  const note = clampNote("disqualification_pattern", "private_label", "other");
  assert(
    "clampNote format",
    note ===
      '[disqualification_pattern normalized] LLM returned "private_label"; clamped to "other".',
  );
}

console.log(`normalize tests: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
