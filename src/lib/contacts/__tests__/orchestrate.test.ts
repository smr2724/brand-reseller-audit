/**
 * Phase 63 — Orchestrator regression test: only the #1-ranked candidate
 * goes through the Apollo unlock + Hunter finder + MillionVerifier
 * chain. The other 4 must NOT have any per-contact provider calls; they
 * get a single 'enrichment_deferred' audit event instead.
 *
 * Run directly with tsx:
 *
 *   npx tsx src/lib/contacts/__tests__/orchestrate.test.ts
 *
 * Mocks Supabase admin client (via module-replacement) and global fetch
 * (counts how many per-contact provider calls happen).
 */

// --- Stub `@/lib/supabase/server` BEFORE importing the orchestrator.
import Module from "module";

interface FakeRow {
  table: string;
  data: Record<string, unknown>;
}

const fakeDb = {
  inserted: [] as FakeRow[],
  updated: [] as FakeRow[],
  deleted: [] as FakeRow[],
  events: [] as Record<string, unknown>[],
  contacts: new Map<string, Record<string, unknown>>(),
  brands: new Map<string, Record<string, unknown>>(),
  qualifications: [] as Record<string, unknown>[],
  patternCache: [] as Record<string, unknown>[],
};

let nextId = 1;
function makeId(): string {
  return `fake-id-${nextId++}`;
}

// Seed brand + qualification.
const BRAND_ID = "brand-1";
fakeDb.brands.set(BRAND_ID, {
  id: BRAND_ID,
  name: "Shearwater Research",
  resolved_owner_domain: "shearwater.com",
  user_id: "user-1",
  contacts_state: null,
});
fakeDb.qualifications.push({
  id: "qual-1",
  brand_id: BRAND_ID,
  selected_entity: { evidence_url: "https://shearwater.com/about" },
});

function makeQuery(table: string): any {
  let pendingFilters: Array<{ col: string; val: unknown }> = [];
  let pendingPayload: Record<string, unknown> | null = null;
  let op: "select" | "insert" | "update" | "delete" = "select";

  function applyFilters(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return rows.filter((r) =>
      pendingFilters.every((f) => r[f.col] === f.val),
    );
  }

  function getTableRows(): Record<string, unknown>[] {
    switch (table) {
      case "brands":
        return Array.from(fakeDb.brands.values());
      case "brand_qualifications":
        return fakeDb.qualifications;
      case "brand_contacts":
        return Array.from(fakeDb.contacts.values());
      case "contact_domain_cache":
        return fakeDb.patternCache;
      case "brand_contact_discovery_events":
        return fakeDb.events;
      default:
        return [];
    }
  }

  const builder: any = {
    select(_cols?: string) {
      op = "select";
      return builder;
    },
    upsert(payload: Record<string, unknown> | Record<string, unknown>[]) {
      // Treat upsert as insert for the test (we don't need real merge
      // semantics — pattern cache is read once and irrelevant after).
      return builder.insert(payload);
    },
    insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
      op = "insert";
      const rows = Array.isArray(payload) ? payload : [payload];
      for (const r of rows) {
        const row: Record<string, unknown> = { ...r };
        if (!row.id) row.id = makeId();
        if (table === "brand_contacts") {
          fakeDb.contacts.set(row.id as string, row);
        } else if (table === "brand_contact_discovery_events") {
          fakeDb.events.push(row);
        } else if (table === "contact_domain_cache") {
          fakeDb.patternCache.push(row);
        } else if (table === "api_logs") {
          // ignore
        }
        fakeDb.inserted.push({ table, data: row });
        pendingPayload = row;
      }
      return builder;
    },
    update(payload: Record<string, unknown>) {
      op = "update";
      pendingPayload = payload;
      return builder;
    },
    delete() {
      op = "delete";
      return builder;
    },
    eq(col: string, val: unknown) {
      pendingFilters.push({ col, val });
      return builder;
    },
    in(_col: string, _vals: unknown[]) {
      // Simulate in() filter only for delete; tests don't depend on it.
      return builder;
    },
    order(_col: string, _opts?: unknown) {
      return builder;
    },
    async maybeSingle() {
      if (op === "select") {
        const rows = applyFilters(getTableRows());
        return { data: rows[0] ?? null, error: null };
      }
      if (op === "insert") {
        return { data: pendingPayload, error: null };
      }
      if (op === "update") {
        const rows = applyFilters(getTableRows());
        const row = rows[0];
        if (row && pendingPayload) {
          Object.assign(row, pendingPayload);
          fakeDb.updated.push({ table, data: { id: row.id, ...pendingPayload } });
        }
        return { data: row ?? null, error: null };
      }
      return { data: null, error: null };
    },
    // Implement thenable so awaiting the builder (without .maybeSingle())
    // for inserts/updates/deletes works.
    then(resolve: (v: { data: unknown; error: null }) => void) {
      if (op === "select") {
        const rows = applyFilters(getTableRows());
        resolve({ data: rows, error: null });
        return;
      }
      if (op === "update") {
        const rows = applyFilters(getTableRows());
        for (const row of rows) {
          if (pendingPayload) Object.assign(row, pendingPayload);
          fakeDb.updated.push({ table, data: { id: row.id, ...(pendingPayload ?? {}) } });
        }
        resolve({ data: null, error: null });
        return;
      }
      if (op === "delete") {
        // No-op; just record.
        fakeDb.deleted.push({ table, data: {} });
        resolve({ data: null, error: null });
        return;
      }
      if (op === "insert") {
        resolve({ data: pendingPayload, error: null });
        return;
      }
      resolve({ data: null, error: null });
    },
  };
  return builder;
}

