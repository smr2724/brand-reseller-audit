/**
 * Phase 69 — Apollo mixed_people/search wrapper tests.
 *
 * Run directly:
 *   npx tsx src/lib/contacts/__tests__/apollo-mixed-search.test.ts
 *
 * Pins the locked Apollo convention:
 *   - Content-Type: application/x-www-form-urlencoded
 *   - X-Api-Key header
 *   - array params as repeated `key[]=value`
 */
import {
  apolloMixedPeopleSearch,
  buildApolloMixedSearchBody,
  parseApolloMixedSearchResponse,
} from "../apollo-mixed-search";

process.env.APOLLO_API_KEY = "test-key";

let failures = 0;
let passes = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passes += 1;
  } else {
    failures += 1;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 1. body encoding
const body = buildApolloMixedSearchBody({
  person_titles: ["Director of Amazon", "VP E-commerce"],
  person_seniorities: ["director", "vp"],
  q_organization_domains: ["acme.com"],
  per_page: 25,
});
const bodyStr = body.toString();
check(
  "person_titles[] repeated for each title",
  (bodyStr.match(/person_titles%5B%5D=/g) ?? []).length === 2,
  bodyStr,
);
check(
  "person_seniorities[] repeated",
  (bodyStr.match(/person_seniorities%5B%5D=/g) ?? []).length === 2,
);
check(
  "q_organization_domains[] present",
  bodyStr.includes("q_organization_domains%5B%5D=acme.com"),
);
check("per_page set", bodyStr.includes("per_page=25"));

// 2. response parsing
const parsed = parseApolloMixedSearchResponse({
  people: [
    {
      id: "p1",
      first_name: "Jane",
      last_name: "Doe",
      title: "Director of Amazon",
      seniority: "director",
      organization: { id: "o1", name: "Acme", primary_domain: "acme.com" },
    },
  ],
  pagination: { page: 1, per_page: 25, total_pages: 1, total_entries: 1 },
});
check("parsed candidate count", parsed.candidates.length === 1);
check("parsed organization_domain", parsed.candidates[0].organization_domain === "acme.com");

// 3. fetch wrapper sends correct headers + form body
let capturedHeaders: Record<string, string> = {};
let capturedBody = "";
const fakeFetch: typeof fetch = (async (
  _url: string | URL | Request,
  init?: RequestInit,
) => {
  capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
  capturedBody =
    init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
  return new Response(
    JSON.stringify({
      people: [{ id: "x", first_name: "X", last_name: "Y", title: "VP Amazon" }],
      pagination: { page: 1, per_page: 25, total_pages: 1, total_entries: 1 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}) as unknown as typeof fetch;

(async () => {
  const r = await apolloMixedPeopleSearch(
    {
      person_titles: ["VP Amazon"],
      q_organization_domains: ["acme.com"],
    },
    { fetchImpl: fakeFetch },
  );
  check(
    "Content-Type form-urlencoded",
    capturedHeaders["Content-Type"] === "application/x-www-form-urlencoded",
    JSON.stringify(capturedHeaders),
  );
  check(
    "X-Api-Key header set",
    capturedHeaders["X-Api-Key"] === "test-key",
    JSON.stringify(capturedHeaders),
  );
  check(
    "request body has person_titles[]=VP+Amazon",
    /person_titles%5B%5D=VP\+Amazon|person_titles%5B%5D=VP%20Amazon/.test(capturedBody),
    capturedBody,
  );
  check("response parsed", r.ok && r.candidates.length === 1);
  console.log(`\napollo-mixed-search.test.ts: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
})().catch((e) => {
  console.error("test threw", e);
  process.exit(1);
});
