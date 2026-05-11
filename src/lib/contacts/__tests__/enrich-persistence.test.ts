/**
 * Phase 64 — Persistence + verifier-fallthrough regression test.
 *
 * Three independent regressions surfaced in the live Phase 63 test on
 * Shearwater (2026-05-11). Each is asserted below:
 *
 *   1. Persistence: after a successful Apollo unlock,
 *      enrichSingleContact's result MUST carry email / last_name /
 *      full_name / email_source. Callers (orchestrator and on-demand
 *      endpoint) write these back to brand_contacts. The pre-fix code
 *      wrote 'apollo_match' to email_source which violated the DB
 *      CHECK constraint and silently dropped the entire update. We now
 *      write 'apollo' (allowed by the constraint).
 *
 *   2. MV → ZB fallthrough: when MillionVerifier returns 'unknown',
 *      verifyEmail MUST call ZeroBounce. The result's verifier should
 *      be 'zerobounce' (ZB ran), and both providers' raw payloads
 *      must be available so we can persist each to its own audit
 *      event row.
 *
 *   3. No-downgrade: an Apollo-verified email whose MV/ZB verdict is
 *      'unknown' MUST stay email_status='verified' (Apollo's verdict
 *      is the ground truth; the verifier was inconclusive). The
 *      verifier_score is still persisted so the operator can see the
 *      inconclusive verification.
 *
 * Run with:
 *
 *   npx tsx src/lib/contacts/__tests__/enrich-persistence.test.ts
 */
import Module from "module";

interface ApolloUnlockResponse {
  person: {
    id: string;
    first_name: string;
    last_name: string;
    email: string;
    email_status: string;
  };
}

// --- Module stubs. The pipeline imports `@/lib/supabase/server` to
// write events; we make that a no-op admin client.
const fakeEvents: Array<Record<string, unknown>> = [];
const fakeAdmin = {
  from(table: string) {
    const builder: any = {
      insert(payload: Record<string, unknown>) {
        if (table === "brand_contact_discovery_events") {
          fakeEvents.push(payload);
        }
        return builder;
      },
      upsert() { return builder; },
      update() { return builder; },
      delete() { return builder; },
      eq() { return builder; },
      in() { return builder; },
      order() { return builder; },
      select() { return builder; },
      async maybeSingle() { return { data: null, error: null }; },
      then(resolve: (v: { data: unknown; error: null }) => void) {
        resolve({ data: null, error: null });
      },
    };
    return builder;
  },
};

const originalResolve = (
  Module as unknown as {
    _resolveFilename: (req: string, parent: NodeJS.Module, ...rest: unknown[]) => string;
  }
)._resolveFilename;
(Module as unknown as {
  _resolveFilename: (req: string, parent: NodeJS.Module, ...rest: unknown[]) => string;
})._resolveFilename = function (
  request: string,
  parent: NodeJS.Module,
  ...rest: unknown[]
): string {
  if (request === "@/lib/supabase/server") {
    return require.resolve("./__supabase_stub_persistence__.cjs");
  }
  return originalResolve.call(this, request, parent, ...rest);
};

import * as fs from "fs";
import * as path from "path";
const stubPath = path.join(__dirname, "__supabase_stub_persistence__.cjs");
fs.writeFileSync(
  stubPath,
  `module.exports = {\n  createSupabaseAdminClient() { return globalThis.__FAKE_PERSISTENCE_ADMIN__ ?? null; },\n  createSupabaseServerClient() { return null; },\n};\n`,
);
(globalThis as Record<string, unknown>).__FAKE_PERSISTENCE_ADMIN__ = fakeAdmin;

process.env.APOLLO_API_KEY = "test";
process.env.HUNTER_API_KEY = "test";
process.env.MILLIONVERIFIER_API_KEY = "test";
process.env.ZEROBOUNCE_API_KEY = "test";

// --- Fetch stub. Track which providers were called.
interface CallLog { url: string; }
const fetchCalls: CallLog[] = [];

const APOLLO_UNLOCK: ApolloUnlockResponse = {
  person: {
    id: "apollo-1",
    first_name: "Jason",
    last_name: "Leggatt",
    email: "jleggatt@shearwater.com",
    email_status: "verified",
  },
};
// resultcode 5 is MV's "Unknown" code. (resultcode 4 is reserved for the
// "Apikey not found" provider failure — see Phase 65 verifier-transparency
// tests; mixing it in here would now classify the response as a provider
// failure rather than an inconclusive verdict.)
const MV_UNKNOWN = { email: "jleggatt@shearwater.com", result: "unknown", resultcode: 5 };
const ZB_UNKNOWN = { email: "jleggatt@shearwater.com", status: "unknown" };
const ZB_VALID = { email: "jleggatt@shearwater.com", status: "valid" };

let mvResponse: unknown = MV_UNKNOWN;
let zbResponse: unknown = ZB_UNKNOWN;

