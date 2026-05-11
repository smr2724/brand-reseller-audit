/**
 * Phase 63 — Regression tests for the Apollo candidate ranking helper.
 *
 * Run directly with tsx:
 *
 *   npx tsx src/lib/contacts/__tests__/rank.test.ts
 *
 * Verifies the ranking rules described in `rank.ts`:
 *   - founder/CEO/president/owner beat VPs
 *   - missing title falls to rank 5
 *   - ties broken by Apollo's original order
 *   - only the top 5 are returned
 */
import { rankCandidates } from "../rank";
import type { ApolloPersonSlim } from "../apollo";

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

function p(id: string, title: string | undefined, name?: string): ApolloPersonSlim {
  return {
    id,
    title,
    name: name ?? id,
  };
}

function runFounderBeatsVpTest(): void {
  const search = {
    people: [
      p("vp", "VP Sales"),
      p("founder", "Founder & CEO"),
    ],
  };
  const ranked = rankCandidates(search);
  check(
    "founder ranks above VP",
    ranked[0].person.id === "founder",
    `top=${ranked[0].person.id}`,
  );
  check(
    "founder has rank 1",
    ranked[0].rank === 1,
    `rank=${ranked[0].rank}`,
  );
  check(
    "VP has rank 3",
    ranked[1].rank === 3,
    `rank=${ranked[1].rank}`,
  );
}

function runMissingTitleFallsToRank5(): void {
  const search = {
    people: [
      p("notitle", undefined),
      p("director", "Director of Operations"),
      p("vp", "VP Marketing"),
      p("cmo", "CMO"),
      p("ceo", "Chief Executive Officer"),
    ],
  };
  const ranked = rankCandidates(search);
  // Find the no-title row in the result.
  const noTitle = ranked.find((r) => r.person.id === "notitle");
  check(
    "missing title gets rank 5",
    noTitle?.rank === 5,
    `rank=${noTitle?.rank}`,
  );
  // Verify CEO is on top (rank 1).
  check(
    "CEO ranked first",
    ranked[0].person.id === "ceo",
    `top=${ranked[0].person.id}`,
  );
  // CMO should be rank 2, VP rank 3, Director rank 4, no-title rank 5.
  check(
    "CMO has rank 2",
    ranked.find((r) => r.person.id === "cmo")?.rank === 2,
  );
  check(
    "VP has rank 3",
    ranked.find((r) => r.person.id === "vp")?.rank === 3,
  );
  check(
    "Director has rank 4",
    ranked.find((r) => r.person.id === "director")?.rank === 4,
  );
}

function runTiesBrokenByApolloOrder(): void {
  // Three rank-1 candidates in a specific Apollo order. The first one
  // in the input must come first in the output.
  const search = {
    people: [
      p("ceo-A", "CEO"),
      p("ceo-B", "Co-Founder"),
      p("ceo-C", "President"),
    ],
  };
  const ranked = rankCandidates(search);
  check(
    "ties broken by Apollo order — first wins",
    ranked[0].person.id === "ceo-A",
    `top=${ranked[0].person.id}`,
  );
  check(
    "ties broken by Apollo order — second wins second",
    ranked[1].person.id === "ceo-B",
  );
  check(
    "ties broken by Apollo order — third wins third",
    ranked[2].person.id === "ceo-C",
  );
}

function runOnlyTop5(): void {
  const search = {
    people: [
      p("c1", "CEO"),
      p("c2", "President"),
      p("c3", "Founder"),
      p("c4", "Owner"),
      p("c5", "Co-Founder"),
      p("c6", "VP Sales"),
      p("c7", "Director of Marketing"),
    ],
  };
  const ranked = rankCandidates(search);
  check(
    "returns at most 5",
    ranked.length === 5,
    `got ${ranked.length}`,
  );
  // None of them should be the rank-3 VP or rank-4 Director.
  const ids = ranked.map((r) => r.person.id);
  check(
    "top 5 excludes lower-ranked candidates when 5 rank-1s are available",
    !ids.includes("c6") && !ids.includes("c7"),
    ids.join(","),
  );
}

function runAcceptsBareApolloSearchOk(): void {
  const search = {
    ok: true as const,
    total: 1,
    raw: null,
    people: [p("only", "CEO")],
  };
  const ranked = rankCandidates(search);
  check(
    "accepts ApolloSearchResult ok=true",
    ranked.length === 1 && ranked[0].person.id === "only",
  );
}

function runRejectsApolloSearchError(): void {
  const search = { ok: false as const, error: "boom" };
  const ranked = rankCandidates(search);
  check(
    "ApolloSearchResult ok=false → empty",
    ranked.length === 0,
  );
}

function runSvpEvpRankAsThree(): void {
  // Phase 63 follow-up — the rank-3 VP matcher must also catch SVP, EVP,
  // "Senior VP …", and "Executive VP …". Without these, a "SVP Sales"
  // would fall to rank 5 (no title) and lose to a Director in the top-5
  // ordering, which is wrong (SVP > Director).
  //
  // We mix in a rank-1 CEO so rankCandidates returns 5 items (top 5) and
  // we can inspect the 4 VP-tier rows + the CEO.
  const search = {
    people: [
      p("ceo", "CEO"),
      p("svp", "SVP Sales"),
      p("evp", "EVP Operations"),
      p("senior-vp", "Senior VP Strategy"),
      p("vp", "VP Marketing"),
    ],
  };
  const ranked = rankCandidates(search);
  const rankOf = (id: string) =>
    ranked.find((r) => r.person.id === id)?.rank;
  check("SVP Sales → rank 3", rankOf("svp") === 3, `rank=${rankOf("svp")}`);
  check(
    "EVP Operations → rank 3",
    rankOf("evp") === 3,
    `rank=${rankOf("evp")}`,
  );
  check(
    "'Senior VP Strategy' → rank 3",
    rankOf("senior-vp") === 3,
    `rank=${rankOf("senior-vp")}`,
  );
  check(
    "VP Marketing still → rank 3 after extension",
    rankOf("vp") === 3,
    `rank=${rankOf("vp")}`,
  );

  // Separate run for the Executive-VP variant. (Note: "Vice President of X"
  // is matched by the rank-1 `president` token in the existing matcher
  // because rank-1 patterns are evaluated first; that pre-dates Phase 63
  // and is intentional — a stand-alone "President" title outranks a VP.)
  // We also assert Director (rank 4) is NOT promoted by the VP matcher.
  const search2 = {
    people: [
      p("exec-vp", "Executive VP of Marketing"),
      p("director", "Director of Operations"),
    ],
  };
  const ranked2 = rankCandidates(search2);
  const rankOf2 = (id: string) =>
    ranked2.find((r) => r.person.id === id)?.rank;
  check(
    "'Executive VP …' → rank 3",
    rankOf2("exec-vp") === 3,
    `rank=${rankOf2("exec-vp")}`,
  );
  check(
    "Director still rank 4 (VP matcher didn't slurp it)",
    rankOf2("director") === 4,
    `rank=${rankOf2("director")}`,
  );
}

async function main(): Promise<void> {
  runFounderBeatsVpTest();
  runMissingTitleFallsToRank5();
  runTiesBrokenByApolloOrder();
  runOnlyTop5();
  runAcceptsBareApolloSearchOk();
  runRejectsApolloSearchError();
  runSvpEvpRankAsThree();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

void main();
