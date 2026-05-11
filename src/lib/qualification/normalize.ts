/**
 * Phase 67 — Clamp LLM-emitted enum values to the CHECK-constraint
 * whitelists on `brand_qualifications`.
 *
 * The LLM occasionally returns labels outside the canonical enum
 * (e.g. `private_label`, `small_business`) which would otherwise trip
 * the Postgres check constraint and crash the INSERT. We normalize on
 * the write path rather than widening the schema, and append a
 * transparency note to the qualification row's free-text reasoning so
 * the original LLM string is preserved for audit.
 *
 * Whitelists mirror the migrations:
 *   - disqualification_pattern → 0040 + 0042
 *   - legal_entity_type        → 0040
 *   - ownership_signal         → 0040
 *   - icp_verdict              → 0040
 */

export interface NormalizeResult<T extends string> {
  /** Whitelisted value to persist (may be null when input was null/empty). */
  value: T | null;
  /** Original raw LLM string when it was clamped to the fallback. Null when
   *  the input was null/empty, or already in the whitelist. */
  originalIfClamped: string | null;
}

function coerce(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.toLowerCase().replace(/\s+/g, "_");
}

function normalizeEnum<T extends string>(
  raw: string | null | undefined,
  allowed: ReadonlySet<T>,
  fallback: T,
): NormalizeResult<T> {
  if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
    return { value: null, originalIfClamped: null };
  }
  const candidate = coerce(raw);
  if (candidate && (allowed as ReadonlySet<string>).has(candidate)) {
    return { value: candidate as T, originalIfClamped: null };
  }
  return { value: fallback, originalIfClamped: String(raw) };
}

const ALLOWED_DISQUAL_PATTERNS = new Set<
  | "public_company"
  | "dealer_network"
  | "anti_amazon"
  | "enterprise"
  | "subsidiary_of_giant"
  | "no_amazon_presence"
  | "brand_self_managed"
  | "other"
>([
  "public_company",
  "dealer_network",
  "anti_amazon",
  "enterprise",
  "subsidiary_of_giant",
  "no_amazon_presence",
  "brand_self_managed",
  "other",
]);

export function normalizeDisqualificationPattern(
  raw: string | null | undefined,
): NormalizeResult<
  | "public_company"
  | "dealer_network"
  | "anti_amazon"
  | "enterprise"
  | "subsidiary_of_giant"
  | "no_amazon_presence"
  | "brand_self_managed"
  | "other"
> {
  return normalizeEnum(raw, ALLOWED_DISQUAL_PATTERNS, "other");
}

const ALLOWED_LEGAL_ENTITY_TYPES = new Set<
  "individual" | "corporation" | "llc" | "subsidiary" | "partnership" | "unknown"
>([
  "individual",
  "corporation",
  "llc",
  "subsidiary",
  "partnership",
  "unknown",
]);

export function normalizeLegalEntityType(
  raw: string | null | undefined,
): NormalizeResult<
  "individual" | "corporation" | "llc" | "subsidiary" | "partnership" | "unknown"
> {
  return normalizeEnum(raw, ALLOWED_LEGAL_ENTITY_TYPES, "unknown");
}

const ALLOWED_OWNERSHIP_SIGNALS = new Set<
  "owner_operated" | "pe_owned" | "public" | "subsidiary" | "unknown"
>(["owner_operated", "pe_owned", "public", "subsidiary", "unknown"]);

export function normalizeOwnershipSignal(
  raw: string | null | undefined,
): NormalizeResult<
  "owner_operated" | "pe_owned" | "public" | "subsidiary" | "unknown"
> {
  return normalizeEnum(raw, ALLOWED_OWNERSHIP_SIGNALS, "unknown");
}

const ALLOWED_ICP_VERDICTS = new Set<
  "qualified" | "disqualified" | "needs_review"
>(["qualified", "disqualified", "needs_review"]);

export function normalizeIcpVerdict(
  raw: string | null | undefined,
): NormalizeResult<"qualified" | "disqualified" | "needs_review"> {
  return normalizeEnum(raw, ALLOWED_ICP_VERDICTS, "needs_review");
}

/**
 * Builds the transparency line for selection_reasoning when a clamp fired.
 * Format mirrors the Phase 67 spec.
 */
export function clampNote(
  field: string,
  originalIfClamped: string,
  clampedTo: string,
): string {
  const safeOriginal = originalIfClamped.length > 200
    ? originalIfClamped.slice(0, 200) + "…"
    : originalIfClamped;
  return `[${field} normalized] LLM returned "${safeOriginal}"; clamped to "${clampedTo}".`;
}
