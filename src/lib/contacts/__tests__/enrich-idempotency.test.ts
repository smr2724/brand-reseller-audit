/**
 * Phase 63 follow-up — server-side idempotency test for the on-demand
 * /api/brands/[id]/contacts/[contactId]/enrich endpoint.
 *
 * Run directly with tsx:
 *
 *   npx tsx src/lib/contacts/__tests__/enrich-idempotency.test.ts
 *
 * The endpoint must do an OPTIMISTIC CLAIM (set enrichment_state to
 * 'enriching' WHERE state='discovered') BEFORE calling apolloUnlockPerson.
 * Two simultaneous calls on the same contact id must result in:
 *
 *   - first call → 200 ok, exactly ONE apolloUnlockPerson call (=1 credit)
 *   - second call → 409 already_enriched_or_in_progress, NO new
 *                   apolloUnlockPerson call
 *   - final row state → 'enriched' (or 'error'), NEVER stuck at 'enriching'
 *
 * Stubs `@/lib/supabase/server` and `next/headers` BEFORE the route
 * module is imported. fetch is stubbed to count Apollo /people/match
 * calls so we can assert credit-burn count exactly.
 */

// --- Stub modules BEFORE importing the route handler.
import Module from "module";
import * as fs from "fs";
import * as path from "path";

interface ContactRow {
  id: string;
  brand_id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  company_domain: string | null;
  apollo_person_id: string | null;
  company_name: string | null;
  enrichment_state: string;
  email: string | null;
  email_source: string | null;
  email_status: string | null;
  ready_to_send: boolean;
}

const CONTACT_ID = "contact-1";
const BRAND_ID = "brand-1";
const USER_ID = "user-1";

const fakeDb = {
  contacts: new Map<string, ContactRow>(),
  brands: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
};

fakeDb.brands.set(BRAND_ID, {
  id: BRAND_ID,
  user_id: USER_ID,
  resolved_owner_domain: "shearwater.com",
});
fakeDb.contacts.set(CONTACT_ID, {
  id: CONTACT_ID,
  brand_id: BRAND_ID,
  full_name: "Jason Black",
  first_name: "Jason",
  last_name: "Black",
  company_domain: "shearwater.com",
  apollo_person_id: "apollo-1",
  company_name: "Shearwater Research",
  enrichment_state: "discovered",
  email: null,
  email_source: null,
  email_status: null,
  ready_to_send: false,
});

// Track ALL update calls so we can audit the lifecycle: 'discovered'
// must transition through 'enriching' → 'enriched' on the success path.
const updateLog: Array<{ id: string; payload: Record<string, unknown> }> = [];

interface PendingFilter { col: string; val: unknown; }

function makeQuery(table: string): any {
  const pendingFilters: PendingFilter[] = [];
  let pendingPayload: Record<string, unknown> | null = null;
  let op: "select" | "insert" | "update" | "delete" = "select";

  function tableRows(): Record<string, unknown>[] {
    switch (table) {
      case "brands": return Array.from(fakeDb.brands.values());
      case "brand_contacts": return Array.from(fakeDb.contacts.values()) as Record<string, unknown>[];
      case "brand_contact_discovery_events": return fakeDb.events;
      default: return [];
    }
  }

  function applyFilters(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return rows.filter((r) => pendingFilters.every((f) => r[f.col] === f.val));
  }

  const builder: any = {
    select(_cols?: string) {
      // .select() after .update() / .insert() is "return the affected rows",
      // not a new SELECT — keep the prior op.
      if (op !== "update" && op !== "insert" && op !== "delete") op = "select";
      return builder;
    },
    insert(payload: Record<string, unknown>) {
      op = "insert";
      pendingPayload = payload;
      if (table === "brand_contact_discovery_events") fakeDb.events.push(payload);
      return builder;
    },
    update(payload: Record<string, unknown>) {
      op = "update";
      pendingPayload = payload;
      return builder;
    },
    delete() { op = "delete"; return builder; },
    eq(col: string, val: unknown) { pendingFilters.push({ col, val }); return builder; },
    in(_col: string, _vals: unknown[]) { return builder; },
    order(_col: string, _opts?: unknown) { return builder; },
    async maybeSingle() {
      if (op === "select") {
        const rows = applyFilters(tableRows());
        return { data: rows[0] ?? null, error: null };
      }
      if (op === "update") {
        const rows = applyFilters(tableRows());
        if (rows.length === 0) {
          // emulate PGRST116 — no rows
          return { data: null, error: null };
        }
        const row = rows[0];
        if (pendingPayload) {
          Object.assign(row, pendingPayload);
          updateLog.push({ id: String(row.id), payload: { ...pendingPayload } });
        }
        return { data: row, error: null };
      }
      if (op === "insert") {
        return { data: pendingPayload, error: null };
      }
      return { data: null, error: null };
    },
    then(resolve: (v: { data: unknown; error: null }) => void) {
      if (op === "select") {
        const rows = applyFilters(tableRows());
        resolve({ data: rows, error: null });
        return;
      }
      if (op === "update") {
        const rows = applyFilters(tableRows());
        for (const row of rows) {
          if (pendingPayload) {
            Object.assign(row, pendingPayload);
            updateLog.push({ id: String(row.id), payload: { ...pendingPayload } });
          }
        }
        resolve({ data: null, error: null });
        return;
      }
      resolve({ data: null, error: null });
    },
  };
  return builder;
}

