/**
 * Phase 25 — Token-level Jaccard similarity for ranking brand candidates.
 *
 * The ranker is intentionally simple: tokenize on whitespace + punctuation,
 * compute |A∩B| / |A∪B|. Bigram fallback gives us partial-match credit
 * when the user typed e.g. "Couples Coffee" and we want to surface
 * "Couple's Coffee".
 */

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

function bigrams(s: string): Set<string> {
  const lower = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < lower.length - 1; i++) {
    out.add(lower.slice(i, i + 2));
  }
  return out;
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const aIter = Array.from(a);
  for (const x of aIter) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Returns 0..1. 1.0 iff strings are identical after normalize. Otherwise a
 * blended token-Jaccard + bigram-Jaccard, with a small bonus when one is a
 * prefix or substring of the other.
 */
export function similarity(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.trim().toLowerCase();
  if (!q || !c) return 0;
  if (q === c) return 1;
  const qAlpha = q.replace(/[^a-z0-9]/g, "");
  const cAlpha = c.replace(/[^a-z0-9]/g, "");
  if (qAlpha && qAlpha === cAlpha) return 0.97;

  const tokenScore = jaccard(tokenize(q), tokenize(c));
  const bigramScore = jaccard(bigrams(q), bigrams(c));
  let score = 0.6 * tokenScore + 0.4 * bigramScore;

  if (qAlpha && cAlpha) {
    if (cAlpha.startsWith(qAlpha) || qAlpha.startsWith(cAlpha)) {
      score = Math.max(score, 0.85);
    } else if (cAlpha.includes(qAlpha) || qAlpha.includes(cAlpha)) {
      score = Math.max(score, 0.75);
    }
  }
  return Math.min(1, score);
}