// @ts-expect-error — override global fetch.
global.fetch = async (input: RequestInfo | URL) => {
  const url = String(input);
  fetchCalls.push({ url });
  if (url.includes("apollo.io/api/v1/people/match")) {
    return new Response(JSON.stringify(APOLLO_UNLOCK), { status: 200 });
  }
  if (url.includes("api.hunter.io/")) {
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }
  if (url.includes("api.millionverifier.com")) {
    return new Response(JSON.stringify(mvResponse), { status: 200 });
  }
  if (url.includes("api.zerobounce.net")) {
    return new Response(JSON.stringify(zbResponse), { status: 200 });
  }
  return new Response("{}", { status: 200 });
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { enrichSingleContact } = require("../enrich-contact") as typeof import("../enrich-contact");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { verifyEmail } = require("../email-verify") as typeof import("../email-verify");

let failures = 0;
let passes = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) passes += 1;
  else {
    failures += 1;
    console.error(`FAIL: ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

function countCalls(needle: string): number {
  return fetchCalls.filter((c) => c.url.includes(needle)).length;
}

async function testPersistenceAfterApolloUnlock(): Promise<void> {
  fetchCalls.length = 0;
  fakeEvents.length = 0;
  mvResponse = MV_UNKNOWN;
  zbResponse = ZB_UNKNOWN;

  const result = await enrichSingleContact({
    brand_id: "brand-1",
    run_id: "run-1",
    contact_id: "contact-1",
    domain: "shearwater.com",
    first_name: "Jason",
    last_name: null, // simulate the prod symptom: last_name missing on row, Apollo provides it
    full_name: "Jason",
    organization_name: "Shearwater Research",
    apollo_person_id: "apollo-1",
  });

  // Persistence: result must carry the Apollo-unlock fields downstream.
  check(
    "result.email is the Apollo-unlocked email",
    result.email === "jleggatt@shearwater.com",
    `got ${result.email}`,
  );
  check(
    "result.last_name was hydrated from Apollo unlock",
    result.last_name === "Leggatt",
    `got ${result.last_name}`,
  );
  check(
    "result.full_name was extended with Apollo's last_name",
    result.full_name === "Jason Leggatt",
    `got ${result.full_name}`,
  );
  check(
    "result.email_source is the constraint-allowed 'apollo' (NOT 'apollo_match')",
    result.email_source === "apollo",
    `got ${result.email_source}`,
  );
  check(
    "result.raw_apollo_match is populated",
    result.raw_apollo_match != null,
    `got ${typeof result.raw_apollo_match}`,
  );

  // No-downgrade: Apollo said verified, MV/ZB both said unknown,
  // emailStatus must stay 'verified'.
  check(
    "Apollo-verified email is NOT downgraded by MV/ZB 'unknown'",
    result.email_status === "verified",
    `got ${result.email_status}`,
  );

  // Verifier metadata is still persisted (operator can see verifier
  // was inconclusive).
  check(
    "email_verifier is set (zerobounce, since MV unknown → fell through)",
    result.email_verifier === "zerobounce",
    `got ${result.email_verifier}`,
  );
}

async function testMvUnknownFallsThroughToZb(): Promise<void> {
  fetchCalls.length = 0;
  fakeEvents.length = 0;
  mvResponse = MV_UNKNOWN;
  zbResponse = ZB_VALID;

  const v = await verifyEmail("jleggatt@shearwater.com");
  check(
    "MV unknown → ZB was called",
    countCalls("api.zerobounce.net") === 1,
    `mv=${countCalls("api.millionverifier.com")} zb=${countCalls("api.zerobounce.net")}`,
  );
  check(
    "ZB verdict 'valid' becomes status 'verified'",
    v.status === "verified" && v.verifier === "zerobounce",
    `status=${v.status} verifier=${v.verifier}`,
  );
  check(
    "verify result carries MV's raw response for audit-trail",
    v.mv_raw != null && (v.mv_status === "unknown"),
    `mv_raw=${JSON.stringify(v.mv_raw)} mv_status=${v.mv_status}`,
  );
  check(
    "verify result carries ZB's raw response too",
    v.zb_raw != null,
    `zb_raw=${JSON.stringify(v.zb_raw)}`,
  );
}

async function testMvVerifiedShortCircuits(): Promise<void> {
  fetchCalls.length = 0;
  mvResponse = { email: "x@y.com", result: "ok", quality_score: 95 };
  zbResponse = ZB_UNKNOWN;

  const v = await verifyEmail("x@y.com");
  check(
    "MV 'ok' short-circuits — ZB is NOT called",
    countCalls("api.zerobounce.net") === 0,
    `zb=${countCalls("api.zerobounce.net")}`,
  );
  check(
    "MV 'ok' maps to status='verified'",
    v.status === "verified" && v.verifier === "millionverifier",
    `status=${v.status} verifier=${v.verifier}`,
  );
}

async function testRawPayloadOnEvents(): Promise<void> {
  fetchCalls.length = 0;
  fakeEvents.length = 0;
  mvResponse = MV_UNKNOWN;
  zbResponse = ZB_VALID;

  await enrichSingleContact({
    brand_id: "brand-1",
    run_id: "run-2",
    contact_id: "contact-2",
    domain: "shearwater.com",
    first_name: "Jason",
    last_name: "Leggatt",
    full_name: "Jason Leggatt",
    organization_name: "Shearwater",
    apollo_person_id: "apollo-1",
  });

  const mvEvent = fakeEvents.find((e) => e.provider === "millionverifier");
  const zbEvent = fakeEvents.find((e) => e.provider === "zerobounce");
  check(
    "MV event has raw_payload (even when ZB ended up authoritative)",
    mvEvent != null && mvEvent.raw_payload != null,
    `mv raw_payload=${JSON.stringify(mvEvent?.raw_payload)}`,
  );
  check(
    "ZB event has raw_payload",
    zbEvent != null && zbEvent.raw_payload != null,
    `zb raw_payload=${JSON.stringify(zbEvent?.raw_payload)}`,
  );
  check(
    "MV event records the 'unknown' status it actually returned",
    mvEvent != null && mvEvent.status_returned === "unknown",
    `mv status_returned=${mvEvent?.status_returned}`,
  );
}

async function main(): Promise<void> {
  await testPersistenceAfterApolloUnlock();
  await testMvUnknownFallsThroughToZb();
  await testMvVerifiedShortCircuits();
  await testRawPayloadOnEvents();
  try { fs.unlinkSync(stubPath); } catch { /* ignore */ }
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

void main();
