// Validates the importer parsers against the workspace spreadsheets.
// Does NOT touch the live DB — uses an in-memory merge.
//
// Run with: npx tsx scripts/test-import.ts
//   (or: npx ts-node --compiler-options '{"module":"commonjs"}' scripts/test-import.ts)

import * as fs from "fs";
import * as path from "path";
import { parseSmartScout } from "../src/lib/importer/smartscout";
import { parseInitialTargets } from "../src/lib/importer/initialTargets";
import { mergeInMemory } from "../src/lib/importer/merge";

const SMARTSCOUT_PATH = process.env.SMARTSCOUT_FILE ?? "/home/user/workspace/SmartScout-Brands.xlsx";
const TARGETS_PATH = process.env.TARGETS_FILE ?? "/home/user/workspace/Initial-Targets-List.xlsx";

function readBuf(p: string): Buffer {
  if (!fs.existsSync(p)) {
    console.error(`MISSING: ${p}`);
    process.exit(1);
  }
  return fs.readFileSync(p);
}

function main() {
  console.log(`Parsing ${path.basename(SMARTSCOUT_PATH)}…`);
  const ssRows = parseSmartScout(readBuf(SMARTSCOUT_PATH));
  console.log(`  → ${ssRows.length} brand rows`);
  if (ssRows.length > 0) {
    const sample = ssRows[0];
    console.log(`  → sample: ${sample.name}`);
    console.log(`  → fields: ${Object.keys(sample.fields).join(", ")}`);
    if (sample.unmappedColumns.length > 0) {
      console.log(`  → unmapped: ${sample.unmappedColumns.join(", ")}`);
    }
  }

  console.log(`\nParsing ${path.basename(TARGETS_PATH)}…`);
  const tRows = parseInitialTargets(readBuf(TARGETS_PATH));
  console.log(`  → ${tRows.length} brand rows`);
  if (tRows.length > 0) {
    const sample = tRows[0];
    console.log(`  → sample: ${sample.name}`);
    console.log(`  → fields: ${Object.keys(sample.fields).join(", ")}`);
    if (sample.unmappedColumns.length > 0) {
      console.log(`  → unmapped: ${sample.unmappedColumns.join(", ")}`);
    }
  }

  console.log(`\nMerging in-memory (raw then overlay)…`);
  const merged = mergeInMemory([...ssRows, ...tRows]);
  console.log(`  → ${merged.size} unique brands after dedup`);

  let withNotes = 0;
  let withFinancials = 0;
  let cnFlagged = 0;
  for (const v of Array.from(merged.values())) {
    if (v.manual_notes) withNotes++;
    if (v.current_profit !== undefined && v.current_profit !== null) withFinancials++;
    const tags = (v.disqualifier_tags as string[] | undefined) ?? [];
    if (tags.includes("chinese_drop_shipper")) cnFlagged++;
  }
  console.log(`  → ${withNotes} with manual notes`);
  console.log(`  → ${withFinancials} with financial-model values`);
  console.log(`  → ${cnFlagged} flagged chinese_drop_shipper (CN country or notes match)`);

  // Hard expectations
  const ssOk = ssRows.length >= 145 && ssRows.length <= 160;
  const tOk = tRows.length >= 140 && tRows.length <= 155;
  if (!ssOk) {
    console.error(`\n✗ SmartScout row count out of expected range (${ssRows.length}; expected ~151)`);
    process.exit(2);
  }
  if (!tOk) {
    console.error(`\n✗ Initial-Targets row count out of expected range (${tRows.length}; expected ~145)`);
    process.exit(2);
  }
  console.log(`\n✓ Parser validated against both workspace spreadsheets.`);
}

main();
