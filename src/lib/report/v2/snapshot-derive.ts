/**
 * Phase 40 — Derive a classification-aware view of the report from the
 * persisted `reports.seller_classifications` snapshot + four
 * `*_share_pct` columns.
 *
 * The snapshot is captured by the SellerClassificationModal at report-
 * generation time (Phase 39). When present, it is the source of truth
 * for who is a reseller vs brand-controlled vs authorized vs Amazon —
 * the legacy keepa name-overlap heuristic ("if seller_name contains
 * brand_name, it's brand_controlled") misclassifies the brand owner's
 * own LLC when the names diverge (e.g. Diversified Hospitality
 * Solutions selling Terra Pure inventory).
 *
 * Legacy reports (pre-Phase-39) have no snapshot. We fall back to
 * `bundle.keepa.brand_controlled_pct` (which itself derives from
 * `brand_sellers.is_brand_controlled` aggregated by share). The
 * non_reseller_share is treated as brand-owned for the 4-bucket bar so
 * the renderer never crashes.
 */
import type { ResellerRow } from "./types";

/**
 * Phase 41a — Threshold constants for the short / tight-channel report
 * layout. Centralised so both the tight-channel decision in the
 * renderer and any backend caller use the same numbers.
 *
 * A brand qualifies for the short layout when the persisted
 * classification snapshot shows reseller share < 5% AND brand-owned +
 * authorized share >= 90%. Legacy reports without a snapshot do NOT
 * qualify (the renderer falls through to the long opportunity layout).
 */
export const TIGHT_CHANNEL_THRESHOLDS = {
  /** Maximum reseller share (0-1) for the channel to count as tight. */
  max_reseller_share: 0.05,
  /** Minimum brand-owned + authorized share (0-1). */
  min_controlled_share: 0.9,
} as const;

export type EffectiveClassification =
  | "brand_owned"
  | "authorized"
  | "amazon"
  | "reseller";

export interface SellerClassificationSnapshotEntry {
  seller_id?: string | null;
  seller_name?: string | null;
  share_pct?: number | null;
  asins_won?: number | null;
  is_fba?: boolean | null;
  classification: EffectiveClassification | string;
}

export interface ClassificationSnapshotShares {
  brand_owned: number;
  authorized: number;
  amazon: number;
  reseller: number;
  /** True when the snapshot drives these numbers. False when we fell
   * back to the legacy keepa_brand_controlled_pct heuristic. */
  has_snapshot: boolean;
}

export interface DerivedSnapshot {
  /** Map seller key -> effective classification. Key is preferentially
   * `seller_id` (matches Keepa rows), falls back to a normalized name. */
  classification_by_key: Map<string, EffectiveClassification>;
  /** The four-bucket share split for the buy-box bar. */
  shares: ClassificationSnapshotShares;
  /** Combined non-reseller share (brand_owned + authorized + amazon).
   * This is the "channel-controlled" slice for tight-channel detection
   * and should match what `legion-economics` consumes. */
  non_reseller_share: number;
  /** Total reseller share. `1 - non_reseller_share` modulo rounding. */
  reseller_share: number;
  /** UI hints derived from the shares. */
  is_tight_channel: boolean;
  is_strongly_controlled: boolean;
}

const VALID: ReadonlySet<EffectiveClassification> = new Set<EffectiveClassification>([
  "brand_owned",
  "authorized",
  "amazon",
  "reseller",
]);

function normalizeKey(idOrName: string | null | undefined): string | null {
  if (!idOrName) return null;
  return String(idOrName).trim().toLowerCase();
}

