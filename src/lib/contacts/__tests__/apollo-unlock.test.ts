/**
 * Phase 63 — Regression test for the Apollo unlock variant.
 *
 * Run directly with tsx:
 *
 *   npx tsx src/lib/contacts/__tests__/apollo-unlock.test.ts
 *
 * Asserts that:
 *   - Content-Type is application/x-www-form-urlencoded
 *   - body includes reveal_personal_emails=true
 *   - body includes reveal_phone_number=false (we don't want to burn phone credits)
 *   - body includes the rest of the unlock fields (domain, first_name, organization_name, id)
 *   - the email_status returned by Apollo is surfaced as email_status_raw on the slim person
 */
import { apolloUnlockPerson } from "../apollo";

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

async function main(): Promise<void> {
  const fixture = {
    person: {
      id: "match-1",
      first_name: "Jason",
      last_name: "Black",
      email: "jason@shearwater.com",
      email_status: "verified",
    },
  };
  const captured: CapturedRequest[] = [];
  mockFetch(captured, fixture);

  const res = await apolloUnlockPerson({
    domain: "shearwater.com",
    first_name: "Jason",
    organization_name: "Shearwater Research",
    id: "apollo-person-1",
  });
  check("apolloUnlockPerson ok", res.ok === true);
  check(
    "apolloUnlockPerson: one fetch call",
    captured.length === 1,
    `got ${captured.length}`,
  );
  if (captured.length === 0) {
    console.log(`\n${passes} passed, ${failures} failed`);
    if (failures > 0) process.exit(1);
    return;
  }
  const req = captured[0];
  check(
    "apolloUnlockPerson: hits /people/match",
    req.url.endsWith("/people/match"),
    req.url,
  );
  check(
    "apolloUnlockPerson: Content-Type is application/x-www-form-urlencoded",
    req.headers["Content-Type"] === "application/x-www-form-urlencoded",
    req.headers["Content-Type"],
  );
  check(
    "apolloUnlockPerson: body includes reveal_personal_emails=true",
    req.body.includes("reveal_personal_emails=true"),
    req.body,
  );
  check(
    "apolloUnlockPerson: body includes reveal_phone_number=false",
    req.body.includes("reveal_phone_number=false"),
    req.body,
  );
  check(
    "apolloUnlockPerson: body includes domain=shearwater.com",
    req.body.includes("domain=shearwater.com"),
    req.body,
  );
  check(
    "apolloUnlockPerson: body includes first_name=Jason",
    req.body.includes("first_name=Jason"),
    req.body,
  );
  check(
    "apolloUnlockPerson: body includes organization_name=Shearwater%20Research",
    req.body.includes("organization_name=Shearwater%20Research") ||
      req.body.includes("organization_name=Shearwater+Research"),
    req.body,
  );
  check(
    "apolloUnlockPerson: body includes id=apollo-person-1",
    req.body.includes("id=apollo-person-1"),
    req.body,
  );
  if (res.ok && res.person) {
    check(
      "apolloUnlockPerson: surfaces email",
      res.person.email === "jason@shearwater.com",
      String(res.person.email),
    );
    check(
      "apolloUnlockPerson: surfaces last_name",
      res.person.last_name === "Black",
      String(res.person.last_name),
    );
    check(
      "apolloUnlockPerson: surfaces email_status_raw",
      res.person.email_status_raw === "verified",
      String(res.person.email_status_raw),
    );
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

void main();
