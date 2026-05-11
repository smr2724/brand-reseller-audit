/**
 * Phase 65 — Verifier transparency + MV error classification.
 *
 * Asserts the matrix from the Phase 65 spec:
 *
 *   1. MV returns {result:'error', resultcode:4, error:'Apikey not found'}
 *      → outcome 'error', ZB is called, verbatim message in reason.
 *   2. MV returns {result:'ok', subresult:'good'} → outcome 'found',
 *      status 'verified', ZB is short-circuited.
 *   3. MV returns {result:'unknown', resultcode:5} (inconclusive) →
 *      outcome 'found' with status 'unknown', ZB is called.
 *   4. MV HTTP 500 → outcome 'error', ZB is called.
 *   5. Apollo verified + MV failed + ZB verified →
 *      email_status='verified', email_verifier='zerobounce'.
 *   6. Apollo verified + MV failed + ZB failed →
 *      email_status='verified' (Apollo no-downgrade rule),
 *      email_verifier='none'.
 *   7. Audit event reasons include the actual provider error message
 *      verbatim ("Apikey not found").
 *   8. MV failed + ZB inconclusive → email_verifier='zerobounce'
 *      (last verifier that ran is recorded).
 *
 * Run directly with:
 *   npx tsx src/lib/contacts/__tests__/verifier-transparency.test.ts
 */
import Module from "module";
import * as fs from "fs";
import * as path from "path";

