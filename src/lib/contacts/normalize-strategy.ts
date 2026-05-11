/**
 * Phase 69 — Phase 67-style enum clamp for `contact_strategies` writes.
 *
 * The migration enforces:
 *   company_size_tier ∈ {micro, small, mid, enterprise}
 *   verdict           ∈ {ready, needs_human_review, error}
 *
 * If upstream code drifts (LLM hallucinated a label, a future refactor
 * emits "medium" instead of "mid", etc.) we clamp to a safe fallback
 * rather than crashing the INSERT with a CHECK violation. Mirrors
 * `src/lib/qualification/normalize.ts`.
 */
import type { CompanySizeTier, StrategyVerdict } from "./strategy-types";

const TIERS: ReadonlyArray<CompanySizeTier> = ["micro", "small", "mid", "enterprise"];
const VERDICTS: ReadonlyArray<StrategyVerdict> = [
  "ready",
  "needs_human_review",
  "error",
];

function coerce(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.toLowerCase().replace(/\s+/g, "_");
}

export function normalizeCompanySizeTier(
  raw: string | null | undefined,
): { value: CompanySizeTier; originalIfClamped: string | null } {
  const candidate = coerce(raw);
  if (candidate && (TIERS as ReadonlyArray<string>).includes(candidate)) {
    return { value: candidate as CompanySizeTier, originalIfClamped: null };
  }
  return { value: "small", originalIfClamped: raw ? String(raw) : null };
}

export function normalizeStrategyVerdict(
  raw: string | null | undefined,
): { value: StrategyVerdict; originalIfClamped: string | null } {
  const candidate = coerce(raw);
  if (candidate && (VERDICTS as ReadonlyArray<string>).includes(candidate)) {
    return { value: candidate as StrategyVerdict, originalIfClamped: null };
  }
  return { value: "needs_human_review", originalIfClamped: raw ? String(raw) : null };
}
