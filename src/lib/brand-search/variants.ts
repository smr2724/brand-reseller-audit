/**
 * Phase 25 — Brand-name variant generator for fuzzy brand discovery.
 *
 * Going-forward principle: search inputs to brand discovery should never
 * return zero results unless we've tried at least (1) exact, (2) deterministic
 * variants, (3) external Amazon search. Always show the user something
 * selectable, even if low confidence — humans pick the right brand from a
 * small list better than fuzzy matchers do.
 */

const SUFFIXES = ["llc", "inc", "co", "company", "corp", "corporation", "ltd", "limited"];

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

function apostropheVariants(s: string): string[] {
  const out = new Set<string>();
  // No-op original
  // Strip all apostrophes
  out.add(s.replace(/'/g, ""));
  // For each token ending in plural-s, also try singular-possessive ('s)
  // and plural-possessive (s'). This is the Couples / Couple's case.
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
      // Try adding 's
      const a = [...tokens]; a[i] = bare + "'s"; out.add(a.join(" "));
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

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const trimmed = v.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Tight set: original + small number of high-confidence deterministic
 * variants. Caps at ~7 so a parallel Keepa fan-out stays cheap.
 */
export function tightVariants(query: string): string[] {
  const original = query.trim();
  if (!original) return [];
  const out: string[] = [original];

  // Apostrophe variations (Couples ↔ Couple's)
  out.push(...apostropheVariants(original));

  // Plural ↔ singular on last token
  out.push(...pluralizeSingularizeLastToken(original));

  // Strip corporate suffix
  const noSuffix = stripCorporateSuffix(original);
  if (noSuffix !== original) out.push(noSuffix);

  // Hyphen / ampersand normalization (single, low-noise)
  out.push(...hyphenAmpersandVariants(original).slice(0, 1));

  return dedupe(out).slice(0, 8);
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

  return dedupe(out).slice(0, 16);
}
