/**
 * Phase 57 — Sanitize the qualification narrative_markdown for the
 * partial-reclaim hedging the previous Phase 50 LLM was emitting (e.g.
 * "industry-standard reclaim is 60-70%", "recoverable share: 65%"). The
 * Phase 50 prompt has been rewritten to forbid these phrases, but the
 * sanitizer is the defense-in-depth backstop — same pattern as the
 * Phase 55 forensic-dossier sanitizer.
 *
 * On match we substitute the offending sentence with a Steve-voiced
 * replacement that points the reader at the Pitch Math card (where the
 * canonical 100%-recapture numbers live).
 */

export const FORBIDDEN_RECLAIM_PHRASES: RegExp[] = [
  /\b(?:industry[- ]standard|achievable|realistic|typical)\s+(?:reclaim|recovery|capture|recapture)\b/i,
  /\b(?:reclaim|recovery|capture)\s+(?:rate|share|ceiling|ratio|percentage)\b/i,
  /\brecoverable\s+share\b/i,
  /\b(?:portion|share|fraction)\s+(?:can be|is|that is)\s+recover(?:ed|able)\b/i,
  /\bblended\s+margin\s+range\b/i,
  /\bblended\s+capture\b/i,
  /\b\d{1,2}\s*[-–]\s*\d{1,2}\s*%\s*(?:reclaim|recovery|capture|recapture|margin)\b/i,
];

const REPLACEMENT_SENTENCE =
  "We recover 100% of reseller-controlled revenue for qualified brands. The math is shown in the Pitch Math card.";

export interface SanitizeResult {
  /** The cleaned markdown — identical to the input when nothing matched. */
  cleaned: string;
  /** The verbatim sentences we replaced, in document order. Empty when no match. */
  removed: string[];
}

/**
 * Walk the markdown sentence-by-sentence and substitute any sentence
 * containing a forbidden reclaim phrase with the canonical 100%-recapture
 * pointer. Matches are case-insensitive. Returns the cleaned text plus
 * the list of removed sentences for logging into the qualification
 * row's error_message diagnostics.
 */
export function sanitizeNarrativeMarkdown(markdown: string): SanitizeResult {
  if (typeof markdown !== "string" || markdown.length === 0) {
    return { cleaned: markdown ?? "", removed: [] };
  }
  // Split on sentence boundaries while preserving line structure. We
  // split per-line, then per-sentence inside each line, so list bullets
  // and headings stay intact.
  const removed: string[] = [];
  const outLines: string[] = [];
  for (const line of markdown.split("\n")) {
    // Match leading list/heading marker so we re-emit it untouched.
    const markerMatch = /^(\s*(?:[-*]|\d+\.|#{1,6})\s+)?(.*)$/.exec(line);
    const prefix = markerMatch?.[1] ?? "";
    const body = markerMatch?.[2] ?? line;
    if (!body) {
      outLines.push(line);
      continue;
    }
    const sentences = splitSentences(body);
    const cleanedSentences = sentences.map((s) => {
      if (sentenceTrips(s)) {
        removed.push(s.trim());
        return REPLACEMENT_SENTENCE;
      }
      return s;
    });
    outLines.push(prefix + cleanedSentences.join(""));
  }
  return { cleaned: outLines.join("\n"), removed };
}

/** True when the markdown body contains any forbidden reclaim phrase. */
export function narrativeTripsSanitizer(markdown: string): boolean {
  if (typeof markdown !== "string" || markdown.length === 0) return false;
  for (const re of FORBIDDEN_RECLAIM_PHRASES) {
    if (re.test(markdown)) return true;
  }
  return false;
}

function sentenceTrips(sentence: string): boolean {
  for (const re of FORBIDDEN_RECLAIM_PHRASES) {
    if (re.test(sentence)) return true;
  }
  return false;
}

/**
 * Split a paragraph into sentence chunks, keeping the trailing
 * punctuation + whitespace on each chunk so reassembly is loss-free.
 * Not a perfect tokenizer — good enough for the analyst-memo prose the
 * narrative LLM emits.
 */
function splitSentences(text: string): string[] {
  const parts: string[] = [];
  let buffer = "";
  for (let i = 0; i < text.length; i++) {
    buffer += text[i];
    if (/[.!?]/.test(text[i])) {
      // Lookahead: consume trailing quote / paren / whitespace so the
      // sentence boundary survives a reassembly. We stop at the first
      // alphabetic character of the next sentence.
      let j = i + 1;
      while (j < text.length && /["')\]\s]/.test(text[j])) {
        buffer += text[j];
        j += 1;
      }
      parts.push(buffer);
      buffer = "";
      i = j - 1;
    }
  }
  if (buffer.length > 0) parts.push(buffer);
  return parts;
}