const fakeAdminClient = {
  from(table: string) { return makeQuery(table); },
};

const fakeServerClient = {
  from(table: string) { return makeQuery(table); },
  auth: {
    async getUser() {
      return { data: { user: { id: USER_ID } }, error: null };
    },
  },
};

// Hijack module resolution so the route's `@/lib/supabase/server` import
// (and `next/headers`) goes to our in-memory stub.
const originalResolve = (Module as unknown as {
  _resolveFilename: (req: string, parent: NodeJS.Module, ...rest: unknown[]) => string;
})._resolveFilename;
(Module as unknown as {
  _resolveFilename: (req: string, parent: NodeJS.Module, ...rest: unknown[]) => string;
})._resolveFilename = function (request: string, parent: NodeJS.Module, ...rest: unknown[]): string {
  if (request === "@/lib/supabase/server") {
    return require.resolve("./__supabase_stub_enrich__.cjs");
  }
  if (request === "next/headers") {
    return require.resolve("./__next_headers_stub__.cjs");
  }
  return originalResolve.call(this, request, parent, ...rest);
};

const stubDir = __dirname;
const supabaseStubPath = path.join(stubDir, "__supabase_stub_enrich__.cjs");
const nextHeadersStubPath = path.join(stubDir, "__next_headers_stub__.cjs");
fs.writeFileSync(
  supabaseStubPath,
  `module.exports = {\n  createSupabaseAdminClient() { return globalThis.__FAKE_SUPABASE_ADMIN__ ?? null; },\n  createSupabaseServerClient() { return globalThis.__FAKE_SUPABASE_SERVER__ ?? null; },\n};\n`,
);
fs.writeFileSync(
  nextHeadersStubPath,
  `module.exports = { cookies() { return { get() {}, set() {} }; } };\n`,
);
(globalThis as Record<string, unknown>).__FAKE_SUPABASE_ADMIN__ = fakeAdminClient;
(globalThis as Record<string, unknown>).__FAKE_SUPABASE_SERVER__ = fakeServerClient;

process.env.APOLLO_API_KEY = "test";
process.env.HUNTER_API_KEY = "test";
process.env.MILLIONVERIFIER_API_KEY = "test";

interface CallLog { url: string; body: string; }
const fetchCalls: CallLog[] = [];

const apolloUnlockResp = {
  person: {
    id: "apollo-1",
    first_name: "Jason",
    last_name: "Black",
    email: "jason@shearwater.com",
    email_status: "verified",
  },
};
const mvResp = { email: "jason@shearwater.com", result: "ok", resultcode: 1, quality: "good" };

