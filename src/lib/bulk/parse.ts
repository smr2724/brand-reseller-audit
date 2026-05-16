/**
 * Phase 75 — Smart brand-list parser.
 *
 * Splits on any combination of newlines, commas, semicolons, tabs, and
 * non-breaking spaces (NBSP, U+00A0 — common in pastes from Mac Pages,
 * Word, and Excel-via-clipboard). Trims, strips both straight and curly
 * surrounding quotes (U+201C/U+201D/U+2018/U+2019), and dedupes
 * case-insensitively while preserving the first-seen casing of each
 * brand. Empty input or pure whitespace returns [].
 */
export function parseBrandList(raw: string): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[\n,;\t ]+/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const unquoted = trimmed
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .trim();
    if (!unquoted) continue;
    const key = unquoted.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(unquoted);
  }
  return out;
}
