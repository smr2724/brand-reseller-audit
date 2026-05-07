/**
 * Phase 47 — USPTO summary for qualification. Thin adapter on top of
 * `src/lib/owner-resolver/uspto.searchUsptoTrademarks` that produces the
 * compact `{ owner, attorney, country, serial, status }` shape the ICP
 * prompt expects. Failure → degrade to LLM-only entity selection.
 *
 * No new key required (uses the OPENAI_API_KEY web-search path the
 * resolver already uses).
 */
import { searchUsptoTrademarks } from "@/lib/owner-resolver/uspto";

export interface UsptoQualificationSummary {
  called: boolean;
  found: boolean;
  owner: string | null;
  attorney: string | null;
  country: string | null;
  serial: string | null;
  status: string | null;
  raw: unknown;
  error: string | null;
}

export async function searchTrademark(
  brandName: string,
): Promise<UsptoQualificationSummary> {
  const empty: UsptoQualificationSummary = {
    called: false,
    found: false,
    owner: null,
    attorney: null,
    country: null,
    serial: null,
    status: null,
    raw: null,
    error: null,
  };
  if (!brandName || !brandName.trim()) return empty;

  let result;
  try {
    result = await searchUsptoTrademarks(brandName, { maxCandidates: 5 });
  } catch (e) {
    return {
      ...empty,
      called: true,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  if (result.error) {
    return {
      ...empty,
      called: true,
      error: result.error,
      raw: result.raw,
    };
  }

  const top = result.candidates[0] ?? null;
  if (!top) {
    return { ...empty, called: true, raw: result.raw };
  }

  return {
    called: true,
    found: true,
    owner: top.candidate_company_name ?? null,
    // The resolver doesn't currently expose attorney directly — leave null
    // so the ICP prompt "small_attorney_signal" cleanly skips when absent.
    attorney: null,
    country: extractCountry(top.trademark_owner_address ?? null),
    serial: top.trademark_serial_number ?? null,
    status: top.trademark_status ?? null,
    raw: result.raw,
    error: null,
  };
}

/** Compact one-paragraph summary for the prompt. */
export function summarizeUspto(s: UsptoQualificationSummary): string {
  if (!s.called) return "USPTO: not called";
  if (s.error) return `USPTO: error — ${s.error}`;
  if (!s.found) return "USPTO: no live mark found";
  const parts: string[] = [];
  if (s.owner) parts.push(`Owner: ${s.owner}`);
  if (s.attorney) parts.push(`Attorney: ${s.attorney}`);
  if (s.country) parts.push(`Country: ${s.country}`);
  if (s.serial) parts.push(`Serial: ${s.serial}`);
  if (s.status) parts.push(`Status: ${s.status}`);
  return parts.length > 0 ? parts.join(" | ") : "USPTO: live mark (no fields)";
}

function extractCountry(address: string | null): string | null {
  if (!address) return null;
  const m = address.match(/\b([A-Z]{2})\b\s*$/);
  if (m) return m[1];
  if (/UNITED STATES|\bUSA\b|\bU\.S\.A\.\b/i.test(address)) return "US";
  return null;
}
