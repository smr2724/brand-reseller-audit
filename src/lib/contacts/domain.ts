/**
 * Phase 73 — Shared domain-normalization helpers.
 *
 * `extractApexDomain` strips protocol + `www.`, drops paths/queries, and
 * collapses subdomains to a 2-label apex (with a small heuristic for
 * known multi-part ccTLDs like `.co.uk`). This avoids the bug where
 * `shop.carna4.com` produces `maria@shop.carna4.com` — almost always
 * wrong — and burns 8 MV credits on doomed addresses.
 *
 * Heuristic intentionally simple: `.co.uk`, `.com.au`, `.co.jp` style
 * suffixes keep 3 labels; everything else keeps 2. This is imperfect
 * (a properly accurate Public Suffix List lookup is overkill for the
 * brands we see) but documents the trade-off in code.
 */

const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  "co.uk",
  "co.jp",
  "co.kr",
  "co.nz",
  "co.za",
  "com.au",
  "com.br",
  "com.mx",
  "com.sg",
  "com.tw",
  "com.tr",
  "com.cn",
  "com.hk",
  "com.ar",
  "com.co",
  "co.in",
  "ac.uk",
  "org.uk",
  "gov.uk",
  "ne.jp",
  "or.jp",
]);

export function extractApexDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("/")[0] ?? "";
  s = s.split("?")[0] ?? "";
  s = s.split("#")[0] ?? "";
  s = s.split(":")[0] ?? "";
  if (!s.includes(".")) return null;
  const labels = s.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  // Multi-part ccTLD: keep last 3 labels if the last 2 form a known
  // public suffix (e.g., `shop.example.co.uk` → `example.co.uk`).
  if (labels.length >= 3) {
    const lastTwo = labels.slice(-2).join(".");
    if (MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo)) {
      return labels.slice(-3).join(".");
    }
  }
  return labels.slice(-2).join(".");
}