const fakeEvents: Array<Record<string, unknown>> = [];
const fakeAdmin = {
  from(table: string) {
    const builder: {
      insert: (payload: Record<string, unknown>) => typeof builder;
      upsert: () => typeof builder;
      update: () => typeof builder;
      delete: () => typeof builder;
      eq: () => typeof builder;
      in: () => typeof builder;
      order: () => typeof builder;
      select: () => typeof builder;
      maybeSingle: () => Promise<{ data: null; error: null }>;
      then: (resolve: (v: { data: null; error: null }) => void) => void;
    } = {
      insert(payload) {
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
      then(resolve) { resolve({ data: null, error: null }); },
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
    return require.resolve("./__supabase_stub_phase65__.cjs");
  }
  return originalResolve.call(this, request, parent, ...rest);
};

const stubPath = path.join(__dirname, "__supabase_stub_phase65__.cjs");
fs.writeFileSync(
  stubPath,
  `module.exports = {\n  createSupabaseAdminClient() { return globalThis.__FAKE_PHASE65_ADMIN__ ?? null; },\n  createSupabaseServerClient() { return null; },\n};\n`,
);
(globalThis as Record<string, unknown>).__FAKE_PHASE65_ADMIN__ = fakeAdmin;

process.env.APOLLO_API_KEY = "test";
process.env.HUNTER_API_KEY = "test";
process.env.MILLIONVERIFIER_API_KEY = "test";
process.env.ZEROBOUNCE_API_KEY = "test";

interface CallLog { url: string; }
const fetchCalls: CallLog[] = [];

const APOLLO_VERIFIED = {
  person: {
    id: "apollo-1",
    first_name: "Jason",
    last_name: "Leggatt",
    email: "jleggatt@shearwater.com",
    email_status: "verified",
  },
};

const MV_KEY_NOT_FOUND = {
  free: false,
  role: false,
  email: "jleggatt@shearwater.com",
  error: "Apikey not found",
  result: "error",
  credits: 0,
  livemode: true,
  subresult: "",
  didyoumean: "",
  resultcode: 4,
  executiontime: 0,
};
const MV_OK = { email: "jleggatt@shearwater.com", result: "ok", quality_score: 95 };
const MV_UNKNOWN_INCONCLUSIVE = {
  email: "jleggatt@shearwater.com",
  result: "unknown",
  resultcode: 5,
};
const MV_CATCH_ALL = {
  email: "jleggatt@shearwater.com",
  result: "catch_all",
  quality_score: 50,
};
const ZB_VALID = { email: "jleggatt@shearwater.com", status: "valid" };
const ZB_INVALID = { email: "jleggatt@shearwater.com", status: "invalid" };
const ZB_UNKNOWN = { email: "jleggatt@shearwater.com", status: "unknown" };
const ZB_AUTH_ERROR = {
  email: null,
  status: null,
  error: "Invalid API Key",
};

type MvKind = "key-not-found" | "ok" | "unknown" | "catch-all" | "http-500";
type ZbKind = "valid" | "invalid" | "unknown" | "auth-error" | "http-500";
let mvKind: MvKind = "key-not-found";
let zbKind: ZbKind = "valid";

// @ts-expect-error — override global fetch.
global.fetch = async (input: RequestInfo | URL) => {
  const url = String(input);
  fetchCalls.push({ url });
  if (url.includes("apollo.io/api/v1/people/match")) {
    return new Response(JSON.stringify(APOLLO_VERIFIED), { status: 200 });
  }
  if (url.includes("api.hunter.io/")) {
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }
  if (url.includes("api.millionverifier.com")) {
    switch (mvKind) {
      case "key-not-found":
        return new Response(JSON.stringify(MV_KEY_NOT_FOUND), { status: 200 });
      case "ok":
        return new Response(JSON.stringify(MV_OK), { status: 200 });
      case "unknown":
        return new Response(JSON.stringify(MV_UNKNOWN_INCONCLUSIVE), { status: 200 });
      case "catch-all":
        return new Response(JSON.stringify(MV_CATCH_ALL), { status: 200 });
      case "http-500":
        return new Response("server down", { status: 500 });
    }
  }
  if (url.includes("api.zerobounce.net")) {
    switch (zbKind) {
      case "valid":
        return new Response(JSON.stringify(ZB_VALID), { status: 200 });
      case "invalid":
        return new Response(JSON.stringify(ZB_INVALID), { status: 200 });
      case "unknown":
        return new Response(JSON.stringify(ZB_UNKNOWN), { status: 200 });
      case "auth-error":
        return new Response(JSON.stringify(ZB_AUTH_ERROR), { status: 200 });
      case "http-500":
        return new Response("server down", { status: 500 });
    }
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
  if (condition) {
    passes += 1;
  } else {
    failures += 1;
    console.error(`FAIL: ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

function countCalls(needle: string): number {
  return fetchCalls.filter((c) => c.url.includes(needle)).length;
}

function resetCallTracking() {
  fetchCalls.length = 0;
  fakeEvents.length = 0;
}

// 1. MV returns resultcode 4 + "Apikey not found" → outcome 'error', ZB runs.
async function testMvKeyNotFoundClassifiedAsError(): Promise<void> {
  resetCallTracking();
  mvKind = "key-not-found";
  zbKind = "valid";

  const v = await verifyEmail("jleggatt@shearwater.com");
  check(
    "MV resultcode=4 → ZB is called",
    countCalls("api.zerobounce.net") === 1,
    `zb calls=${countCalls("api.zerobounce.net")}`,
  );
  check(
    "verifyEmail surfaces MV error message via mv_error",
    typeof v.mv_error === "string" && v.mv_error.includes("Apikey not found"),
    `mv_error=${v.mv_error}`,
  );
  check(
    "verifyEmail returns ZB's authoritative verdict when MV failed",
    v.verifier === "zerobounce" && v.status === "verified",
    `verifier=${v.verifier} status=${v.status}`,
  );
  check(
    "MV raw payload is preserved on the result for audit-trail",
    v.mv_raw != null && typeof (v.mv_raw as { error?: string })?.error === "string",
    `mv_raw=${JSON.stringify(v.mv_raw)}`,
  );
}

// 2. MV returns 'ok' → outcome 'found' / verified, ZB short-circuited.
async function testMvOkShortCircuits(): Promise<void> {
  resetCallTracking();
  mvKind = "ok";
  zbKind = "valid";

  const v = await verifyEmail("jleggatt@shearwater.com");
  check(
    "MV 'ok' short-circuits — ZB is NOT called",
    countCalls("api.zerobounce.net") === 0,
    `zb calls=${countCalls("api.zerobounce.net")}`,
  );
  check(
    "MV 'ok' → status verified, verifier millionverifier",
    v.status === "verified" && v.verifier === "millionverifier",
    `status=${v.status} verifier=${v.verifier}`,
  );
  check(
    "MV 'ok' has no .error field (it succeeded)",
    v.error === undefined,
    `error=${v.error}`,
  );
}

// 3. MV returns 'unknown' (inconclusive) → falls through to ZB.
async function testMvInconclusiveFallsThrough(): Promise<void> {
  resetCallTracking();
  mvKind = "unknown";
  zbKind = "valid";

  const v = await verifyEmail("jleggatt@shearwater.com");
  check(
    "MV inconclusive → ZB is called",
    countCalls("api.zerobounce.net") === 1,
    `zb calls=${countCalls("api.zerobounce.net")}`,
  );
  check(
    "MV inconclusive has NO .mv_error (it ran fine, verdict just inconclusive)",
    v.mv_error === undefined,
    `mv_error=${v.mv_error}`,
  );
  check(
    "MV mv_status preserved as 'unknown'",
    v.mv_status === "unknown",
    `mv_status=${v.mv_status}`,
  );
}

// 4. MV HTTP 500 → outcome 'error', ZB called.
async function testMvHttp500ClassifiedAsError(): Promise<void> {
  resetCallTracking();
  mvKind = "http-500";
  zbKind = "valid";

  const v = await verifyEmail("jleggatt@shearwater.com");
  check(
    "MV HTTP 5xx (after retries) → ZB is called",
    countCalls("api.zerobounce.net") === 1,
    `zb calls=${countCalls("api.zerobounce.net")}`,
  );
  check(
    "MV HTTP 5xx → mv_error is set",
    typeof v.mv_error === "string" && v.mv_error.length > 0,
    `mv_error=${v.mv_error}`,
  );
}

// 5. Apollo verified + MV failed + ZB verified → status verified, verifier=zerobounce.
async function testApolloVerifiedMvFailedZbVerified(): Promise<void> {
  resetCallTracking();
  mvKind = "key-not-found";
  zbKind = "valid";

  const result = await enrichSingleContact({
    brand_id: "brand-1",
    run_id: "run-1",
    contact_id: "contact-1",
    domain: "shearwater.com",
    first_name: "Jason",
    last_name: "Leggatt",
    full_name: "Jason Leggatt",
    organization_name: "Shearwater",
    apollo_person_id: "apollo-1",
  });
  check(
    "Apollo-verified email stays email_status='verified' even with MV failure",
    result.email_status === "verified",
    `status=${result.email_status}`,
  );
  check(
    "email_verifier='zerobounce' when MV failed and ZB verified",
    result.email_verifier === "zerobounce",
    `verifier=${result.email_verifier}`,
  );
  // MV event should be outcome 'error' with verbatim message in reason.
  const mvEvent = fakeEvents.find((e) => e.provider === "millionverifier");
  check(
    "MV event outcome is 'error' (not 'found' or 'skipped')",
    mvEvent != null && mvEvent.outcome === "error",
    `mv outcome=${mvEvent?.outcome}`,
  );
  check(
    "MV event reason contains verbatim 'Apikey not found'",
    mvEvent != null &&
      typeof mvEvent.reason === "string" &&
      mvEvent.reason.includes("Apikey not found"),
    `mv reason=${mvEvent?.reason}`,
  );
  check(
    "MV event status_returned is null on provider failure (not 'unknown')",
    mvEvent != null && mvEvent.status_returned === null,
    `mv status_returned=${mvEvent?.status_returned}`,
  );
  check(
    "MV event raw_payload is preserved",
    mvEvent != null && mvEvent.raw_payload != null,
    `mv raw=${JSON.stringify(mvEvent?.raw_payload)}`,
  );
  // ZB event should be 'found' / verified.
  const zbEvent = fakeEvents.find((e) => e.provider === "zerobounce");
  check(
    "ZB event outcome is 'found' (it ran and succeeded)",
    zbEvent != null && zbEvent.outcome === "found",
    `zb outcome=${zbEvent?.outcome}`,
  );
}

// 6. Apollo verified + MV failed + ZB failed → Apollo verdict preserved,
//    email_verifier='none'.
async function testApolloVerifiedBothVerifiersFailed(): Promise<void> {
  resetCallTracking();
  mvKind = "key-not-found";
  zbKind = "auth-error";

  const result = await enrichSingleContact({
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
  check(
    "Apollo no-downgrade: status stays 'verified' even with both verifiers failed",
    result.email_status === "verified",
    `status=${result.email_status}`,
  );
  check(
    "email_verifier='none' when BOTH MV and ZB failed at provider level",
    result.email_verifier === "none",
    `verifier=${result.email_verifier}`,
  );
  const mvEvent = fakeEvents.find((e) => e.provider === "millionverifier");
  const zbEvent = fakeEvents.find((e) => e.provider === "zerobounce");
  check(
    "MV event outcome is 'error'",
    mvEvent?.outcome === "error",
    `mv outcome=${mvEvent?.outcome}`,
  );
  check(
    "ZB event outcome is 'error'",
    zbEvent?.outcome === "error",
    `zb outcome=${zbEvent?.outcome}`,
  );
  check(
    "ZB event reason mentions the ZB provider failure verbatim",
    typeof zbEvent?.reason === "string" &&
      (zbEvent.reason as string).includes("Invalid API Key"),
    `zb reason=${zbEvent?.reason}`,
  );
}

// 7. Apollo verified + MV failed + ZB inconclusive → verifier=zerobounce.
async function testApolloVerifiedMvFailedZbInconclusive(): Promise<void> {
  resetCallTracking();
  mvKind = "key-not-found";
  zbKind = "unknown";

  const result = await enrichSingleContact({
    brand_id: "brand-1",
    run_id: "run-3",
    contact_id: "contact-3",
    domain: "shearwater.com",
    first_name: "Jason",
    last_name: "Leggatt",
    full_name: "Jason Leggatt",
    organization_name: "Shearwater",
    apollo_person_id: "apollo-1",
  });
  check(
    "Apollo-verified row stays 'verified' under MV-failed + ZB-inconclusive",
    result.email_status === "verified",
    `status=${result.email_status}`,
  );
  check(
    "email_verifier='zerobounce' (ZB ran last, even if inconclusive)",
    result.email_verifier === "zerobounce",
    `verifier=${result.email_verifier}`,
  );
}

// 8. ZB unconfigured + MV failed → email_verifier='none'.
//    Regression for the cascade fallthrough that previously leaked
//    'millionverifier' when MV had a provider-level failure and ZB
//    couldn't run because no key was configured.
async function testZbUnconfiguredMvFailed(): Promise<void> {
  resetCallTracking();
  mvKind = "key-not-found";
  zbKind = "valid"; // unused — ZB key is removed below
  const prevZbKey = process.env.ZEROBOUNCE_API_KEY;
  delete process.env.ZEROBOUNCE_API_KEY;
  try {
    const result = await enrichSingleContact({
      brand_id: "brand-1",
      run_id: "run-4",
      contact_id: "contact-4",
      domain: "shearwater.com",
      first_name: "Jason",
      last_name: "Leggatt",
      full_name: "Jason Leggatt",
      organization_name: "Shearwater",
      apollo_person_id: "apollo-1",
    });
    check(
      "ZB unconfigured + MV failed → ZB was NOT called",
      countCalls("api.zerobounce.net") === 0,
      `zb calls=${countCalls("api.zerobounce.net")}`,
    );
    check(
      "ZB unconfigured + MV failed → email_verifier='none' (neither provider decided)",
      result.email_verifier === "none",
      `verifier=${result.email_verifier}`,
    );
    check(
      "Apollo-verified status is preserved when no verifier decided",
      result.email_status === "verified",
      `status=${result.email_status}`,
    );
  } finally {
    if (prevZbKey !== undefined) process.env.ZEROBOUNCE_API_KEY = prevZbKey;
  }
}

// 9. MV catch_all + ZB verified → email_verifier='zerobounce'.
//    Regression for the cascade fallthrough that previously stamped
//    'millionverifier' when MV's verdict was catch_all (technically a
//    definite verdict, but functionally inconclusive — ZB is the one
//    that materially decided email_status).
async function testMvCatchAllZbVerified(): Promise<void> {
  resetCallTracking();
  mvKind = "catch-all";
  zbKind = "valid";

  const result = await enrichSingleContact({
    brand_id: "brand-1",
    run_id: "run-5",
    contact_id: "contact-5",
    domain: "shearwater.com",
    first_name: "Jason",
    last_name: "Leggatt",
    full_name: "Jason Leggatt",
    organization_name: "Shearwater",
    apollo_person_id: "apollo-1",
  });
  check(
    "MV catch_all → ZB was called (catch_all isn't decisive)",
    countCalls("api.zerobounce.net") === 1,
    `zb calls=${countCalls("api.zerobounce.net")}`,
  );
  check(
    "MV catch_all + ZB verified → email_verifier='zerobounce' (ZB materially decided)",
    result.email_verifier === "zerobounce",
    `verifier=${result.email_verifier}`,
  );
  check(
    "MV catch_all + ZB verified → email_status='verified'",
    result.email_status === "verified",
    `status=${result.email_status}`,
  );
}

// 10. MV inconclusive (unknown) + ZB failed → email_verifier='none'.
//     Regression for the cascade fallthrough that previously stamped
//     'millionverifier' when MV returned a bare inconclusive verdict and
//     ZB then failed at the provider level — neither provider produced
//     a decisive verdict.
async function testMvInconclusiveZbFailed(): Promise<void> {
  resetCallTracking();
  mvKind = "unknown";
  zbKind = "auth-error";

  const result = await enrichSingleContact({
    brand_id: "brand-1",
    run_id: "run-6",
    contact_id: "contact-6",
    domain: "shearwater.com",
    first_name: "Jason",
    last_name: "Leggatt",
    full_name: "Jason Leggatt",
    organization_name: "Shearwater",
    apollo_person_id: "apollo-1",
  });
  check(
    "MV inconclusive + ZB failed → email_verifier='none' (no decisive verdict)",
    result.email_verifier === "none",
    `verifier=${result.email_verifier}`,
  );
  check(
    "Apollo-verified status preserved when MV inconclusive + ZB failed",
    result.email_status === "verified",
    `status=${result.email_status}`,
  );
}

async function main(): Promise<void> {
  await testMvKeyNotFoundClassifiedAsError();
  await testMvOkShortCircuits();
  await testMvInconclusiveFallsThrough();
  await testMvHttp500ClassifiedAsError();
  await testApolloVerifiedMvFailedZbVerified();
  await testApolloVerifiedBothVerifiersFailed();
  await testApolloVerifiedMvFailedZbInconclusive();
  await testZbUnconfiguredMvFailed();
  await testMvCatchAllZbVerified();
  await testMvInconclusiveZbFailed();
  try { fs.unlinkSync(stubPath); } catch { /* ignore */ }
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

void main();
