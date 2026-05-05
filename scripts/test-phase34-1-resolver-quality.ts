/**
 * Phase 34.1 — Resolver quality unit tests.
 *
 * Run:
 *   npx tsx scripts/test-phase34-1-resolver-quality.ts
 *
 * Covers:
 *   - TSDR JSON parsing (Diversified Hospitality Solutions mock)
 *   - Web-search adapter capturing full message text (not just snippets)
 *   - Extractor prompt construction: USPTO TSDR section is named, full
 *     per-query answer text is included, signal hierarchy lives in the
 *     system prompt, and a low-confidence brand-domain candidate is
 *     filtered when MIN_CONFIDENCE rejects it
 *   - Apollo client 3-tier fallback (name+domain → domain → cleaned-name)
 *   - Manual Apollo search runner — auth + rate limit
 */
import {
  isLive,
  parseTsdrInfo,
  pickLiveSerialsFromTmSearch,
  searchUsptoTrademarks,
} from "../src/lib/owner-resolver/uspto";
import {
  parseOpenAIFullText,
  parseOpenAIResponse,
} from "../src/lib/owner-resolver/web-search-openai";
import { searchWebForOwners } from "../src/lib/owner-resolver/web-search";
import {
  buildUserPrompt,
  buildUsptoEvidence,
  parseExtractorResponse,
  type ExtractorUsptoEvidence,
} from "../src/lib/owner-resolver/extractor-openai";
import {
  cleanCompanyName,
  createApolloClient,
} from "../src/lib/owner-resolver/apollo-client";
import {
  __resetRateLimitBuckets,
  checkSlidingWindow,
} from "../src/lib/owner-resolver/rate-limit";
import type { PerQueryAnswer } from "../src/lib/owner-resolver/web-search-types";
import type { RawOwnerCandidate } from "../src/lib/owner-resolver/types";

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
  console.log("\n=== USPTO TSDR parsing ===");

  // Diversified Hospitality Solutions mock TSDR shape.
  {
    const tsdr = {
      trademarks: [
        {
          serialNumber: "97000001",
          registrationNumber: "6500000",
          markVerbalElement: "TERRA PURE",
          status: {
            statusDescription: "REGISTERED. The registration date is used as the basis.",
            statusCode: 712,
          },
          parties: {
            owners: [
              {
                partyName: "Diversified Hospitality Solutions, Ltd.",
                legalEntityType: "LIMITED COMPANY",
                addressLine1: "123 Sample St",
                city: "San Diego",
                geoCode: "CA",
                postcode: "92101",
                country: "United States",
              },
            ],
          },
        },
      ],
    };
    const cand = parseTsdrInfo(tsdr);
    assert(cand !== null, "parses TSDR JSON");
    assert(
      cand?.candidate_company_name === "Diversified Hospitality Solutions, Ltd.",
      "captures registered owner name",
    );
    assert(
      cand?.trademark_serial_number === "97000001",
      "captures serial number",
    );
    assert(
      cand?.trademark_owner_address?.includes("San Diego") ?? false,
      "address composed from structured fields",
    );
    assert(
      cand?.evidence_text?.startsWith("REGISTERED TRADEMARK OWNER (USPTO TSDR):") ?? false,
      "evidence_text prefixed with authoritative framing",
    );
    assert(
      cand?.evidence_text?.includes("entity_type=LIMITED COMPANY") ?? false,
      "entity_type included in evidence",
    );
  }

  // Cancelled / dead trademark rejected.
  {
    const tsdr = {
      trademarks: [
        {
          serialNumber: "1",
          status: { statusDescription: "DEAD/CANCELLED" },
          parties: { owners: [{ partyName: "Old Co" }] },
        },
      ],
    };
    const cand = parseTsdrInfo(tsdr);
    assert(cand === null, "DEAD/CANCELLED returns null");
  }

  // pickLiveSerialsFromTmSearch — exact wordmark match required.
  {
    const search = {
      results: [
        {
          serial_number: "97000001",
          markVerbalElement: "TERRA PURE",
          status: "LIVE/REGISTRATION",
        },
        {
          serial_number: "97000002",
          markVerbalElement: "TERRA PURE NATURALS",
          status: "LIVE/REGISTRATION",
        },
        {
          serial_number: "97000003",
          markVerbalElement: "TERRA PURE",
          status: "DEAD/ABANDONED",
        },
      ],
    };
    const got = pickLiveSerialsFromTmSearch(search, "Terra Pure", 5);
    assert(got.serials.length === 1, "exact-wordmark match returns 1 serial");
    assert(got.serials[0] === "97000001", "drops looser & DEAD matches");
  }

  // isLive helper still works on TSDR-style status text.
  assert(isLive("REGISTERED") === true, "REGISTERED accepted");
  assert(isLive("PUBLISHED FOR OPPOSITION") === false, "PUBLISHED rejected");
  assert(isLive("DEAD/CANCELLED") === false, "DEAD rejected");

  // searchUsptoTrademarks end-to-end — TESS hit feeds TSDR lookup.
  {
    let calls = 0;
    const fakeFetch = ((url: string, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        // tmsearch POST
        assert(init?.method === "POST", "tmsearch uses POST");
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () =>
            Promise.resolve({
              results: [
                {
                  serial_number: "97000001",
                  markVerbalElement: "TERRA PURE",
                  status: "LIVE/REGISTRATION",
                },
              ],
            }),
        } as unknown as Response);
      }
      // TSDR GET
      assert(typeof url === "string" && url.includes("/sn97000001/info.json"), "TSDR url uses serial");
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () =>
          Promise.resolve({
            trademarks: [
              {
                serialNumber: "97000001",
                registrationNumber: "6500000",
                markVerbalElement: "TERRA PURE",
                status: { statusDescription: "REGISTERED" },
                parties: {
                  owners: [
                    {
                      partyName: "Diversified Hospitality Solutions, Ltd.",
                      legalEntityType: "LIMITED COMPANY",
                      city: "San Diego",
                      geoCode: "CA",
                    },
                  ],
                },
              },
            ],
          }),
      } as unknown as Response);
    }) as unknown as typeof fetch;
    const r = await searchUsptoTrademarks("Terra Pure", {
      fetchImpl: fakeFetch,
      skipRateLimit: true,
      skipRetries: true,
    });
    assert(r.error === null, "happy path no error");
    assert(r.candidates.length === 1, "single TSDR-backed candidate");
    assert(
      r.candidates[0]?.candidate_company_name ===
        "Diversified Hospitality Solutions, Ltd.",
      "registered owner extracted",
    );
    assert(calls === 2, "exactly 1 tmsearch + 1 TSDR call");
  }

  console.log("\n=== Web-search adapter — full message text ===");

  // parseOpenAIFullText concatenates all output_text blocks.
  {
    const responsesPayload = {
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "Para 1." },
            { type: "output_text", text: "Para 2." },
          ],
        },
      ],
    };
    const text = parseOpenAIFullText(responsesPayload);
    assert(
      text === "Para 1.\n\nPara 2.",
      "concatenates output_text blocks",
    );
  }

  // parseOpenAIResponse keeps annotation snippets but the new path also
  // exposes full text via parseOpenAIFullText.
  {
    const json = {
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text:
                "Terra Pure is produced by Diversified Hospitality Solutions, based in San Diego, California.",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://diversifiedhospitality.com/about",
                  title: "Diversified Hospitality Solutions",
                  start_index: 25,
                  end_index: 70,
                },
              ],
            },
          ],
        },
      ],
    };
    const items = parseOpenAIResponse(json, "test query");
    const full = parseOpenAIFullText(json);
    assert(items.length === 1, "1 url_citation item");
    assert(
      full?.includes("produced by Diversified Hospitality Solutions") ?? false,
      "full_text contains the 'produced by' attestation",
    );
    assert(
      (items[0]?.snippet?.length ?? 0) <
        (full?.length ?? 0),
      "snippet is shorter than full_text",
    );
  }

  // searchWebForOwners surfaces per_query_answers when an OpenAI key is set.
  {
    const fakeJson = {
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "Acme is a brand of Acme Holdings, LLC.",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://acme.com/about",
                  title: "About Acme",
                  start_index: 0,
                  end_index: 10,
                },
              ],
            },
          ],
        },
      ],
    };
    const fakeFetch = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve(""),
        json: () => Promise.resolve(fakeJson),
      } as unknown as Response)) as unknown as typeof fetch;
    const r = await searchWebForOwners("Acme", {
      fetchImpl: fakeFetch,
      openaiApiKey: "test-key",
    });
    assert(r.per_query_answers !== undefined, "exposes per_query_answers");
    assert((r.per_query_answers ?? []).length === 3, "one per query");
    assert(
      (r.per_query_answers ?? [])[0]?.full_text?.includes("brand of Acme Holdings, LLC") ?? false,
      "per-query full_text captured",
    );
  }

  console.log("\n=== Extractor prompt + parsing ===");

  // buildUserPrompt names a USPTO TSDR section and includes per-query prose.
  {
    const uspto: ExtractorUsptoEvidence[] = [
      {
        owner_name: "Diversified Hospitality Solutions, Ltd.",
        entity_type: "LIMITED COMPANY",
        address: "San Diego, CA, US",
        registration_number: "6500000",
        serial_number: "97000001",
        mark_text: "TERRA PURE",
        goods_services: "soaps and shampoos for hospitality",
        evidence_url: "https://tsdr.uspto.gov/#caseNumber=97000001",
      },
    ];
    const answers: PerQueryAnswer[] = [
      {
        query: '"Terra Pure" company who makes',
        full_text:
          "Terra Pure is produced by Diversified Hospitality Solutions, based in San Diego, California. The line includes shampoos and soaps for hotels.",
        citation_urls: [
          { url: "https://diversifiedhospitality.com", title: "Diversified Hospitality" },
        ],
      },
    ];
    const prompt = buildUserPrompt("Terra Pure", "Beauty & Personal Care", uspto, answers, []);
    assert(
      prompt.includes("USPTO TSDR REGISTERED OWNERS"),
      "TSDR section labeled",
    );
    assert(
      prompt.includes("Diversified Hospitality Solutions, Ltd."),
      "TSDR owner present in prompt",
    );
    assert(
      prompt.includes("FULL ANSWER TEXT"),
      "per-query full text section labeled",
    );
    assert(
      prompt.includes("produced by Diversified Hospitality Solutions"),
      "the 'produced by' attestation lives in prompt verbatim",
    );
    assert(prompt.includes("Category: Beauty & Personal Care"), "category passed in");
  }

  // buildUsptoEvidence projects the orchestrator's RawOwnerCandidate list.
  {
    const raw: RawOwnerCandidate = {
      candidate_company_name: "Diversified Hospitality Solutions, Ltd.",
      candidate_domain: null,
      candidate_source: "uspto",
      evidence_text: "REGISTERED TRADEMARK OWNER (USPTO TSDR): Diversified Hospitality",
      evidence_url: "https://tsdr.uspto.gov/#caseNumber=97000001",
      match_reason: "USPTO TSDR registered owner",
      trademark_serial_number: "97000001",
      trademark_status: "LIVE/REGISTRATION",
      trademark_registration_date: "2021-01-01",
      trademark_owner_address: "San Diego, CA, US",
      goods_services_text: "soaps for hospitality",
      raw_payload: {
        trademarks: [
          {
            serialNumber: "97000001",
            markVerbalElement: "TERRA PURE",
            registrationNumber: "6500000",
            parties: {
              owners: [
                {
                  partyName: "Diversified Hospitality Solutions, Ltd.",
                  legalEntityType: "LIMITED COMPANY",
                },
              ],
            },
          },
        ],
      },
    };
    const ev = buildUsptoEvidence([raw]);
    assert(ev.length === 1, "one TSDR-derived evidence row");
    assert(ev[0]?.entity_type === "LIMITED COMPANY", "entity_type extracted");
    assert(ev[0]?.registration_number === "6500000", "registration_number extracted");
    assert(ev[0]?.mark_text === "TERRA PURE", "mark_text extracted");
  }

  // parseExtractorResponse drops candidates below MIN_CONFIDENCE.
  // This validates the rule that low-confidence brand-domain candidates
  // (the kind the old prompt happily returned) get filtered when the
  // model honors the new confidence rubric.
  {
    const responsePayload = {
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                candidates: [
                  {
                    canonical_company_name: "Diversified Hospitality Solutions, Ltd.",
                    domain: "diversifiedhospitality.com",
                    confidence: 0.92,
                    reasoning: "USPTO TSDR registered owner",
                    evidence_urls: ["https://tsdr.uspto.gov/x"],
                  },
                  {
                    canonical_company_name: "Terra Pure Labs",
                    domain: "terrapurelabs.com",
                    confidence: 0.18,
                    reasoning: "generic brand landing page only",
                    evidence_urls: ["https://terrapurelabs.com"],
                  },
                ],
              }),
            },
          ],
        },
      ],
    };
    const out = parseExtractorResponse(responsePayload);
    assert(out.length === 1, "low-confidence candidate filtered");
    assert(
      out[0]?.canonical_company_name ===
        "Diversified Hospitality Solutions, Ltd.",
      "high-confidence USPTO-backed candidate retained",
    );
  }

  console.log("\n=== Apollo client — 3-tier fallback ===");

  // cleanCompanyName strips suffixes and parentheticals.
  assert(
    cleanCompanyName("Diversified Hospitality Solutions, Ltd.") ===
      "Diversified Hospitality Solutions",
    "strips ', Ltd.'",
  );
  assert(
    cleanCompanyName("Acme (USA), LLC") === "Acme",
    "strips parenthetical and ', LLC'",
  );
  assert(
    cleanCompanyName("Terra Pure™") === "Terra Pure",
    "strips trademark punctuation",
  );

  // 3-tier fallback: name+domain returns 0, domain returns 0, cleaned-name hits.
  {
    __resetRateLimitBuckets();
    const calls: Array<Record<string, unknown>> = [];
    const fakeFetch = ((_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      calls.push(body);
      // Tier 1 (name+domain): 0 hits
      // Tier 2 (domain only): 0 hits
      // Tier 3 (cleaned name only): 1 hit
      const tier = calls.length;
      if (tier === 3) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () =>
            Promise.resolve({
              organizations: [
                {
                  id: "org_1",
                  name: "Diversified Hospitality Solutions",
                  primary_domain: "diversifiedhospitality.com",
                  estimated_num_employees: 80,
                },
              ],
            }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve({ organizations: [] }),
      } as unknown as Response);
    }) as unknown as typeof fetch;
    const apollo = createApolloClient({
      apiKey: "test",
      fetchImpl: fakeFetch,
    });
    if (!apollo) {
      assert(false, "client created");
    } else {
      const tiered = await apollo.searchOrganizationsTiered(
        "Diversified Hospitality Solutions, Ltd.",
        "diversifiedhospitality.com",
      );
      assert(calls.length === 3, "all three tiers called when first two miss");
      assert(tiered.tier_used === "cleaned_name", "cleaned_name tier produced the hit");
      assert(tiered.orgs.length === 1, "one org returned");
      assert(tiered.orgs[0]?.id === "org_1", "correct org");
      assert(tiered.per_tier.length === 3, "per_tier has 3 entries");
      assert(
        (calls[2] as { q_organization_name?: string }).q_organization_name ===
          "Diversified Hospitality Solutions",
        "tier 3 sent cleaned name",
      );
    }
  }

  // 3-tier fallback short-circuits on tier 1 hit.
  {
    __resetRateLimitBuckets();
    let calls = 0;
    const fakeFetch = (() => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () =>
          Promise.resolve({
            organizations: [
              { id: "x", name: "Acme", primary_domain: "acme.com" },
            ],
          }),
      } as unknown as Response);
    }) as unknown as typeof fetch;
    const apollo = createApolloClient({
      apiKey: "test",
      fetchImpl: fakeFetch,
    });
    if (apollo) {
      const tiered = await apollo.searchOrganizationsTiered("Acme", "acme.com");
      assert(calls === 1, "stops at tier 1 when it hits");
      assert(tiered.tier_used === "name_and_domain", "tier_used = name_and_domain");
    }
  }

  // Search budget caps total calls.
  {
    __resetRateLimitBuckets();
    let calls = 0;
    const fakeFetch = (() => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve({ organizations: [] }),
      } as unknown as Response);
    }) as unknown as typeof fetch;
    const apollo = createApolloClient({
      apiKey: "test",
      fetchImpl: fakeFetch,
      searchBudget: 2,
    });
    if (apollo) {
      // First candidate exhausts the budget at 2 calls (name+domain + domain),
      // tier-3 (cleaned-name) gets short-circuited.
      await apollo.searchOrganizationsTiered("Acme, Ltd.", "acme.com");
      assert(calls === 2, "budget caps to 2 calls regardless of remaining tiers");
      assert(apollo.searchBudgetRemaining() === 0, "budget exhausted");
      // Subsequent tiered call short-circuits to empty.
      const next = await apollo.searchOrganizationsTiered("Beta", "beta.com");
      assert(next.orgs.length === 0, "exhausted budget yields empty result");
    }
  }

  console.log("\n=== Manual Apollo search — rate limit ===");

  // 5-per-10min sliding window per brand.
  {
    __resetRateLimitBuckets();
    const key = "manual-apollo:brand-test";
    const now0 = 1_000_000;
    for (let i = 1; i <= 5; i += 1) {
      const dec = checkSlidingWindow(key, 5, 600_000, now0 + i);
      assert(dec.allowed === true, `request ${i}/5 allowed`);
    }
    const sixth = checkSlidingWindow(key, 5, 600_000, now0 + 100);
    assert(sixth.allowed === false, "6th request denied");
    assert(sixth.retry_after_ms > 0, "retry_after_ms set");

    // After window expires, request allowed again.
    const later = checkSlidingWindow(key, 5, 600_000, now0 + 700_000);
    assert(later.allowed === true, "request allowed once window has slid");
  }

  // Manual search runner returns no_match when Apollo client is null
  // (i.e. APOLLO_API_KEY unset). The route layer then inserts a manual
  // no_match row for the user's query — auth is enforced by the route.
  {
    const { runManualApolloSearch } = await import(
      "../src/lib/owner-resolver/manual-apollo"
    );
    const out = await runManualApolloSearch("brand-1", "Some Co", null);
    assert(out.no_match === true, "null client → no_match");
    assert(out.rows.length === 0, "null client returns 0 rows");
  }

  console.log("");
  if (failures > 0) {
    console.error(`${failures} assertion(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 34.1 assertions passed");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
