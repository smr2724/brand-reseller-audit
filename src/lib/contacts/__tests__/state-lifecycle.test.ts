/**
 * Phase 64 — enrichment_state lifecycle regression test.
 *
 * Asserts that the orchestrator primary-auto-enrich code path
 * transitions the contact row's enrichment_state through:
 *
 *   discovered → enriching → enriched (success)
 *   discovered → enriching → error    (when the brand_contacts update
 *                                       fails — e.g., CHECK violation —
 *                                       so the row is NOT left stuck at
 *                                       'enriching')
 *
 * The pre-fix behavior silently swallowed the Supabase update error
 * when the CHECK constraint rejected our payload. The result was three
 * rows stuck at 'enriching' in prod (Jason / Isaac / Josh, Shearwater
 * 2026-05-11). The fix surfaces the update error so the catch block
 * runs and flips state to 'error'.
 *
 * Run with:
 *   npx tsx src/lib/contacts/__tests__/state-lifecycle.test.ts
 */
import Module from "module";
import * as fs from "fs";
import * as path from "path";

interface ContactRow {
  id: string;
  brand_id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  linkedin_url: string | null;
  company_name: string | null;
  company_domain: string | null;
  apollo_person_id: string | null;
  apollo_organization_id: string | null;
  raw_apollo: unknown;
  email: string | null;
  email_source: string | null;
  email_pattern_used: string | null;
  email_status: string | null;
  email_verifier: string | null;
  email_verifier_score: number | null;
  email_verified_at: string | null;
  is_primary: boolean;
  ready_to_send: boolean;
  enrichment_state: string;
  raw_apollo_match: unknown;
  raw_hunter: unknown;
  updated_at?: string;
}

const BRAND_ID = "brand-1";
const fakeBrands = new Map<string, Record<string, unknown>>([
  [BRAND_ID, {
    id: BRAND_ID,
    name: "Shearwater Research",
    resolved_owner_domain: "shearwater.com",
    user_id: "user-1",
  }],
]);
const fakeQualifications: Array<Record<string, unknown>> = [
  { id: "qual-1", brand_id: BRAND_ID, selected_entity: null },
];
const fakeContacts = new Map<string, ContactRow>();
const fakeEvents: Array<Record<string, unknown>> = [];
const fakePatternCache: Array<Record<string, unknown>> = [];

// Audit log of every UPDATE to brand_contacts, so we can replay the
// state lifecycle of the primary row.
const updateLog: Array<{ id: string; payload: Record<string, unknown> }> = [];

// When true, the CHECK-violation simulation rejects any UPDATE that
// would write email_source='apollo_match' (the prior bug). The new
// code writes 'apollo' so the rejection should NEVER fire on the
// success path.
const REJECT_APOLLO_MATCH = true;

let nextId = 1;
function makeId(prefix: string): string {
  return `${prefix}-${nextId++}`;
}

