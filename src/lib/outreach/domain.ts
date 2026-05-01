/**
 * Domain helpers for Phase 6 contact discovery.
 *
 * Apollo's `q_organization_domains_list` expects a bare domain like
 * `example.com`. We may receive a full URL (`https://www.example.com/foo`)
 * or nothing at all and need to fall back to a guess.
 */

export interface DerivedDomain {
  domain: string;
  source: "website" | "name_fallback";
  confidence: "high" | "low";
}

const TLD_BLOCKLIST = new Set(["amazon.com", "amzn.to", "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com", "youtube.com"]);

export function normalizeDomain(input: string): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  // Strip protocol and path.
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("/")[0]?.split("?")[0]?.split("#")[0] ?? "";
  s = s.replace(/[^a-z0-9.\-]/g, "");
  if (!s.includes(".")) return null;
  if (TLD_BLOCKLIST.has(s)) return null;
  return s || null;
}

/**
 * Derive a domain to use as Apollo's seed.
 *
 *   - prefer brand.website (high confidence)
 *   - fall back to `${name_normalized}.com` (low confidence)
 */
export function deriveDomain(brand: { website?: string | null; name_normalized?: string | null; name?: string }): DerivedDomain | null {
  if (brand.website) {
    const d = normalizeDomain(brand.website);
    if (d) return { domain: d, source: "website", confidence: "high" };
  }
  const slug = (brand.name_normalized ?? brand.name ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  if (!slug) return null;
  return { domain: `${slug}.com`, source: "name_fallback", confidence: "low" };
}

/**
 * Cheap fuzzy similarity for picking the best org match by name.
 * 0..1 — higher is more similar.
 */
export function nameSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const A = norm(a);
  const B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.includes(B) || B.includes(A)) return 0.9;
  const at = new Set(A.split(/\s+/));
  const bt = new Set(B.split(/\s+/));
  let overlap = 0;
  at.forEach(t => { if (bt.has(t)) overlap++; });
  const denom = Math.max(at.size, bt.size);
  return denom === 0 ? 0 : overlap / denom;
}
