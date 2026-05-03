/**
 * Phase 25 — Brand-name variant generator for fuzzy brand discovery.
 *
 * Phase 25.1 — Adds suffix-ADD variants (Co./Co/Company/Inc/LLC), ALL-CAPS,
 * and singular-non-possessive forms. Real Amazon brand strings are often
 * stored ALL-CAPS with a corporate suffix Keepa needs verbatim, so a strict
 * `brand: ["..."]` filter on /query won't match the user's casual input
 * unless we feed it those forms too.
 *
 * Going-forward principle: search inputs to brand discovery should never
 * return zero results unless we've tried at least (1) exact, (2) deterministic
 * variants, (3) external Amazon search. Always show the user something
 * selectable, even if low confidence — humans pick the right brand from a
 * small list better than fuzzy matchers do.
 */

const SUFFIXES = ["llc", "inc", "co", "company", "corp", "corporation", "ltd", "limited"];
const ADD_SUFFIXES = ["Co.", "Co", "Company", "Inc", "LLC"];

/**
 * Lowercase, collapse whitespace, strip outer punctuation. Used as the cache
 * key and the basis for similarity scoring.
 */
export function normalizeQuery(input: string): string {
  return input
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Strip punctuation entirely and lowercase, for similarity comparison.
 */
export function alphaNumericKey(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function stripCorporateSuffix(s: string): string {
  const tokens = s.split(/\s+/);
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1].replace(/[.,]/g, "").toLowerCase();
    if (SUFFIXES.includes(last)) {
      tokens.pop();
    } else {
      break;
    }
  }
  return tokens.join(" ").trim();
}

function endsWithCorporateSuffix(s: string): boolean {
  const tokens = s.split(/\s+/);
  if (!tokens.length) return false;
  const last = tokens[tokens.length - 1].replace(/[.,]/g, "").toLowerCase();
  return SUFFIXES.includes(last);
}

function pluralizeSingularizeLastToken(s: string): string[] {
  const tokens = s.split(/\s+/);
  if (!tokens.length) return [];
  const last = tokens[tokens.length - 1];
  const out: string[] = [];
  // -ies -> -y (Amenities -> Amenity)
  if (last.length > 4 && /ies$/i.test(last)) {
    const singular = last.slice(0, -3) + "y";
    out.push([...tokens.slice(0, -1), singular].join(" "));
  }
  // -es -> base (Boxes -> Box)
  if (last.length > 4 && /(s|x|z|ch|sh)es$/i.test(last)) {
    const singular = last.slice(0, -2);
    out.push([...tokens.slice(0, -1), singular].join(" "));
  }
  // Plural -> singular (generic)
  if (last.length > 3 && /s$/i.test(last) && !/ss$/i.test(last)) {
    const singular = last.slice(0, -1);
    out.push([...tokens.slice(0, -1), singular].join(" "));
  }
  // Singular -> plural
  if (last.length > 2 && !/s$/i.test(last)) {
    out.push([...tokens.slice(0, -1), last + "s"].join(" "));
    // -y -> -ies
    if (/[^aeiou]y$/i.test(last)) {
      const plural = last.slice(0, -1) + "ies";
      out.push([...tokens.slice(0, -1), plural].join(" "));
    }
  }
  return out;
}

/**
 * For tokens that look possessive or possessive-able, generate every
 * variation we plausibly need. Phase 25.1 expands this to include the
 * singular non-possessive (Couple from Couples / Couple's), since some
 * Amazon brand strings drop the 's entirely.
 */
