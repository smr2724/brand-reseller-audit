/**
 * Phase 47 — Module 3 hook utilities.
 *
 * Centralizes the rules for "should this hook render?" so the web and
 * PDF renderers stay in lockstep.
 *
 *   - Hook sections only render when the hook is present in
 *     `narrative.qualification.hooks` AND its `confidence >= 0.6`.
 *   - Tight-channel reports skip ALL hook sections (these are
 *     opportunity-mode-only).
 *   - Hook copy that names a seller MUST filter via the Phase 46
 *     `getResellerSellers` helper. The dominant_single_reseller hook
 *     uses `findResellerByName` below to reject any LLM-named seller
 *     that the user has classified as brand_owned / authorized / amazon.
 */
import type { NarrativeQualification, NarrativeV2 } from "./types";
import {
  getResellerSellers,
  type ClassifiableSellerRow,
} from "./snapshot-derive";
import type { DerivedSnapshot } from "./snapshot-derive";

export const HOOK_CONFIDENCE_FLOOR = 0.6;

export type ReportHookCode =
  | "anti_amazon_policy_violation"
  | "trademark_split"
  | "dominant_single_reseller"
  | "geographic_diversion";

export interface ReportHook {
  hook_code: string;
  hook_text: string;
  evidence: string;
  confidence: number;
}

/**
 * Returns the highest-confidence hook with the given code, but only
 * when its confidence clears the floor and the report layout is the
 * full opportunity layout (i.e. NOT tight-channel). Used by both web
 * and PDF renderers — never call hook copy without going through this.
 */
export function pickHook(
  qualification: NarrativeQualification | null | undefined,
  code: ReportHookCode,
  isTightChannel: boolean,
): ReportHook | null {
  if (!qualification) return null;
  if (isTightChannel) return null;
  const hooks = Array.isArray(qualification.hooks) ? qualification.hooks : [];
  let best: ReportHook | null = null;
  for (const h of hooks) {
    if (!h || h.hook_code !== code) continue;
    const conf = typeof h.confidence === "number" ? h.confidence : 0;
    if (conf < HOOK_CONFIDENCE_FLOOR) continue;
    if (!best || conf > best.confidence) {
      best = {
        hook_code: h.hook_code,
        hook_text: String(h.hook_text ?? ""),
        evidence: String(h.evidence ?? ""),
        confidence: conf,
      };
    }
  }
  return best;
}

/**
 * Phase 46 — Find a reseller in the live snapshot whose name is a
 * substring match for any token in the LLM-generated hook text or
 * evidence. Returns null when no match exists OR the matched seller is
 * brand-controlled (prevents naming a brand_owned / authorized seller
 * as a reseller in any hook copy).
 */
export function findResellerByName<T extends ClassifiableSellerRow>(
  hook: ReportHook,
  sellers: T[] | null | undefined,
): T | null {
  if (!hook) return null;
  const haystack = `${hook.hook_text} ${hook.evidence}`.toLowerCase();
  const resellers = getResellerSellers(sellers);
  // Sort by name length desc — longer names first so "Acme Distribution"
  // matches before bare "Acme".
  const sorted = [...resellers].sort(
    (a, b) =>
      (b.seller_name?.length ?? 0) - (a.seller_name?.length ?? 0),
  );
  for (const s of sorted) {
    const n = (s.seller_name ?? "").trim().toLowerCase();
    if (n.length < 3) continue;
    if (haystack.includes(n)) return s;
  }
  return null;
}

/**
 * Returns true when the renderer should skip ALL hook sections (tight-
 * channel layout). Phase 46 hard rule: tight reports never render
 * opportunity-style hook callouts.
 */
export function shouldRenderHooks(
  narrative: NarrativeV2,
  derived: DerivedSnapshot,
): boolean {
  if (derived.is_tight_channel) return false;
  if (!narrative.qualification) return false;
  const hooks = Array.isArray(narrative.qualification.hooks)
    ? narrative.qualification.hooks
    : [];
  return hooks.some(
    (h) => typeof h?.confidence === "number" && h.confidence >= HOOK_CONFIDENCE_FLOOR,
  );
}
