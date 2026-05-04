/**
 * Phase 33 — Brand Owner Resolver unit tests.
 *
 * Run:
 *   npx tsx scripts/test-phase33-owner-resolver.ts
 *
 * Covers:
 *   - USPTO adapter parsing, LIVE/DEAD filter, 404 + network error,
 *     rate-limit guard
 *   - Web-search adapter domain extraction, deny-list, dedupe, cap,
 *     graceful degradation when no API key
 *   - Heuristic scoring rules, label thresholds, needs_manual_review,
 *     conflicting-trademark-owner penalty
 *   - Orchestrator: inserts run row, scores+inserts candidates, updates
 *     brand state, soft-fails when adapters throw
 */
import {
  parseUsptoRecord,
  searchUsptoTrademarks,
} from "../src/lib/owner-resolver/uspto";
import {
  registrableDomain,
  isDeniedDomain,
  inferCompanyName,
  buildQueries,
  searchWebForOwners,
} from "../src/lib/owner-resolver/web-search";
import {
  scoreCandidates,
} from "../src/lib/owner-resolver/heuristic-scoring";
import { resolveBrandOwner } from "../src/lib/owner-resolver/resolve";
import type {
  BrandContext,
  RawOwnerCandidate,
} from "../src/lib/owner-resolver/types";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures += 1;
  }
}