const fakeAdminClient = {
  from(table: string) {
    return makeQuery(table);
  },
};

// Hook into `require` so `@/lib/supabase/server` is replaced with our
// in-memory stub before the orchestrator (which transitively imports it)
// gets loaded.
const originalResolve = (Module as unknown as { _resolveFilename: (req: string, parent: NodeJS.Module, ...rest: unknown[]) => string })._resolveFilename;
(Module as unknown as { _resolveFilename: (req: string, parent: NodeJS.Module, ...rest: unknown[]) => string })._resolveFilename = function (
  request: string,
  parent: NodeJS.Module,
  ...rest: unknown[]
): string {
  if (request === "@/lib/supabase/server") {
    return require.resolve("./__supabase_stub__.cjs");
  }
  return originalResolve.call(this, request, parent, ...rest);
};

// Write a sibling stub module that returns our fake admin client.
import * as fs from "fs";
import * as path from "path";
const stubPath = path.join(__dirname, "__supabase_stub__.cjs");
fs.writeFileSync(
  stubPath,
  `module.exports = {\n  createSupabaseAdminClient() { return globalThis.__FAKE_SUPABASE__ ?? null; },\n  createSupabaseServerClient() { return null; },\n};\n`,
);
(globalThis as Record<string, unknown>).__FAKE_SUPABASE__ = fakeAdminClient;

// --- now we can import the orchestrator.
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

// --- Mock the upstream HTTP providers used in the orchestrator.
process.env.APOLLO_API_KEY = "test";
process.env.HUNTER_API_KEY = "test";
process.env.MILLIONVERIFIER_API_KEY = "test";

interface CallLog {
  url: string;
  body: string;
}
const fetchCalls: CallLog[] = [];

// Apollo search response — 5 candidates with seniority spread so ranker
// puts a CEO at the top.
const apolloSearchResp = {
  people: [
    {
      id: "p1",
      first_name: "Jason",
      last_name: "Black",
      name: "Jason Black",
      title: "Founder & CEO",
      organization: { name: "Shearwater", primary_domain: "shearwater.com" },
    },
    { id: "p2", first_name: "Isaac", last_name: "Bench", name: "Isaac Bench", title: "VP Sales" },
    { id: "p3", first_name: "Anna", last_name: "Lee", name: "Anna Lee", title: "Director of Ops" },
    { id: "p4", first_name: "Mike", last_name: "Ross", name: "Mike Ross", title: "Head of Sales" },
    { id: "p5", first_name: "Sara", last_name: "Vega", name: "Sara Vega", title: "Marketing Lead" },
  ],
  pagination: { total_entries: 5 },
};

const apolloUnlockResp = {
  person: {
    id: "p1",
    first_name: "Jason",
    last_name: "Black",
    email: "jason@shearwater.com",
    email_status: "verified",
  },
};

// Hunter domain-search response.
const hunterDomainResp = {
  data: {
    pattern: "{f}{last}",
    confidence_score: 98,
    organization: "Shearwater",
    accept_all: false,
    webmail: false,
  },
};

