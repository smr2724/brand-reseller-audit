import * as XLSX from "xlsx";
import { buildMapping, normalizeHeader, type BrandField } from "./mapper";

export interface ParsedBrand {
  name: string;
  fields: Partial<Record<BrandField, unknown>>;
  unmappedColumns: string[];
}

function coerceNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function coerceBool(v: unknown): boolean | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "yes" || s === "1") return true;
  if (s === "false" || s === "no" || s === "0") return false;
  return null;
}
function coerceText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

const NUMERIC_FIELDS = new Set<BrandField>([
  "brand_score",
  "est_monthly_revenue",
  "trailing_12_months",
  "avg_sellers",
  "avg_fba_sellers",
  "dominant_seller_sales_pct",
  "total_products",
  "monthly_growth_pct",
  "trailing_12_growth_pct",
  "current_profit",
  "resellers_margin",
  "recouped_shipping",
  "labor_cost",
  "additional_profit",
  "rcg_fees",
  "new_profit",
  "seven_x_multiple_value",
]);

const BOOL_FIELDS = new Set<BrandField>(["has_storefront"]);

export function coerceFieldValue(field: BrandField, raw: unknown): unknown {
  if (BOOL_FIELDS.has(field)) return coerceBool(raw);
  if (NUMERIC_FIELDS.has(field)) return coerceNumber(raw);
  return coerceText(raw);
}

interface ParseOpts {
  overrides?: Array<{ source_column: string; target_field: string }>;
}

/**
 * Parse a SmartScout-Brands.xlsx style export from a buffer.
 * Reads the first sheet. Tolerates extra/missing columns.
 */
export function parseSmartScout(buffer: Buffer | ArrayBuffer | Uint8Array, opts: ParseOpts = {}): ParsedBrand[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
  const mapping = buildMapping("smartscout_raw", opts.overrides);

  const out: ParsedBrand[] = [];
  for (const row of rows) {
    const fields: Partial<Record<BrandField, unknown>> = {};
    const unmapped: string[] = [];
    let name: string | null = null;

    for (const [header, value] of Object.entries(row)) {
      const key = normalizeHeader(header);
      const target = mapping[key];
      if (!target) {
        if (header && header.trim() !== "") unmapped.push(header);
        continue;
      }
      if (target === "ignore") continue;
      const coerced = coerceFieldValue(target, value);
      if (target === "name") {
        name = (coerced as string) ?? null;
      } else if (coerced !== null && coerced !== undefined) {
        fields[target] = coerced;
      }
    }

    if (!name || name.trim() === "") continue;
    out.push({ name: name.trim(), fields, unmappedColumns: Array.from(new Set(unmapped)) });
  }
  return out;
}