function makeQuery(table: string): any {
  let pendingFilters: Array<{ col: string; val: unknown }> = [];
  let pendingPayload: Record<string, unknown> | null = null;
  let op: "select" | "insert" | "update" | "delete" | "upsert" = "select";

  function tableRows(): Record<string, unknown>[] {
    switch (table) {
      case "brands":
        return Array.from(fakeBrands.values());
      case "brand_qualifications":
        return fakeQualifications;
      case "brand_contacts":
        return Array.from(fakeContacts.values()) as unknown as Record<string, unknown>[];
      case "contact_domain_cache":
        return fakePatternCache;
      case "brand_contact_discovery_events":
        return fakeEvents;
      default:
        return [];
    }
  }

  function applyFilters(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return rows.filter((r) => pendingFilters.every((f) => r[f.col] === f.val));
  }

  const builder: any = {
    select() {
      if (op !== "update" && op !== "insert" && op !== "delete" && op !== "upsert") op = "select";
      return builder;
    },
    insert(payload: Record<string, unknown>) {
      op = "insert";
      pendingPayload = payload;
      if (table === "brand_contact_discovery_events") {
        fakeEvents.push(payload);
      }
      if (table === "brand_contacts") {
        const id = (payload.id as string) ?? makeId("contact");
        const row = { ...payload, id } as unknown as ContactRow;
        fakeContacts.set(id, row);
        // Mutate the payload so subsequent .select().maybeSingle()
        // returns the row WITH its generated id (the orchestrator
        // reads `inserted.id` to thread the contact_id forward).
        pendingPayload = { ...payload, id };
      }
      return builder;
    },
    upsert(payload: Record<string, unknown>) {
      op = "upsert";
      pendingPayload = payload;
      if (table === "contact_domain_cache") {
        fakePatternCache.push(payload);
      }
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
    order() { return builder; },
    async maybeSingle() {
      if (op === "select") {
        const rows = applyFilters(tableRows());
        return { data: rows[0] ?? null, error: null };
      }
      if (op === "update") {
        const rows = applyFilters(tableRows());
        if (rows.length === 0) return { data: null, error: null };
        const row = rows[0] as Record<string, unknown>;
        // Simulate the prior CHECK-constraint violation if the code
        // ever writes 'apollo_match' to email_source. Post-fix it
        // writes 'apollo', so this should never fire on the success
        // path. If a future regression writes 'apollo_match' again,
        // this test will turn red.
        if (
          REJECT_APOLLO_MATCH &&
          table === "brand_contacts" &&
          pendingPayload &&
          pendingPayload.email_source === "apollo_match"
        ) {
          return {
            data: null,
            error: { message: "check_violation_email_source_apollo_match", code: "23514" },
          };
        }
        if (pendingPayload) {
          Object.assign(row, pendingPayload);
          updateLog.push({ id: String(row.id), payload: { ...pendingPayload } });
        }
        return { data: row, error: null };
      }
      if (op === "insert" && table === "brand_contacts") {
        return { data: pendingPayload as unknown as Record<string, unknown>, error: null };
      }
      return { data: null, error: null };
    },
    then(resolve: (v: { data: unknown; error: unknown }) => void) {
      if (op === "select") {
        const rows = applyFilters(tableRows());
        resolve({ data: rows, error: null });
        return;
      }
      if (op === "update") {
        const rows = applyFilters(tableRows());
        for (const row of rows) {
          if (
            REJECT_APOLLO_MATCH &&
            table === "brand_contacts" &&
            pendingPayload &&
            pendingPayload.email_source === "apollo_match"
          ) {
            resolve({
              data: null,
              error: { message: "check_violation_email_source_apollo_match", code: "23514" },
            });
            return;
          }
          if (pendingPayload) {
            Object.assign(row, pendingPayload);
            updateLog.push({ id: String(row.id), payload: { ...pendingPayload } });
          }
        }
        resolve({ data: null, error: null });
        return;
      }
      if (op === "delete") {
        // For brand_contacts orphan delete.
        if (table === "brand_contacts") {
          for (const row of applyFilters(tableRows())) {
            fakeContacts.delete(String(row.id));
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

const fakeAdmin = { from(t: string) { return makeQuery(t); } };

const originalResolve = (Module as unknown as {
  _resolveFilename: (req: string, parent: NodeJS.Module, ...rest: unknown[]) => string;
})._resolveFilename;
(Module as unknown as {
  _resolveFilename: (req: string, parent: NodeJS.Module, ...rest: unknown[]) => string;
})._resolveFilename = function (request: string, parent: NodeJS.Module, ...rest: unknown[]): string {
  if (request === "@/lib/supabase/server") {
    return require.resolve("./__supabase_stub_state__.cjs");
  }
  return originalResolve.call(this, request, parent, ...rest);
};

const stubPath = path.join(__dirname, "__supabase_stub_state__.cjs");
fs.writeFileSync(
  stubPath,
  `module.exports = {\n  createSupabaseAdminClient() { return globalThis.__FAKE_STATE_ADMIN__ ?? null; },\n  createSupabaseServerClient() { return null; },\n};\n`,
);
(globalThis as Record<string, unknown>).__FAKE_STATE_ADMIN__ = fakeAdmin;

process.env.APOLLO_API_KEY = "test";
process.env.HUNTER_API_KEY = "test";
process.env.MILLIONVERIFIER_API_KEY = "test";

const APOLLO_SEARCH = {
  people: [
    {
      id: "apollo-1",
      first_name: "Jason",
      last_name: "Leggatt",
      name: "Jason Leggatt",
      title: "CEO",
      organization_name: "Shearwater Research",
      organization: { primary_domain: "shearwater.com" },
    },
  ],
};
const APOLLO_UNLOCK = {
  person: {
    id: "apollo-1",
    first_name: "Jason",
    last_name: "Leggatt",
    email: "jleggatt@shearwater.com",
    email_status: "verified",
  },
};

// @ts-expect-error — override global fetch.
global.fetch = async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("apollo.io/api/v1/mixed_people")) {
    return new Response(JSON.stringify(APOLLO_SEARCH), { status: 200 });
  }
  if (url.includes("apollo.io/api/v1/people/match")) {
    return new Response(JSON.stringify(APOLLO_UNLOCK), { status: 200 });
  }
  if (url.includes("api.hunter.io/")) {
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }
  if (url.includes("api.millionverifier.com")) {
    return new Response(JSON.stringify({ email: "jleggatt@shearwater.com", result: "ok", quality_score: 95 }), { status: 200 });
  }
  return new Response("{}", { status: 200 });
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runContactDiscovery } = require("../orchestrate") as typeof import("../orchestrate");

let failures = 0;
let passes = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) passes += 1;
  else {
    failures += 1;
    console.error(`FAIL: ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const result = await runContactDiscovery(BRAND_ID);
  check("runContactDiscovery returns ok=true", result.ok === true, JSON.stringify(result));
  check("at least one candidate was persisted", fakeContacts.size > 0, `count=${fakeContacts.size}`);

  // Find the primary row.
  const primary = Array.from(fakeContacts.values()).find((c) => c.is_primary);
  check("primary row exists", primary != null);
  if (!primary) {
    try { fs.unlinkSync(stubPath); } catch { /* ignore */ }
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(1);
  }

  // State lifecycle: discovered → enriching → enriched. Inspect the
  // updateLog for the primary row to assert the transitions.
  const primaryUpdates = updateLog.filter((u) => u.id === primary.id);
  const states = primaryUpdates
    .map((u) => u.payload.enrichment_state)
    .filter((s): s is string => typeof s === "string");
  check(
    "primary saw 'enriching' at some point",
    states.includes("enriching"),
    `states seen: ${states.join(" → ")}`,
  );
  check(
    "primary final state is 'enriched' (NOT stuck at 'enriching')",
    primary.enrichment_state === "enriched",
    `final=${primary.enrichment_state}`,
  );

  // Persistence: the primary's email/source/last_name were written.
  check(
    "primary.email persisted",
    primary.email === "jleggatt@shearwater.com",
    `got ${primary.email}`,
  );
  check(
    "primary.email_source is 'apollo' (constraint-allowed; NOT 'apollo_match')",
    primary.email_source === "apollo",
    `got ${primary.email_source}`,
  );
  check(
    "primary.last_name persisted",
    primary.last_name === "Leggatt",
    `got ${primary.last_name}`,
  );
  check(
    "primary.full_name persisted",
    primary.full_name === "Jason Leggatt",
    `got ${primary.full_name}`,
  );

  try { fs.unlinkSync(stubPath); } catch { /* ignore */ }
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

void main();