// MillionVerifier response.
const mvResp = {
  email: "jason@shearwater.com",
  result: "ok",
  resultcode: 1,
  quality: "good",
};

// @ts-expect-error — override global fetch.
global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = String(init?.body ?? "");
  fetchCalls.push({ url, body });
  if (url.includes("apollo.io/api/v1/mixed_people/api_search")) {
    return new Response(JSON.stringify(apolloSearchResp), { status: 200 });
  }
  if (url.includes("apollo.io/api/v1/people/match")) {
    return new Response(JSON.stringify(apolloUnlockResp), { status: 200 });
  }
  if (url.includes("api.hunter.io/v2/domain-search")) {
    return new Response(JSON.stringify(hunterDomainResp), { status: 200 });
  }
  if (url.includes("api.hunter.io/v2/email-finder")) {
    return new Response(
      JSON.stringify({ data: { email: null, score: null } }),
      { status: 200 },
    );
  }
  if (url.includes("api.millionverifier.com")) {
    return new Response(JSON.stringify(mvResp), { status: 200 });
  }
  if (url.includes("api.zerobounce.net")) {
    return new Response(
      JSON.stringify({ status: "unknown" }),
      { status: 200 },
    );
  }
  return new Response("{}", { status: 200 });
};

async function main(): Promise<void> {
  const result = await runContactDiscovery(BRAND_ID);
  check(
    "orchestrator returns ok",
    result.ok === true,
    result.error,
  );
  check(
    "orchestrator created 5 contacts",
    fakeDb.contacts.size === 5,
    `count=${fakeDb.contacts.size}`,
  );

  // Count Apollo /people/match calls — should be exactly 1 (for primary).
  const matchCalls = fetchCalls.filter((c) =>
    c.url.includes("apollo.io/api/v1/people/match"),
  );
  check(
    "exactly 1 Apollo /people/match call (primary only)",
    matchCalls.length === 1,
    `got ${matchCalls.length}`,
  );
  check(
    "Apollo match call has reveal_personal_emails=true (unlock)",
    matchCalls[0]?.body.includes("reveal_personal_emails=true") ?? false,
    matchCalls[0]?.body,
  );

  // Hunter email-finder should NOT have been called for any candidate
  // since Apollo unlock returned an email.
  const finderCalls = fetchCalls.filter((c) =>
    c.url.includes("api.hunter.io/v2/email-finder"),
  );
  check(
    "no Hunter email-finder calls when Apollo unlock returned email",
    finderCalls.length === 0,
    `got ${finderCalls.length}`,
  );

  // MillionVerifier should fire exactly once (primary only).
  const mvCalls = fetchCalls.filter((c) =>
    c.url.includes("api.millionverifier.com"),
  );
  check(
    "exactly 1 MillionVerifier call (primary only)",
    mvCalls.length === 1,
    `got ${mvCalls.length}`,
  );

  // The 4 non-primary contacts each get exactly one 'enrichment_deferred'
  // event.
  const deferredEvents = fakeDb.events.filter(
    (e) => (e as Record<string, unknown>).provider === "enrichment_deferred",
  );
  check(
    "4 enrichment_deferred events for non-primary contacts",
    deferredEvents.length === 4,
    `got ${deferredEvents.length}`,
  );

  // The primary contact must be 'enriched' state, others 'discovered'.
  const enrichedRows = Array.from(fakeDb.contacts.values()).filter(
    (r) => r.enrichment_state === "enriched",
  );
  const discoveredRows = Array.from(fakeDb.contacts.values()).filter(
    (r) => r.enrichment_state === "discovered",
  );
  check(
    "exactly 1 contact in enriched state (the primary)",
    enrichedRows.length === 1,
    `got ${enrichedRows.length}`,
  );
  check(
    "4 contacts remain in discovered state",
    discoveredRows.length === 4,
    `got ${discoveredRows.length}`,
  );

  // The primary contact should be Jason (the #1 ranked Founder & CEO).
  const primary = enrichedRows[0];
  check(
    "primary is the founder/CEO (Jason)",
    primary?.full_name === "Jason Black" && primary?.is_primary === true,
    String(primary?.full_name),
  );

  // Cleanup: remove the temporary supabase stub file.
  try {
    fs.unlinkSync(stubPath);
  } catch { /* ignore */ }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

void main();