function classifyEntry(
  raw: string | null | undefined,
): EffectiveClassification {
  if (raw && VALID.has(raw as EffectiveClassification)) {
    return raw as EffectiveClassification;
  }
  return "reseller";
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Build the derived view from the four share columns + snapshot rows.
 * `share_pcts` come from `reports.brand_owned_share_pct` etc; pass null
 * for legacy rows. `snapshot` is the persisted `seller_classifications`
 * jsonb. `legacyBrandControlledPct` is the keepa fallback (0..1).
 */
export function deriveSnapshot(args: {
  share_pcts: {
    brand_owned: number | null;
    authorized: number | null;
    amazon: number | null;
    reseller: number | null;
  };
  snapshot: SellerClassificationSnapshotEntry[] | null;
  legacyBrandControlledPct: number | null;
}): DerivedSnapshot {
  const classification_by_key = new Map<string, EffectiveClassification>();

  if (Array.isArray(args.snapshot)) {
    for (const entry of args.snapshot) {
      if (!entry) continue;
      const cls = classifyEntry(
        typeof entry.classification === "string" ? entry.classification : null,
      );
      const idKey = normalizeKey(entry.seller_id ?? null);
      const nameKey = normalizeKey(entry.seller_name ?? null);
      if (idKey) classification_by_key.set(`id:${idKey}`, cls);
      if (nameKey) classification_by_key.set(`name:${nameKey}`, cls);
    }
  }

  // Prefer the persisted share_pct columns when present.
  const haveCols =
    args.share_pcts.brand_owned != null ||
    args.share_pcts.authorized != null ||
    args.share_pcts.amazon != null ||
    args.share_pcts.reseller != null;

  let shares: ClassificationSnapshotShares;
  if (haveCols) {
    shares = {
      brand_owned: clamp01(Number(args.share_pcts.brand_owned ?? 0)),
      authorized: clamp01(Number(args.share_pcts.authorized ?? 0)),
      amazon: clamp01(Number(args.share_pcts.amazon ?? 0)),
      reseller: clamp01(Number(args.share_pcts.reseller ?? 0)),
      has_snapshot: true,
    };
  } else if (Array.isArray(args.snapshot) && args.snapshot.length > 0) {
    // Snapshot present but no persisted columns — aggregate live.
    let bo = 0, au = 0, am = 0, re = 0, total = 0;
    for (const entry of args.snapshot) {
      const share = typeof entry.share_pct === "number" ? entry.share_pct : 0;
      if (share <= 0) continue;
      total += share;
      const cls = classifyEntry(
        typeof entry.classification === "string" ? entry.classification : null,
      );
      if (cls === "brand_owned") bo += share;
      else if (cls === "authorized") au += share;
      else if (cls === "amazon") am += share;
      else re += share;
    }
    if (total > 0) {
      shares = {
        brand_owned: clamp01(bo / total),
        authorized: clamp01(au / total),
        amazon: clamp01(am / total),
        reseller: clamp01(re / total),
        has_snapshot: true,
      };
    } else {
      shares = legacyShares(args.legacyBrandControlledPct);
    }
  } else {
    shares = legacyShares(args.legacyBrandControlledPct);
  }

  const non_reseller_share = clamp01(
    shares.brand_owned + shares.authorized + shares.amazon,
  );
  const reseller_share = clamp01(shares.reseller);

  // Phase 41a — tight-channel detection requires a real snapshot. We
  // do NOT enter the short layout for legacy reports that fall back to
  // the keepa heuristic, since the heuristic can mis-bucket the brand's
  // own LLC and silently flip a recovery report into a benchmark one.
  // Brand_owned + authorized only (per spec) — Amazon retail counts as
  // non-reseller for the bar but not for the tight-channel decision.
  const brand_plus_authorized = clamp01(
    shares.brand_owned + shares.authorized,
  );
  const is_tight_channel =
    shares.has_snapshot &&
    reseller_share < TIGHT_CHANNEL_THRESHOLDS.max_reseller_share &&
    brand_plus_authorized >= TIGHT_CHANNEL_THRESHOLDS.min_controlled_share;

  return {
    classification_by_key,
    shares,
    non_reseller_share,
    reseller_share,
    is_tight_channel,
    is_strongly_controlled: non_reseller_share >= 0.5,
  };
}

function legacyShares(pct: number | null): ClassificationSnapshotShares {
  // Legacy fallback: collapse the legacy keepa_brand_controlled_pct
  // into the brand_owned bucket. We have no signal to split between
  // brand_owned / authorized / amazon, so the bar still renders as a
  // 2-bucket split visually but uses the 4-bucket rendering codepath.
  const bo = clamp01(pct ?? 0);
  return {
    brand_owned: bo,
    authorized: 0,
    amazon: 0,
    reseller: clamp01(1 - bo),
    has_snapshot: false,
  };
}

/**
 * Look up the effective classification for a single seller row from
 * the snapshot. Returns null when the snapshot is missing or this row
 * is not in it (caller decides the fallback).
 */
export function lookupClassification(
  derived: DerivedSnapshot,
  row: ResellerRow,
): EffectiveClassification | null {
  if (derived.classification_by_key.size === 0) return null;
  const idKey = normalizeKey(row.seller_name)
    ? normalizeKey(`${row.seller_name}`)
    : null;
  // Try by name first (Keepa rows expose seller_name; seller_id only on
  // dossier rows). The snapshot stores BOTH keys when both are known.
  const byName = idKey ? derived.classification_by_key.get(`name:${idKey}`) : null;
  if (byName) return byName;
  // Fall through to legacy is_brand_controlled boolean if present.
  if (row.is_brand_controlled === true) return "brand_owned";
  if (row.is_brand_controlled === false) return "reseller";
  return null;
}

/**
 * Confidence label for a metric. The set is fixed so every label
 * across the report renders consistently; the renderer maps each to a
 * small inline pill. Per spec section 13.
 */
export type ConfidenceLabel = "Low" | "Medium" | "High" | "Assumption-based";

export function confidenceForRevenue(
  badge: "actual" | "estimate" | "confirmed" | null | undefined,
): ConfidenceLabel {
  if (badge === "confirmed" || badge === "actual") return "High";
  if (badge === "estimate") return "Medium";
  return "Medium";
}

export function confidenceForSellerControl(
  derived: DerivedSnapshot,
): ConfidenceLabel {
  return derived.shares.has_snapshot ? "High" : "Medium";
}

export function confidenceForProfitRecapture(
  derived: DerivedSnapshot,
  revenueBadge: "actual" | "estimate" | "confirmed" | null | undefined,
): ConfidenceLabel {
  if (revenueBadge === "confirmed" || revenueBadge === "actual") {
    return derived.shares.has_snapshot ? "High" : "Medium";
  }
  return "Medium";
}

export function confidenceForBusinessValue(): ConfidenceLabel {
  return "Assumption-based";
}
