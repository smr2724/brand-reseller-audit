import * as XLSX from "xlsx";
import { buildMapping, normalizeHeader, type BrandField } from "./mapper";
import { coerceFieldValue, type ParsedBrand } from "./smartscout";

export type ParsedBrandOverlay = ParsedBrand;

interface ParseOpts {
  overrides?: Array<{ source_column: string; target_field: string }>;
}

/**
 * Parse the Initial-Targets-List.xlsx Sheet1 overlay.
 * The header row contains some duplicate column names (e.g. "Notes" appears
 * once for the manual analysis and again as a copy of the SmartScout column).
 * sheet_to_json with header:1 + manual mapping handles duplicates correctly.
 */
export function parseInitialTargets(buffer: Buffer | ArrayBuffer | Uint8Array, opts: ParseOpts = {}): ParsedBrandOverlay[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets["Sheet1"] ?? wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
  if (aoa.length < 2) return [];
  const headers = (aoa[0] ?? []).map((h) => (h == null ? "" : String(h)));
  const mapping = buildMapping("initial_targets_analysis", opts.overrides);

  const out: ParsedBrandOverlay[] = [];

  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] ?? [];
    const fields: Partial<Record<BrandField, unknown>> = {};
    const unmapped: string[] = [];
    let name: string | null = null;

    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      const key = normalizeHeader(header);
      if (!key) continue;
      const target = mapping[key];
      const value = row[c];
      if (!target) {
        if (header.trim() !== "") unmapped.push(header);
        continue;
      }
      if (target === "ignore") continue;
      const coerced = coerceFieldValue(target, value);
      if (target === "name") {
        name = (coerced as string) ?? null;
      } else if (coerced !== null && coerced !== undefined) {
        // First occurrence wins — analysis columns appear before SmartScout-repeat columns
        if (fields[target] === undefined) {
          fields[target] = coerced;
        }
      }
    }

    if (!name || name.trim() === "") continue;
    out.push({ name: name.trim(), fields, unmappedColumns: Array.from(new Set(unmapped)) });
  }

  return out;
}
