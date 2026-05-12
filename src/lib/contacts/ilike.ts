/**
 * Phase 73.2 — shared helper for case-insensitive name lookups via
 * Postgres ILIKE.
 *
 * `_` and `%` in a person's name (rare but possible — research found
 * the `_` glyph appears in some bot-generated handles, and a literal
 * `%` could arrive via copy-paste) would otherwise be interpreted as
 * SQL wildcards: `Sarah_Lee` would match `SarahXLee`, and a `%`-bearing
 * name would match every row in the brand. The collision shows up as
 * `.maybeSingle()` returning null on multi-row matches — which from
 * the route's perspective looks identical to "row missing", causing a
 * 500 after we've already burned the MV credit.
 *
 * Backslash-escape the three characters Postgres treats specially in
 * ILIKE patterns: `\` (the escape char itself), `%` (any-string),
 * `_` (any-single-char).
 */
export function escapeIlike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}
