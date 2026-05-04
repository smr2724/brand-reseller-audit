/**
 * Phase 33 — Deterministic heuristic scoring for owner candidates.
 *
 * No LLM. Rules from the Phase 33 spec; documented inline. Used to rank
 * candidates in the admin UI and decide which need manual review. Final
 * selection is always done by the user.
 */
import type {
  BrandContext,
  HeuristicLabel,
  RawOwnerCandidate,
  ScoredOwnerCandidate,
} from "./types";

const B2B_KEYWORDS = [
  "wholesale",
  "distributor",
  "manufacturer",
  "b2b",
  "minimum order",
  "case pack",
  "bulk",
];

const LAW_FIRM_PATTERNS = [
  /legalzoom/i,
  /\.law(\b|\.)/i,
  /attorneys?\.com/i,
  /legal\.com/i,
  /gerbenlaw/i,
  /trademarkengine/i,
  /trademarkfactory/i,
  /trademarkia/i,
];

// Reseller/distributor pattern list — start empty per spec; populate as
// we observe noise patterns in production.
const RESELLER_PATTERNS: RegExp[] = [];

const DEAD_TRADEMARK_STATUSES = ["DEAD", "ABANDONED", "CANCELLED", "EXPIRED"];

// US state codes + DC (M8 — strict allow-list to defeat false-positives
// like "PO" / "RR" matching as 2-letter tokens).
export const US_STATE_CODES: ReadonlySet<string> = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
  "DC",
]);

interface ScoringContext {
  brand: BrandContext;
  /** All candidates from this resolver run — used to detect multi-query
   * overlap and conflicting-trademark-owner signals. */
  allCandidates: ReadonlyArray<RawOwnerCandidate>;
  /** Pre-computed flag: are there ≥2 LIVE USPTO registrations whose owner
   * names disagree? Same flag is applied to every candidate (per spec). */
  conflictingTrademarkOwners: boolean;
  /** Map of domain → set of distinct queries that surfaced it. */
  domainQueryHits: ReadonlyMap<string, ReadonlySet<string>>;
}

