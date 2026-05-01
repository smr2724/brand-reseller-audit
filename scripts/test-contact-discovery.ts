/**
 * Phase 6 — Contact discovery smoke test.
 *
 * Usage:
 *   npx tsx scripts/test-contact-discovery.ts <domain>
 *
 * Prints the top 5 decision-maker candidates for the given domain.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import {
  searchOrganizations,
  searchPeople,
  PHASE6_DECISION_MAKER_TITLES,
} from "../src/lib/apollo";

async function main() {
  const domain = process.argv[2];
  if (!domain) {
    console.error("Usage: tsx scripts/test-contact-discovery.ts <domain>");
    process.exit(1);
  }
  if (!process.env.APOLLO_API_KEY) {
    console.error("APOLLO_API_KEY missing in .env.local");
    process.exit(1);
  }

  console.log(`[1/2] searching organizations for: ${domain}`);
  const orgRes = await searchOrganizations(domain);
  if (!orgRes.ok) {
    console.error("organization search failed:", orgRes.error);
    process.exit(1);
  }
  if (orgRes.organizations.length === 0) {
    console.log("no organization match.");
    return;
  }
  const org = orgRes.organizations[0];
  console.log("found org:", { id: org.id, name: org.name, primary_domain: org.primary_domain });

  console.log(`[2/2] searching decision-makers (titles=${PHASE6_DECISION_MAKER_TITLES.length})…`);
  const peopleRes = await searchPeople({ organizationId: org.id, perPage: 10 });
  if (!peopleRes.ok) {
    console.error("people search failed:", peopleRes.error);
    process.exit(1);
  }
  if (peopleRes.people.length === 0) {
    console.log("no people matched the title filter.");
    return;
  }
  console.log(`found ${peopleRes.total} people total. top 5:`);
  peopleRes.people.slice(0, 5).forEach((p, i) => {
    const name = p.name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim();
    console.log(`  ${i + 1}. ${name} — ${p.title ?? "?"} [${p.seniority ?? "?"}]${p.email ? ` <${p.email}>` : " (email hidden)"}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
