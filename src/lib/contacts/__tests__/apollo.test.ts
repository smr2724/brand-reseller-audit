/**
 * Phase 62 → Phase 63 — Regression tests for the Apollo contact-discovery
 * wrappers.
 *
 * Run directly with tsx:
 *
 *   npx tsx src/lib/contacts/__tests__/apollo.test.ts
 *
 * This pins down the Phase 61 Shearwater audit guarantee that survived
 * the Phase 63 cleanup (the now-removed apolloMatchPerson):
 *
 *   Bug B — `apolloSearchPeople` must surface `first_name`, `last_name`,
 *           AND `name` on every slim person record so the orchestrator
 *           can persist a real `full_name` (not just `"Jason"`) and feed
 *           Hunter email-finder with first+last.
 *
 * The Phase 62 Bug C — reveal_personal_emails=true on /people/match — is
 * now covered by apollo-unlock.test.ts (apolloUnlockPerson is the only
 * caller of /people/match in production after Phase 63).
 */
import { apolloSearchPeople } from "../apollo";

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

// Inject a fake API key so the wrappers don't short-circuit.
process.env.APOLLO_API_KEY = "test-key";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function mockFetch(captured: CapturedRequest[], responseBody: unknown): void {
  // @ts-expect-error — overriding global fetch for the test scope.
  global.fetch = async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = init.headers as Record<string, string> | undefined;
    if (h) for (const k of Object.keys(h)) headers[k] = h[k];
    captured.push({
      url: String(url),
      method: String(init.method ?? "GET"),
      headers,
      body: String(init.body ?? ""),
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

async function runBugBTest(): Promise<void> {
  // Fixture mirrors the shape of a real Apollo /mixed_people/api_search
  // response. Includes the three identity fields we need to preserve.
  const fixture = {
    people: [
      {
        id: "apollo-person-1",
        first_name: "Jason",
        last_name: "Black",
        name: "Jason Black",
        title: "Founder",
        seniority: "founder",
        linkedin_url: "https://linkedin.com/in/jasonblack",
        organization: {
          id: "org-1",
          name: "Shearwater Research",
          primary_domain: "shearwater.com",
        },
      },
      {
        id: "apollo-person-2",
        // simulate name-only (no first/last) edge case so the
        // orchestrator's downstream split-on-whitespace path is covered.
        name: "Isaac Bench",
        title: "CEO",
        organization: { name: "Shearwater Research" },
      },
    ],
    pagination: { total_entries: 2 },
  };
  const captured: CapturedRequest[] = [];
  mockFetch(captured, fixture);
  const res = await apolloSearchPeople({
    organization_domain: "shearwater.com",
    titles: ["founder", "ceo"],
  });
  check("apolloSearchPeople ok", res.ok === true);
  if (!res.ok) return;
  check(
    "apolloSearchPeople: returns 2 people",
    res.people.length === 2,
    `got ${res.people.length}`,
  );
  const p1 = res.people[0];
  check(
    "slim preserves first_name",
    p1.first_name === "Jason",
    `got ${p1.first_name}`,
  );
  check(
    "slim preserves last_name",
    p1.last_name === "Black",
    `got ${p1.last_name}`,
  );
  check(
    "slim preserves name",
    p1.name === "Jason Black",
    `got ${p1.name}`,
  );
  check(
    "slim preserves title",
    p1.title === "Founder",
    `got ${p1.title}`,
  );
  check(
    "slim preserves organization_name",
    p1.organization_name === "Shearwater Research",
  );
  check(
    "slim preserves organization_domain",
    p1.organization_domain === "shearwater.com",
  );
  // Name-only person: slim should pass `name` through so the orchestrator
  // can split it.
  const p2 = res.people[1];
  check(
    "slim preserves name on name-only person",
    p2.name === "Isaac Bench",
  );
}

// Smoke-test the orchestrator's name-derivation logic by re-implementing
// the same precedence here. If the orchestrator changes, this test
// should change deliberately.
function deriveName(p: {
  first_name?: string;
  last_name?: string;
  name?: string;
}): { first: string; last: string; full_name: string } {
  let first = (p.first_name ?? "").trim();
  let last = (p.last_name ?? "").trim();
  const combined = (p.name ?? "").trim();
  if ((!first || !last) && combined) {
    const parts = combined.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      if (!first) first = parts[0];
      if (!last) last = parts[parts.length - 1];
    } else if (parts.length === 1 && !first) {
      first = parts[0];
    }
  }
  const fullName = combined || `${first} ${last}`.trim() || "(unknown)";
  return { first, last, full_name: fullName };
}

function runOrchestratorNameDerivationTests(): void {
  const a = deriveName({ first_name: "Jason", last_name: "Black", name: "Jason Black" });
  check(
    "derive: first+last+name → full_name='Jason Black'",
    a.full_name === "Jason Black" && a.first === "Jason" && a.last === "Black",
  );
  const b = deriveName({ first_name: "Jason", last_name: "Black" });
  check(
    "derive: first+last only → full_name='Jason Black'",
    b.full_name === "Jason Black",
  );
  const c = deriveName({ name: "Isaac Bench" });
  check(
    "derive: name only → split into first+last",
    c.first === "Isaac" && c.last === "Bench" && c.full_name === "Isaac Bench",
  );
  const d = deriveName({ first_name: "Jason" });
  check(
    "derive: first only → full_name='Jason'",
    d.full_name === "Jason" && d.last === "",
  );
  const e = deriveName({});
  check(
    "derive: empty → full_name='(unknown)'",
    e.full_name === "(unknown)",
  );
  // The Shearwater regression case: Apollo returned first_name='Jason'
  // and last_name='Black' (also `name: 'Jason Black'`). The DB row must
  // have full_name='Jason Black', not 'Jason'.
  const shearwater = deriveName({
    first_name: "Jason",
    last_name: "Black",
    name: "Jason Black",
  });
  check(
    "shearwater regression: full_name is NOT just first_name",
    shearwater.full_name !== "Jason" && shearwater.full_name === "Jason Black",
  );
}

async function main(): Promise<void> {
  await runBugBTest();
  runOrchestratorNameDerivationTests();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

void main();