function tokenize(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function tokenOverlap(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const ta = new Set(tokenize(a));
  const tb = tokenize(b);
  let n = 0;
  for (const t of tb) {
    if (ta.has(t)) n += 1;
  }
  return n;
}

function anyProductOverlap(name: string, products: string[]): boolean {
  const tokens = new Set(tokenize(name));
  for (const title of products) {
    for (const t of tokenize(title)) {
      if (tokens.has(t)) return true;
    }
  }
  return false;
}

function hasCategoryMatch(
  candidate: RawOwnerCandidate,
  category: string | null,
): boolean {
  if (!category) return false;
  const haystack = [
    candidate.goods_services_text ?? "",
    candidate.evidence_text ?? "",
  ]
    .join(" ")
    .toLowerCase();
  if (!haystack) return false;
  for (const t of tokenize(category)) {
    if (haystack.includes(t)) return true;
  }
  return false;
}

function hasB2BLanguage(snippet: string | null): boolean {
  if (!snippet) return false;
  const lower = snippet.toLowerCase();
  return B2B_KEYWORDS.some((k) => lower.includes(k));
}

function isLawFirmDomain(domain: string | null): boolean {
  if (!domain) return false;
  return LAW_FIRM_PATTERNS.some((re) => re.test(domain));
}

function isResellerPattern(domain: string | null): boolean {
  if (!domain) return false;
  return RESELLER_PATTERNS.some((re) => re.test(domain));
}

/**
 * Extract a US state code from a US-style address. M8 fix: only return a
 * code present in US_STATE_CODES so generic 2-letter tokens like "PO"
 * (PO Box), "RR" (Rural Route), "BR" don't get mis-labelled as states.
 * Pattern requires the 2-letter token to immediately precede a 5-digit
 * ZIP code so we don't match arbitrary capitalised words.
 */
export function extractStateFromAddress(address: string | null): string | null {
  if (!address) return null;
  const m = address.match(/\b([A-Z]{2})\b\s+\d{5}(?:-\d{4})?\b/);
  if (!m) return null;
  const code = m[1] ?? "";
  return US_STATE_CODES.has(code) ? code : null;
}

function buildContext(
  brand: BrandContext,
  candidates: ReadonlyArray<RawOwnerCandidate>,
): ScoringContext {
  const ownerNames = new Set<string>();
  for (const c of candidates) {
    if (c.candidate_source !== "uspto") continue;
    if (c.trademark_status && c.trademark_status.toUpperCase().includes("LIVE")) {
      ownerNames.add(c.candidate_company_name.trim().toLowerCase());
    }
  }
  const conflictingTrademarkOwners = ownerNames.size >= 2;

  const domainQueryHits = new Map<string, Set<string>>();
  for (const c of candidates) {
    if (!c.candidate_domain) continue;
    const dom = c.candidate_domain.toLowerCase();
    const set = domainQueryHits.get(dom) ?? new Set<string>();
    if (
      c.raw_payload &&
      typeof c.raw_payload === "object" &&
      Array.isArray((c.raw_payload as any).queries_for_domain)
    ) {
      for (const q of (c.raw_payload as any).queries_for_domain as unknown[]) {
        if (typeof q === "string") set.add(q);
      }
    } else if (
      c.raw_payload &&
      typeof c.raw_payload === "object" &&
      typeof (c.raw_payload as any).query === "string"
    ) {
      set.add((c.raw_payload as any).query);
    }
    domainQueryHits.set(dom, set);
  }

  return { brand, allCandidates: candidates, conflictingTrademarkOwners, domainQueryHits };
}

function labelFor(score: number): HeuristicLabel {
  if (score >= 90) return "very_high";
  if (score >= 75) return "high";
  if (score >= 55) return "medium";
  return "needs_review";
}

/** Score a single candidate. Exposed for unit testing in isolation. */
export function scoreCandidate(
  candidate: RawOwnerCandidate,
  ctx: ScoringContext,
): ScoredOwnerCandidate {
  let score = 0;

  const status = (candidate.trademark_status ?? "").toUpperCase();
  if (
    candidate.candidate_source === "uspto" &&
    status.includes("LIVE")
  ) {
    score += 35;
  }

  if (
    candidate.candidate_source === "web_search" &&
    candidate.candidate_domain
  ) {
    score += 25;
  }

  // Multi-query overlap: ≥2 distinct queries surfaced this domain.
  if (candidate.candidate_domain) {
    const hits = ctx.domainQueryHits.get(candidate.candidate_domain.toLowerCase());
    if (hits && hits.size >= 2) score += 20;
  }

  const categoryMatch = hasCategoryMatch(candidate, ctx.brand.category);
  if (categoryMatch) {
    score += 15;
  }

  if (hasB2BLanguage(candidate.evidence_text)) {
    score += 10;
  }

  const productMatch = anyProductOverlap(
    candidate.candidate_company_name,
    ctx.brand.product_titles,
  );
  if (productMatch) {
    score += 10;
  }

  // Address-consistency proxy: if this is a USPTO candidate with a state
  // and there's a web candidate whose snippet mentions the same state.
  if (candidate.candidate_source === "uspto") {
    const state = extractStateFromAddress(candidate.trademark_owner_address);
    if (state) {
      for (const other of ctx.allCandidates) {
        if (other === candidate) continue;
        if (other.candidate_source !== "web_search") continue;
        const ev = (other.evidence_text ?? "").toUpperCase();
        if (
          ev.includes(`, ${state} `) ||
          ev.includes(`, ${state}.`) ||
          ev.includes(` ${state} `) ||
          ev.endsWith(` ${state}`)
        ) {
          score += 5;
          break;
        }
      }
    }
  }

  // -- Penalties --
  if (status && DEAD_TRADEMARK_STATUSES.some((d) => status.includes(d))) {
    score -= 20;
  }

  if (isLawFirmDomain(candidate.candidate_domain)) {
    score -= 15;
  }

  if (isResellerPattern(candidate.candidate_domain)) {
    score -= 15;
  }

  // M3 fix: only apply the category-mismatch penalty when the brand has a
  // category to compare against. Null category = no signal, not negative.
  if (
    ctx.brand.category != null &&
    !categoryMatch &&
    !productMatch
  ) {
    score -= 10;
  }

  if (
    candidate.candidate_source === "web_search" &&
    !candidate.candidate_domain
  ) {
    score -= 10;
  }

  if (
    ctx.conflictingTrademarkOwners &&
    candidate.candidate_source === "uspto"
  ) {
    score -= 10;
  }

  const label = labelFor(score);
  return {
    ...candidate,
    heuristic_score: score,
    heuristic_label: label,
    needs_manual_review: score < 55,
  };
}

/**
 * Score every candidate in `candidates` using `brand` context. Returns a
 * new array; never mutates inputs. Order is preserved (ranking happens
 * at the call site / DB query).
 */
export function scoreCandidates(
  candidates: ReadonlyArray<RawOwnerCandidate>,
  brand: BrandContext,
): ScoredOwnerCandidate[] {
  const ctx = buildContext(brand, candidates);
  return candidates.map((c) => scoreCandidate(c, ctx));
}

// Token utilities are exposed only for tests.
export const __testing = { tokenize, tokenOverlap, labelFor };
