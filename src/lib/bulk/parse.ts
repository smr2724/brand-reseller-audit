/**
 * Phase 75 — Smart brand-list parser.
 *
 * Splits on any combination of newlines, commas, semicolons, and tabs,
 * trims, strips surrounding quotes, and dedupes case-insensitively
 * while preserving the first-seen casing of each brand. Empty input or
 * pure whitespace returns [].
 */
export function parseBrandList(raw: string): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[\n,;\t]+/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const unquoted = trimmed.replace(/^["']+|["']+$/g, "").trim();
    if (!unquoted) continue;
    const key = unquoted.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(unquoted);
  }
  return out;
}