async function main() {
  console.log("\n=== USPTO adapter ===");

  // parseUsptoRecord — happy path
  {
    const rec = parseUsptoRecord({
      serial_number: "12345678",
      mark_text: "Terra Pure",
      current_owner_name: "Acme Holdings, LLC",
      current_owner_address: "123 Main St, Atlanta, GA 30301",
      goods_services_text: "soaps, shampoos",
      registration_date: "2020-04-15",
      status: "LIVE/REGISTRATION",
    });
    assert(rec !== null, "parses LIVE record");
    assert(rec?.candidate_company_name === "Acme Holdings, LLC", "owner name");
    assert(rec?.trademark_serial_number === "12345678", "serial captured");
    assert(rec?.trademark_status?.includes("LIVE") ?? false, "status retained");
    assert(rec?.trademark_registration_date === "2020-04-15", "reg date ISO");
  }

  // parseUsptoRecord — DEAD filtered out
  {
    const rec = parseUsptoRecord({
      serial_number: "9",
      mark_text: "Terra Pure",
      current_owner_name: "Old Owner Inc",
      status: "DEAD",
    });
    assert(rec === null, "DEAD record returns null");
  }

  // parseUsptoRecord — no owner name
  {
    const rec = parseUsptoRecord({
      serial_number: "9",
      mark_text: "Terra Pure",
      status: "LIVE",
    });
    assert(rec === null, "missing owner name returns null");
  }

  // searchUsptoTrademarks — 404 returns empty (no throw)
  {
    const fake404 = (() =>
      Promise.resolve({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: () => Promise.resolve({}),
      } as unknown as Response)) as unknown as typeof fetch;
    const r = await searchUsptoTrademarks("Whatever", {
      fetchImpl: fake404,
      skipRateLimit: true,
    });
    assert(r.error === null, "404 yields no error");
    assert(r.candidates.length === 0, "404 yields zero candidates");
  }

  // searchUsptoTrademarks — network error swallowed
  {
    const broken = (() =>
      Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    const r = await searchUsptoTrademarks("X", {
      fetchImpl: broken,
      skipRateLimit: true,
    });
    assert(r.error !== null, "network error captured in result");
    assert(r.candidates.length === 0, "no candidates on failure");
  }

  // searchUsptoTrademarks — happy path with parsed records and ranking
  {
    const payload = {
      results: [
        {
          serial_number: "1",
          mark_text: "Terra Pure",
          current_owner_name: "Exact Owner Co",
          status: "LIVE",
        },
        {
          serial_number: "2",
          mark_text: "Terra Pure Naturals",
          current_owner_name: "Partial Owner Co",
          status: "LIVE",
        },
        {
          serial_number: "3",
          mark_text: "OTHER",
          current_owner_name: "Wrong Owner",
          status: "DEAD",
        },
      ],
    };
    const fakeOk = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(payload),
      } as unknown as Response)) as unknown as typeof fetch;
    const r = await searchUsptoTrademarks("Terra Pure", {
      fetchImpl: fakeOk,
      skipRateLimit: true,
    });
    assert(r.error === null, "happy path no error");
    assert(r.candidates.length === 2, "DEAD filtered out, 2 LIVE returned");
    assert(
      r.candidates[0]?.candidate_company_name === "Exact Owner Co",
      "exact match ranks first",
    );
    assert(r.results_count === 3, "results_count counts raw records");
  }

  // Rate-limit delay actually waits when not skipped
  {
    const calls: number[] = [];
    const fakeOk = ((_url: string) => {
      calls.push(Date.now());
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve({ results: [] }),
      } as unknown as Response);
    }) as unknown as typeof fetch;
    const start = Date.now();
    await searchUsptoTrademarks("X", {
      fetchImpl: fakeOk,
      rateLimitDelayMs: 50,
    });
    const elapsed = Date.now() - start;
    assert(elapsed >= 45, `rate-limit delay applied (~50ms, got ${elapsed}ms)`);
  }

  console.log("\n=== Web-search adapter ===");

  // registrableDomain
  assert(registrableDomain("https://www.acme.com/x") === "acme.com", "strips www. and path");
  assert(registrableDomain("m.acme.com") === "acme.com", "strips m.");
  assert(registrableDomain("https://shop.acme.co.uk/x") === "acme.co.uk", "co.uk treated as 2-part");
  assert(registrableDomain("ACME.COM") === "acme.com", "lowercased");
  assert(registrableDomain("not a url") === null, "rejects non-host");

  // deny list
  assert(isDeniedDomain("amazon.com") === true, "amazon.com denied");
  assert(isDeniedDomain("amazon.de") === true, "amazon.de denied via prefix");
  assert(isDeniedDomain("linkedin.com") === true, "linkedin denied");
  assert(isDeniedDomain("wikipedia.org") === true, "wikipedia denied");
  assert(isDeniedDomain("acme.com") === false, "non-listed allowed");

  // inferCompanyName
  assert(
    inferCompanyName("Acme Inc - The Best Soap", "acme.com") === "Acme Inc",
    "splits at ' - '",
  );
  assert(inferCompanyName(null, "terra-pure.com") === "Terra Pure", "domain fallback");

  // buildQueries
  {
    const q = buildQueries("Terra Pure");
    assert(q.length === 3, "three queries");
    assert(q.every((x) => x.includes("Terra Pure")), "all include brand name");
  }

  // searchWebForOwners — graceful no-key
  {
    const r = await searchWebForOwners("Terra Pure", {
      perplexityApiKey: null,
      braveApiKey: null,
    });
    assert(r.candidates.length === 0, "no candidates without keys");
    assert(r.error !== null, "error message present");
  }

  // searchWebForOwners — happy path with mocked Perplexity
  {
    const payload = {
      results: [
        {
          url: "https://www.acme.com/about",
          title: "Acme Co — Manufacturer",
          snippet: "Acme is the manufacturer of Terra Pure soaps. Wholesale and bulk.",
        },
        {
          url: "https://www.amazon.com/dp/B000",
          title: "Buy Terra Pure",
          snippet: "Buy on Amazon",
        },
        {
          url: "https://www.acme.com/about", // dup of first
          title: "Acme Co",
          snippet: "Same again",
        },
        {
          url: "https://shop.example.com",
          title: "Example Shop",
          snippet: "We carry many brands",
        },
      ],
    };
    const fakeOk = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(payload),
      } as unknown as Response)) as unknown as typeof fetch;
    const r = await searchWebForOwners("Terra Pure", {
      perplexityApiKey: "test-key",
      fetchImpl: fakeOk,
    });
    assert(r.error === null, "no error");
    const domains = r.candidates.map((c) => c.candidate_domain);
    assert(domains.includes("acme.com"), "acme.com surfaced");
    assert(!domains.includes("amazon.com"), "amazon.com filtered by deny list");
    assert(
      domains.filter((d) => d === "acme.com").length === 1,
      "duplicates removed",
    );
  }

  // searchWebForOwners — cap at maxTotal
  {
    const items: Array<{ url: string; title: string; snippet: string }> = [];
    for (let i = 0; i < 100; i += 1) {
      items.push({
        url: `https://acme${i}.com/`,
        title: `Acme ${i}`,
        snippet: "snippet",
      });
    }
    const fakeOk = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve({ results: items }),
      } as unknown as Response)) as unknown as typeof fetch;
    const r = await searchWebForOwners("X", {
      perplexityApiKey: "k",
      fetchImpl: fakeOk,
      maxTotal: 30,
    });
    assert(r.candidates.length <= 30, `capped at 30 (got ${r.candidates.length})`);
  }

  console.log("\n=== Heuristic scoring ===");

  function brand(): BrandContext {
    return {
      brand_id: "b1",
      brand_name: "Terra Pure",
      category: "Bath, Body & Personal Care",
      product_titles: ["Terra Pure Shampoo", "Terra Pure Conditioner"],
    };
  }

  function makeCandidate(over: Partial<RawOwnerCandidate>): RawOwnerCandidate {
    return {
      candidate_company_name: "Acme Holdings, LLC",
      candidate_domain: "acme.com",
      candidate_source: "web_search",
      evidence_text: null,
      evidence_url: null,
      match_reason: null,
      trademark_serial_number: null,
      trademark_status: null,
      trademark_registration_date: null,
      trademark_owner_address: null,
      goods_services_text: null,
      raw_payload: null,
      ...over,
    };
  }

  // USPTO LIVE +35
  {
    const c = makeCandidate({
      candidate_source: "uspto",
      candidate_domain: null,
      trademark_status: "LIVE/REGISTRATION",
      goods_services_text: "shampoos and personal care",
    });
    const [scored] = scoreCandidates([c], brand());
    assert(scored !== undefined, "scored array nonempty");
    // +35 LIVE +15 category match (-10 no product overlap not triggered since cat match)
    // overall: 35 + 15 = 50, no penalty since category matches
    assert((scored?.heuristic_score ?? 0) >= 35, `LIVE USPTO bumps score (${scored?.heuristic_score})`);
    assert(scored?.heuristic_label === "needs_review" || scored?.heuristic_label === "medium", "label reasonable");
  }

  // Web search +25 with domain, +10 B2B language, +15 category match
  {
    const c = makeCandidate({
      candidate_domain: "acme.com",
      // category is "Bath, Body & Personal Care" — overlap on "body" and "care"
      evidence_text: "Acme manufactures bath and body care at wholesale.",
    });
    const [scored] = scoreCandidates([c], brand());
    // +25 web with domain +15 category +10 b2b lang -10 no product overlap = 40
    assert((scored?.heuristic_score ?? 0) >= 40, `web with B2B language + category scores ≥40 (got ${scored?.heuristic_score})`);
  }

  // Web search without domain → -10
  {
    const c = makeCandidate({ candidate_domain: null });
    const [scored] = scoreCandidates([c], brand());
    assert((scored?.heuristic_score ?? 0) < 0, `no-domain web search penalised (got ${scored?.heuristic_score})`);
    assert(scored?.needs_manual_review === true, "needs_manual_review when score <55");
  }

  // DEAD trademark penalty
  {
    const live = makeCandidate({
      candidate_source: "uspto",
      candidate_company_name: "Live Owner Inc",
      candidate_domain: null,
      trademark_status: "LIVE",
      goods_services_text: "shampoo",
    });
    const dead = makeCandidate({
      candidate_source: "uspto",
      candidate_company_name: "Dead Owner Inc",
      candidate_domain: null,
      trademark_status: "DEAD",
      goods_services_text: "shampoo",
    });
    const scored = scoreCandidates([live, dead], brand());
    const liveScore = scored.find((s) => s.candidate_company_name === "Live Owner Inc")?.heuristic_score ?? 0;
    const deadScore = scored.find((s) => s.candidate_company_name === "Dead Owner Inc")?.heuristic_score ?? 0;
    assert(liveScore > deadScore, `LIVE outranks DEAD (${liveScore} > ${deadScore})`);
  }

  // Law-firm domain penalty
  {
    const c = makeCandidate({
      candidate_company_name: "Gerben Law",
      candidate_domain: "gerbenlaw.com",
      evidence_text: "we file trademarks",
    });
    const [scored] = scoreCandidates([c], brand());
    const generic = scoreCandidates([
      makeCandidate({ candidate_company_name: "Generic Co", candidate_domain: "generic.com", evidence_text: "we file trademarks" }),
    ], brand())[0];
    assert(
      (scored?.heuristic_score ?? 0) < (generic?.heuristic_score ?? 0),
      `law-firm domain penalised (${scored?.heuristic_score} < ${generic?.heuristic_score})`,
    );
  }

  // Conflicting USPTO owners — penalty applied to USPTO records
  {
    const a = makeCandidate({
      candidate_source: "uspto",
      candidate_company_name: "Owner A",
      candidate_domain: null,
      trademark_status: "LIVE",
    });
    const b = makeCandidate({
      candidate_source: "uspto",
      candidate_company_name: "Owner B",
      candidate_domain: null,
      trademark_status: "LIVE",
    });
    const scored = scoreCandidates([a, b], brand());
    const noConflict = scoreCandidates([a], brand())[0];
    const withConflict = scored.find((s) => s.candidate_company_name === "Owner A");
    assert(
      (withConflict?.heuristic_score ?? 0) < (noConflict?.heuristic_score ?? 0),
      `conflicting owners penalised (${withConflict?.heuristic_score} < ${noConflict?.heuristic_score})`,
    );
  }

  // Label thresholds — top-tier candidate hits very_high
  // Recipe: USPTO LIVE (+35) + web-discoverable domain via merge n/a — but
  // this candidate is uspto-source, so the +25 "discoverable web site"
  // bonus does NOT apply. We instead lean on the multi-query overlap
  // (+20), category match (+15), B2B language (+10), product overlap (+10),
  // and address consistency (+5) signals plus an explicit USPTO companion
  // record in the same brand context to prove the path.
  {
    const tier1 = makeCandidate({
      candidate_source: "uspto",
      candidate_company_name: "Terra Pure Holdings LLC", // overlaps product titles
      candidate_domain: "terrapure.com",
      trademark_status: "LIVE",
      trademark_owner_address: "123 Main St, Atlanta, GA 30301",
      goods_services_text: "shampoo bath body care",
      evidence_text: "wholesale manufacturer of Terra Pure shampoo bulk minimum order",
      raw_payload: { queries_for_domain: ["q1", "q2"] },
    });
    const webHit = makeCandidate({
      candidate_company_name: "Other Hit",
      candidate_domain: "other.com",
      candidate_source: "web_search",
      evidence_text: "Atlanta GA based brand owner of Terra Pure",
    });
    const scored = scoreCandidates([tier1, webHit], brand());
    const top = scored.find((s) => s.candidate_company_name === "Terra Pure Holdings LLC");
    // +35 LIVE + 20 multi-query + 15 category + 10 B2B + 10 product + 5 address = 95
    assert(
      (top?.heuristic_score ?? 0) >= 90,
      `top-tier candidate hits very_high (${top?.heuristic_score})`,
    );
    assert(top?.heuristic_label === "very_high", "very_high label");
  }

  console.log("\n=== Orchestrator ===");

  // Mock Supabase admin client
  function makeAdminMock() {
    type Row = Record<string, unknown>;
    const state = {
      brands: new Map<string, Row>([
        ["b1", { id: "b1", name: "Terra Pure", category: "Bath, Body" }],
      ]),
      brand_asins: [
        { brand_id: "b1", title: "Terra Pure Shampoo" },
        { brand_id: "b1", title: "Terra Pure Conditioner" },
      ] as Row[],
      runs: [] as Row[],
      candidates: [] as Row[],
      brandUpdates: [] as Row[],
      runUpdates: [] as Row[],
      candidateInsertCount: 0,
    };
    let runIdCounter = 0;
    const builder = (table: string) => {
      const ctx: { filters: Array<{ col: string; val: unknown }> } = {
        filters: [],
      };
      const exec = {
        eq(col: string, val: unknown) {
          ctx.filters.push({ col, val });
          return exec;
        },
        select(_cols?: string, _opts?: { count?: string }) {
          return exec;
        },
        single: async () => {
          if (table === "owner_resolution_runs") {
            const last = state.runs[state.runs.length - 1];
            return { data: last, error: null };
          }
          return { data: null, error: { message: "no" } };
        },
        maybeSingle: async () => {
          if (table === "brands") {
            const id = ctx.filters.find((f) => f.col === "id")?.val as string;
            const row = state.brands.get(id) ?? null;
            return { data: row, error: null };
          }
          return { data: null, error: null };
        },
        order: () => exec,
        limit: async () => {
          if (table === "brand_asins") {
            return { data: state.brand_asins, error: null };
          }
          return { data: [], error: null };
        },
      };
      return {
        insert: (rows: Row | Row[], opts?: { count?: string }) => {
          if (table === "owner_resolution_runs") {
            runIdCounter += 1;
            const single = Array.isArray(rows) ? rows[0]! : rows;
            const inserted = { ...single, id: `run-${runIdCounter}` };
            state.runs.push(inserted);
            return {
              select: () => ({
                single: async () => ({ data: inserted, error: null }),
              }),
            };
          }
          if (table === "owner_candidates") {
            const arr = Array.isArray(rows) ? rows : [rows];
            for (const r of arr) state.candidates.push(r);
            state.candidateInsertCount += arr.length;
            const result = { error: null, count: arr.length };
            // Support both `await admin.from(...).insert(...)` style.
            return Object.assign(Promise.resolve(result), {
              select: () => ({
                single: async () => ({ data: arr[0], error: null }),
              }),
            }) as any;
          }
          return Promise.resolve({ error: null });
        },
        select: (cols?: string, _opts?: { count?: string }) => {
          if (table === "brands") {
            return exec;
          }
          if (table === "brand_asins") {
            return exec;
          }
          return exec;
        },
        update: (payload: Row) => {
          const wrap = {
            eq: async (col: string, val: unknown) => {
              if (table === "brands") {
                state.brandUpdates.push({ ...payload, _id: val });
              } else if (table === "owner_resolution_runs") {
                state.runUpdates.push({ ...payload, _id: val });
              }
              return { error: null };
            },
          };
          return wrap;
        },
      };
    };

    return {
      state,
      client: {
        from: (table: string) => builder(table),
      } as any,
    };
  }

  // Inserts run row, candidates, and updates brand state on success
  {
    const mock = makeAdminMock();
    const fakeUspto: any = async () => ({
      query: "u",
      candidates: [
        {
          candidate_company_name: "Acme Holdings, LLC",
          candidate_domain: null,
          candidate_source: "uspto",
          evidence_text: "Mark Terra Pure",
          evidence_url: null,
          match_reason: "USPTO LIVE",
          trademark_serial_number: "1",
          trademark_status: "LIVE",
          trademark_registration_date: "2020-04-15",
          trademark_owner_address: "GA",
          goods_services_text: "shampoo",
          raw_payload: {},
        },
      ],
      raw: {},
      error: null,
      results_count: 1,
    });
    const fakeWeb: any = async () => ({
      queries: ["q1", "q2", "q3"],
      candidates: [
        {
          candidate_company_name: "Acme Web Site",
          candidate_domain: "acme.com",
          candidate_source: "web_search",
          evidence_text: "Acme makes Terra Pure",
          evidence_url: "https://acme.com",
          match_reason: "search",
          trademark_serial_number: null,
          trademark_status: null,
          trademark_registration_date: null,
          trademark_owner_address: null,
          goods_services_text: null,
          raw_payload: { queries_for_domain: ["q1"] },
        },
      ],
      raw: {},
      error: null,
      results_count: 1,
    });
    const result = await resolveBrandOwner(mock.client, "b1", {
      triggered_by: "manual",
      usptoFn: fakeUspto,
      webSearchFn: fakeWeb,
      skipCasGuard: true,
    });
    assert(result.ok === true, "ok=true on success");
    assert(result.run_id === "run-1", "run id returned");
    assert(result.candidates_count === 2, `2 candidates inserted (got ${result.candidates_count})`);
    assert(mock.state.runs.length === 1, "one run row inserted");
    assert(mock.state.candidates.length === 2, "two candidates persisted");
    const brandFinal = mock.state.brandUpdates[mock.state.brandUpdates.length - 1];
    assert(
      brandFinal && brandFinal.owner_resolution_state === "candidates_ready",
      "brand state set to candidates_ready",
    );
  }

  // Both adapters fail → run failed
  {
    const mock = makeAdminMock();
    const failUspto: any = async () => ({
      query: "u",
      candidates: [],
      raw: null,
      error: "uspto down",
      results_count: 0,
    });
    const failWeb: any = async () => ({
      queries: [],
      candidates: [],
      raw: null,
      error: "no web key",
      results_count: 0,
    });
    const result = await resolveBrandOwner(mock.client, "b1", {
      triggered_by: "manual",
      usptoFn: failUspto,
      webSearchFn: failWeb,
      skipCasGuard: true,
    });
    assert(result.ok === false, "ok=false when both fail");
    assert(result.state === "failed", "state failed");
    const brandFinal = mock.state.brandUpdates[mock.state.brandUpdates.length - 1];
    assert(
      brandFinal && brandFinal.owner_resolution_state === "failed",
      "brand state set to failed",
    );
  }

  // Adapter throws — orchestrator soft-fails
  {
    const mock = makeAdminMock();
    const throwUspto: any = async () => {
      throw new Error("kaboom");
    };
    const okWeb: any = async () => ({
      queries: ["q1"],
      candidates: [],
      raw: null,
      error: null,
      results_count: 0,
    });
    const result = await resolveBrandOwner(mock.client, "b1", {
      triggered_by: "manual",
      usptoFn: throwUspto,
      webSearchFn: okWeb,
      skipCasGuard: true,
    });
    assert(result.run_id !== null, "run row created even when adapter throws");
    assert(result.state === "candidates_ready" || result.state === "failed", "no exception escaped");
  }

  // Re-run produces a new run row and prior candidates remain in DB
  {
    const mock = makeAdminMock();
    const fakeWeb: any = async () => ({
      queries: ["q"],
      candidates: [
        {
          candidate_company_name: "Acme",
          candidate_domain: "acme.com",
          candidate_source: "web_search",
          evidence_text: null,
          evidence_url: null,
          match_reason: null,
          trademark_serial_number: null,
          trademark_status: null,
          trademark_registration_date: null,
          trademark_owner_address: null,
          goods_services_text: null,
          raw_payload: {},
        },
      ],
      raw: {},
      error: null,
      results_count: 1,
    });
    const fakeUspto: any = async () => ({
      query: "u",
      candidates: [],
      raw: null,
      error: null,
      results_count: 0,
    });
    await resolveBrandOwner(mock.client, "b1", {
      triggered_by: "manual",
      usptoFn: fakeUspto,
      webSearchFn: fakeWeb,
      skipCasGuard: true,
    });
    await resolveBrandOwner(mock.client, "b1", {
      triggered_by: "rerun",
      usptoFn: fakeUspto,
      webSearchFn: fakeWeb,
      skipCasGuard: true,
    });
    assert(mock.state.runs.length === 2, "two run rows after rerun");
    assert(mock.state.candidates.length === 2, "history preserved (2 candidate rows)");
  }

  // ============================================================
  // Phase 33 review-fix coverage (PR #31 follow-ups)
  // ============================================================
  console.log("\n=== Review fixes ===");

  // M3 — null-category brand should NOT be penalized -10 when there's no
  // category to compare against.
  {
    const nullCatBrand: BrandContext = {
      brand_id: "b1",
      brand_name: "X",
      category: null,
      product_titles: [],
    };
    const noMatchCand = makeCandidate({
      candidate_company_name: "Acme",
      candidate_domain: "acme.com",
      // no category, no product overlap -> with null cat the -10 penalty must NOT apply
    });
    const matchedBrand: BrandContext = { ...nullCatBrand, category: "shampoo" };
    const [nullScored] = scoreCandidates([noMatchCand], nullCatBrand);
    const [withCatScored] = scoreCandidates([noMatchCand], matchedBrand);
    assert(
      (nullScored?.heuristic_score ?? 0) > (withCatScored?.heuristic_score ?? 0),
      `null-category brand not penalized -10 (${nullScored?.heuristic_score} > ${withCatScored?.heuristic_score})`,
    );
  }

  // M4 — "PUBLISHED FOR OPPOSITION" must NOT be treated as LIVE.
  {
    const rec = parseUsptoRecord({
      serial_number: "11",
      mark_text: "Brand X",
      current_owner_name: "Brand X Co",
      status: "PUBLISHED FOR OPPOSITION",
    });
    assert(rec === null, "PUBLISHED FOR OPPOSITION rejected (not LIVE)");
  }
  {
    const rec = parseUsptoRecord({
      serial_number: "12",
      mark_text: "Brand Y",
      current_owner_name: "Brand Y Co",
      status: "ALLOWED — INTENT TO USE",
    });
    assert(rec === null, "ALLOWED / INTENT TO USE rejected (not LIVE)");
  }
  {
    const rec = parseUsptoRecord({
      serial_number: "13",
      mark_text: "Brand Z",
      current_owner_name: "Brand Z Co",
      status: "REGISTERED",
    });
    assert(rec !== null, "REGISTERED accepted as LIVE");
  }
  {
    const rec = parseUsptoRecord({
      serial_number: "14",
      mark_text: "Brand W",
      current_owner_name: "Brand W Co",
      status: "Some text",
      status_code: 712,
    });
    assert(rec !== null, "status_code 712 accepted as LIVE");
  }

  // M5 — USPTO record with null/empty mark_text or serial_number rejected.
  {
    const rec = parseUsptoRecord({
      mark_text: null,
      serial_number: "9",
      current_owner_name: "Owner",
      status: "REGISTERED",
    });
    assert(rec === null, "missing mark_text rejected");
  }
  {
    const rec = parseUsptoRecord({
      mark_text: "Some Mark",
      serial_number: "",
      current_owner_name: "Owner",
      status: "REGISTERED",
    });
    assert(rec === null, "empty serial_number rejected");
  }

  // M7 — extended deny list covers Crunchbase, Bloomberg, Google, Yahoo, etc.
  assert(isDeniedDomain("crunchbase.com") === true, "crunchbase denied");
  assert(isDeniedDomain("bloomberg.com") === true, "bloomberg denied");
  assert(isDeniedDomain("dnb.com") === true, "dnb denied");
  assert(isDeniedDomain("zoominfo.com") === true, "zoominfo denied");
  assert(isDeniedDomain("owler.com") === true, "owler denied");
  assert(isDeniedDomain("google.com") === true, "google.com denied");
  assert(isDeniedDomain("google.co.uk") === true, "google.co.uk denied via prefix");
  assert(isDeniedDomain("yahoo.com") === true, "yahoo.com denied");
  assert(isDeniedDomain("yahoo.fr") === true, "yahoo.fr denied via prefix");
  assert(isDeniedDomain("glassdoor.com") === true, "glassdoor denied");
  assert(isDeniedDomain("indeed.com") === true, "indeed denied");
  assert(isDeniedDomain("pinterest.de") === true, "pinterest.de denied via prefix");
  assert(isDeniedDomain("linkedin.de") === true, "linkedin.de denied via prefix");

  // M8 — state extractor only matches real US states + DC.
  {
    const { extractStateFromAddress } = require(
      "../src/lib/owner-resolver/heuristic-scoring",
    ) as typeof import("../src/lib/owner-resolver/heuristic-scoring");
    assert(
      extractStateFromAddress("123 Main St, Atlanta, GA 30301") === "GA",
      "valid GA extracted",
    );
    assert(
      extractStateFromAddress("PO Box 123, 12345") === null,
      "PO Box does NOT match as state code",
    );
    assert(
      extractStateFromAddress("RR 12345") === null,
      "Rural Route token does NOT match as state",
    );
    assert(
      extractStateFromAddress("Washington DC 20500") === "DC",
      "DC counted as state",
    );
    assert(
      extractStateFromAddress("Some Street XX 99999") === null,
      "fake state code XX rejected",
    );
  }

  // B5 — auto-trigger CAS guard: a second concurrent attempt sees state
  // 'running' and bails out without inserting a run row.
  {
    const calls: string[] = [];
    const claimResults = [
      // First call wins the claim
      [{ claimed: true, brand_id: "b1", brand_name: "Terra Pure", category: null }],
      // Second call loses (no rows)
      [{ claimed: false, brand_id: null, brand_name: null, category: null }],
    ];
    const mock = makeAdminMock();
    let claimCallCount = 0;
    (mock.client as any).rpc = async (name: string) => {
      calls.push(name);
      if (name === "claim_owner_resolution_run") {
        const idx = Math.min(claimCallCount, claimResults.length - 1);
        claimCallCount += 1;
        return { data: claimResults[idx], error: null };
      }
      return { data: null, error: null };
    };
    const fakeAdapter: any = async () => ({
      query: "u",
      candidates: [],
      raw: null,
      error: null,
      results_count: 0,
      queries: [],
    });
    const r1 = await resolveBrandOwner(mock.client, "b1", {
      triggered_by: "manual",
      usptoFn: fakeAdapter,
      webSearchFn: fakeAdapter,
    });
    const r2 = await resolveBrandOwner(mock.client, "b1", {
      triggered_by: "manual",
      usptoFn: fakeAdapter,
      webSearchFn: fakeAdapter,
    });
    assert(r1.run_id !== null, "first runner claims and inserts run row");
    assert(r2.run_id === null, "second runner is skipped (CAS lost)");
    assert(r2.state === "skipped", "second runner state=skipped");
    assert(mock.state.runs.length === 1, "exactly 1 run row across both attempts");
  }

  // B7 — bulk-insert PG error must surface to brand state and re-throw.
  {
    const mock = makeAdminMock();
    // Inject an insert error for owner_candidates.
    const origFrom = mock.client.from;
    mock.client.from = (table: string) => {
      const b = origFrom(table);
      if (table === "owner_candidates") {
        return {
          ...b,
          insert: (rows: any) => {
            const arr = Array.isArray(rows) ? rows : [rows];
            return Object.assign(
              Promise.resolve({
                error: { message: "duplicate key" },
                count: 0,
              }),
              {
                select: () => ({
                  single: async () => ({
                    data: null,
                    error: { message: "duplicate key" },
                  }),
                }),
              },
            );
          },
        };
      }
      return b;
    };
    const fakeUspto: any = async () => ({
      query: "u",
      candidates: [
        {
          candidate_company_name: "Acme",
          candidate_domain: null,
          candidate_source: "uspto",
          evidence_text: null,
          evidence_url: null,
          match_reason: null,
          trademark_serial_number: "1",
          trademark_status: "LIVE",
          trademark_registration_date: null,
          trademark_owner_address: null,
          goods_services_text: null,
          raw_payload: {},
        },
      ],
      raw: null,
      error: null,
      results_count: 1,
    });
    const fakeWeb: any = async () => ({
      queries: [],
      candidates: [],
      raw: null,
      error: null,
      results_count: 0,
    });
    let threw = false;
    try {
      await resolveBrandOwner(mock.client, "b1", {
        triggered_by: "manual",
        usptoFn: fakeUspto,
        webSearchFn: fakeWeb,
        skipCasGuard: true,
      });
    } catch {
      threw = true;
    }
    assert(threw === true, "persist error rethrown to caller");
    const brandFinal = mock.state.brandUpdates[mock.state.brandUpdates.length - 1];
    assert(
      brandFinal && brandFinal.owner_resolution_state === "failed",
      "brand state set to failed on persist error",
    );
  }

  // B8 — rate-limit module enforces concurrency.
  {
    const { rateLimit, __resetRateLimitBuckets } = require(
      "../src/lib/owner-resolver/rate-limit",
    ) as typeof import("../src/lib/owner-resolver/rate-limit");
    __resetRateLimitBuckets();
    let active = 0;
    let maxActive = 0;
    const work = async () => {
      active += 1;
      if (active > maxActive) maxActive = active;
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
    };
    await Promise.all([
      rateLimit({ key: "test", maxConcurrent: 2, minIntervalMs: 0 }, work),
      rateLimit({ key: "test", maxConcurrent: 2, minIntervalMs: 0 }, work),
      rateLimit({ key: "test", maxConcurrent: 2, minIntervalMs: 0 }, work),
      rateLimit({ key: "test", maxConcurrent: 2, minIntervalMs: 0 }, work),
    ]);
    assert(maxActive <= 2, `max concurrency respected (got ${maxActive})`);
    __resetRateLimitBuckets();
  }

  console.log("\n--------");
  if (failures > 0) {
    console.error(`FAILED — ${failures} assertion(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 33 owner-resolver tests passed.");
  }
}

main().catch((e) => {
  console.error("Test harness threw:", e);
  process.exitCode = 1;
});