// @ts-expect-error — override global fetch.
global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = String(init?.body ?? "");
  fetchCalls.push({ url, body });
  if (url.includes("apollo.io/api/v1/people/match")) {
    return new Response(JSON.stringify(apolloUnlockResp), { status: 200 });
  }
  if (url.includes("api.hunter.io/v2/domain-search")) {
    return new Response(
      JSON.stringify({ data: { pattern: "{f}{last}", confidence_score: 98 } }),
      { status: 200 },
    );
  }
  if (url.includes("api.hunter.io/v2/email-finder")) {
    return new Response(JSON.stringify({ data: { email: null, score: null } }), { status: 200 });
  }
  if (url.includes("api.millionverifier.com")) {
    return new Response(JSON.stringify(mvResp), { status: 200 });
  }
  if (url.includes("api.zerobounce.net")) {
    return new Response(JSON.stringify({ status: "unknown" }), { status: 200 });
  }
  return new Response("{}", { status: 200 });
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { POST } = require("../../../app/api/brands/[id]/contacts/[contactId]/enrich/route") as {
  POST: (req: Request, ctx: { params: { id: string; contactId: string } }) => Promise<Response>;
};

let failures = 0;
let passes = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) passes += 1;
  else { failures += 1; console.error(`FAIL: ${name}${detail ? `\n  ${detail}` : ""}`); }
}

function countApolloMatch(): number {
  return fetchCalls.filter((c) => c.url.includes("apollo.io/api/v1/people/match")).length;
}

async function callEnrich(): Promise<{ status: number; body: any }> {
  const req = new Request("http://localhost/api/brands/brand-1/contacts/contact-1/enrich", {
    method: "POST",
  });
  const res = await POST(req, { params: { id: BRAND_ID, contactId: CONTACT_ID } });
  const body = await res.json();
  return { status: res.status, body };
}

async function main(): Promise<void> {
  // Sanity: contact starts at 'discovered'.
  check(
    "starts at 'discovered'",
    fakeDb.contacts.get(CONTACT_ID)?.enrichment_state === "discovered",
    String(fakeDb.contacts.get(CONTACT_ID)?.enrichment_state),
  );

  // First call: should succeed and burn exactly one Apollo credit.
  const first = await callEnrich();
  check(
    "first call → 200 ok",
    first.status === 200 && first.body.ok === true,
    `status=${first.status} body=${JSON.stringify(first.body)}`,
  );
  check(
    "first call → exactly 1 Apollo /people/match call",
    countApolloMatch() === 1,
    `got ${countApolloMatch()}`,
  );
  check(
    "first call → row state is 'enriched'",
    fakeDb.contacts.get(CONTACT_ID)?.enrichment_state === "enriched",
    String(fakeDb.contacts.get(CONTACT_ID)?.enrichment_state),
  );

  // Update log must show the claim transition.
  const sawClaimToEnriching = updateLog.some(
    (u) => u.id === CONTACT_ID && u.payload.enrichment_state === "enriching",
  );
  check(
    "first call did an optimistic claim (discovered → enriching)",
    sawClaimToEnriching,
    `updateLog states: ${updateLog.map((u) => u.payload.enrichment_state).join(",")}`,
  );

  // Second call on the same contact: must NOT burn another credit.
  const apolloCountBefore = countApolloMatch();
  const second = await callEnrich();
  check(
    "second call → 409 already_enriched_or_in_progress",
    second.status === 409 && second.body.error === "already_enriched_or_in_progress",
    `status=${second.status} body=${JSON.stringify(second.body)}`,
  );
  check(
    "second call returns the current state in the body",
    second.body.state === "enriched",
    `state=${second.body.state}`,
  );
  check(
    "second call → NO new Apollo /people/match call (no duplicate credit)",
    countApolloMatch() === apolloCountBefore,
    `before=${apolloCountBefore} after=${countApolloMatch()}`,
  );

  // Final state: must be terminal ('enriched' or 'error'), never 'enriching'.
  const finalState = fakeDb.contacts.get(CONTACT_ID)?.enrichment_state;
  check(
    "final state is terminal — never left at 'enriching'",
    finalState === "enriched" || finalState === "error",
    `final=${finalState}`,
  );
  check(
    "final state for successful run is 'enriched'",
    finalState === "enriched",
    `final=${finalState}`,
  );

  // Cleanup stub files.
  try { fs.unlinkSync(supabaseStubPath); } catch { /* ignore */ }
  try { fs.unlinkSync(nextHeadersStubPath); } catch { /* ignore */ }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

void main();