function apostropheVariants(s: string): string[] {
  const out = new Set<string>();
  // Strip all apostrophes (Couple's -> Couples)
  out.add(s.replace(/'/g, ""));
  const tokens = s.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const bare = t.replace(/'/g, "");
    if (/^[A-Za-z]+s$/.test(bare) && bare.length > 2) {
      const singular = bare.slice(0, -1);
      const a = [...tokens]; a[i] = singular + "'s"; out.add(a.join(" "));
      const b = [...tokens]; b[i] = bare + "'"; out.add(b.join(" "));
      const c = [...tokens]; c[i] = singular; out.add(c.join(" "));
    } else if (/^[A-Za-z]+$/.test(bare) && bare.length > 2) {
      // Add 's possessive
      const a = [...tokens]; a[i] = bare + "'s"; out.add(a.join(" "));
      // Already a non-possessive non-plural token — also try the plural
      // (some Amazon brands index as the plural form).
      const b = [...tokens]; b[i] = bare + "s"; out.add(b.join(" "));
    } else if (/^[A-Za-z]+'s$/.test(t)) {
      // explicit X's already; add singular X (Couple's -> Couple)
      const root = t.slice(0, -2);
      if (root.length > 2) {
        const a = [...tokens]; a[i] = root; out.add(a.join(" "));
        const b = [...tokens]; b[i] = root + "s"; out.add(b.join(" "));
      }
    }
  }
  return Array.from(out);
}

function hyphenAmpersandVariants(s: string): string[] {
  const out = new Set<string>();
  if (s.includes("-")) out.add(s.replace(/-/g, " "));
  if (s.includes(" ")) out.add(s.replace(/\s+/g, "-"));
  if (s.includes("&")) {
    out.add(s.replace(/&/g, "and"));
    out.add(s.replace(/\s*&\s*/g, " "));
  }
  if (/\band\b/i.test(s)) out.add(s.replace(/\band\b/gi, "&"));
  return Array.from(out);
}

/**
 * Append corporate suffixes (Co., Co, Company, Inc, LLC) when the input
 * doesn't already end in one. Real Amazon brand strings are often stored
 * with the corporate suffix appended verbatim ("COUPLE'S COFFEE CO.").
 */
function suffixAddVariants(s: string): string[] {
  if (endsWithCorporateSuffix(s)) return [];
  const trimmed = s.trim();
  if (!trimmed) return [];
  return ADD_SUFFIXES.map((suf) => `${trimmed} ${suf}`);
}

/**
 * Generate ALL-CAPS variant. Many Amazon storefront brand strings are
 * indexed all-uppercase and Keepa's strict-equality /query filter on
 * `brand: ["..."]` won't match unless we ask for that exact form.
 */
function uppercaseVariant(s: string): string[] {
  const upper = s.toUpperCase();
  if (upper === s) return [];
  return [upper];
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const trimmed = v.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    // Phase 25.1 — case-sensitive dedupe so an ALL-CAPS variant we generate
    // for Keepa's strict-equality brand filter survives even when a
    // mixed-case form of the same string is already in the list.
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Tight set: original + small number of high-confidence deterministic
 * variants. Capped at ~16 (was 8 in Phase 25) — we have 5 suffix-add forms
 * and ALL-CAPS that are all high-precision and worth fanning out.
 */
export function tightVariants(query: string): string[] {
  const original = query.trim();
  if (!original) return [];
  const out: string[] = [original];

  // Apostrophe variations (Couples ↔ Couple's ↔ Couple)
  out.push(...apostropheVariants(original));

  // Plural ↔ singular on last token
  out.push(...pluralizeSingularizeLastToken(original));

  // ALL-CAPS variant (and ALL-CAPS-with-CO. for the Amazon storefront form).
  // Real Amazon brand strings are often stored uppercase and Keepa's
  // strict-equality /query won't hit unless we ask. Place these before the
  // suffix-add fan-out so they don't get crowded out by the slice cap.
  const upperBase = original.toUpperCase();
  if (upperBase !== original) {
    out.push(upperBase);
    if (!endsWithCorporateSuffix(upperBase)) {
      out.push(`${upperBase} CO.`);
    }
  }

  // Strip corporate suffix
  const noSuffix = stripCorporateSuffix(original);
  if (noSuffix !== original) out.push(noSuffix);

  // ADD corporate suffix variants — real Amazon brand strings often include
  // these literally and Keepa's brand filter is strict-equality.
  out.push(...suffixAddVariants(original));
  // Also suffix-add to the apostrophe-stripped form (Couples Coffee Co.)
  const apostropheBase = original.replace(/'/g, "");
  if (apostropheBase !== original) {
    out.push(...suffixAddVariants(apostropheBase));
  }

  // Hyphen / ampersand normalization (single, low-noise)
  out.push(...hyphenAmpersandVariants(original).slice(0, 1));

  return dedupe(out).slice(0, 16);
}

/**
 * Loose set: tight + aggressive. Bigram-style transforms that can yield
 * false positives but are useful when the tight set has been exhausted.
 */
export function looseVariants(query: string): string[] {
  const tight = tightVariants(query);
  const out: string[] = [...tight];

  const original = query.trim();
  if (original) {
    // Drop the last token entirely (e.g. "Couples Coffee Co" → "Couples Coffee"
    // already handled by suffix-strip; this catches non-suffix tail like
    // "Couples Coffee Roasters" → "Couples Coffee").
    const tokens = original.split(/\s+/);
    if (tokens.length >= 2) out.push(tokens.slice(0, -1).join(" "));
    if (tokens.length >= 3) out.push(tokens.slice(0, -2).join(" "));

    // Drop the first token (handles brand prefix like "The Couples Coffee")
    if (tokens.length >= 2 && /^the$/i.test(tokens[0])) {
      out.push(tokens.slice(1).join(" "));
    }

    // Combined: apostrophe + plural-singular cross product
    for (const a of apostropheVariants(original)) {
      out.push(...pluralizeSingularizeLastToken(a));
    }

    // Vowel-trim: drop last vowel of last token (cheap fuzzy)
    const last = tokens[tokens.length - 1];
    const vowelStripped = last.replace(/[aeiou]$/i, "");
    if (vowelStripped !== last && vowelStripped.length >= 3) {
      out.push([...tokens.slice(0, -1), vowelStripped].join(" "));
    }

    // No-spaces concat (StoreBrand → Store Brand and vice versa)
    if (tokens.length >= 2) out.push(tokens.join(""));
    const lower = original.toLowerCase();
    if (!lower.includes(" ") && lower.length >= 6) {
      // Best-effort camel split
      const split = original.replace(/([a-z])([A-Z])/g, "$1 $2");
      if (split !== original) out.push(split);
    }
  }

  return dedupe(out).slice(0, 24);
}
