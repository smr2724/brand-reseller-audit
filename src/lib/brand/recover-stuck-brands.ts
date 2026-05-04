/**
 * Phase 29 — Stuck-brand recovery helper.
 * Phase 30 — Filter by `enrichment_state IN ('pending','failed')` instead
 * of the legacy `keepa_last_enriched_at IS NULL` heuristic. The legacy
 * filter swept up 155 SmartScout-imported "library" brands the user never
 * intended to scan, exhausting Keepa tokens. Now those rows carry
 * `enrichment_state='deferred'` and are skipped here entirely.
 *
 * Also adds a hard token-budget gate: callers can ask
 * `shouldSkipForTokenBudget()` to bail before touching Keepa/DB when
 * available tokens are below a floor.
 *
 * Mirrors the Phase 21 stuck-report recovery pattern.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { enrichBrandWithKeepa } from "@/lib/enrichment/keepa-brand";
import { getKeepaTokenStatus } from "@/lib/keepa";
import { maybeTriggerOwnerResolution } from "@/lib/owner-resolver/triggers";

export interface StuckBrand {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  enrichment_state?: string | null;
}

export const STUCK_BRAND_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
export const RECOVERY_BRAND_BATCH_LIMIT = 5;
export const TOKEN_BUDGET_FLOOR = 50;
/** States the recovery sweep is allowed to touch. `deferred` and
 * `enriched`/`enriching`/`queued` are never picked up by the cron. */
export const RECOVERABLE_STATES = ["pending", "failed"] as const;

export async function findStuckBrands(
  admin: SupabaseClient,
  thresholdMs: number = STUCK_BRAND_THRESHOLD_MS,
  limit: number = RECOVERY_BRAND_BATCH_LIMIT,
): Promise<StuckBrand[]> {
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();
  const { data, error } = await admin
    .from("brands")
    .select("id, user_id, name, created_at, enrichment_state")
    .in("enrichment_state", RECOVERABLE_STATES as unknown as string[])
    .lte("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("[recover-brands] findStuckBrands error", error);
    return [];
  }
  return (data ?? []) as StuckBrand[];
}

export interface RecoverBrandResult {
  brand_id: string;
  status: "recovered" | "failed";
  asin_count?: number;
  error?: string;
}

/**
 * Transition `enrichment_state` for a brand. We never touch rows that are
 * `deferred` from this helper — the caller has already verified the state
 * before calling enrichment.
 */
async function setBrandState(
  admin: SupabaseClient,
  brandId: string,
  state: "enriching" | "enriched" | "failed" | "pending",
): Promise<void> {
  const { error } = await admin
    .from("brands")
    .update({ enrichment_state: state, updated_at: new Date().toISOString() })
    .eq("id", brandId);
  if (error) {
    console.warn("[recover-brands] setBrandState failed", { brandId, state, error: error.message });
  }
}

export async function recoverStuckBrand(
  admin: SupabaseClient,
  brand: StuckBrand,
): Promise<RecoverBrandResult> {
  await setBrandState(admin, brand.id, "enriching");
  try {
    const summary = await enrichBrandWithKeepa(admin, {
      brand_id: brand.id,
      brand_name: brand.name,
      user_id: brand.user_id,
    });
    // enrichBrandWithKeepa may return a "no ASINs" summary without throwing.
    // Treat that as a soft failure so the cron backs off (otherwise we'd
    // re-enrich the same dead-end brand every 5 min).
    if (summary.enrichment_error) {
      await setBrandState(admin, brand.id, "failed");
      return {
        brand_id: brand.id,
        status: "failed",
        asin_count: summary.asin_count,
        error: summary.enrichment_error,
      };
    }
    await setBrandState(admin, brand.id, "enriched");
    // Phase 33 — fire owner resolver as a non-blocking follow-up.
    maybeTriggerOwnerResolution(brand.id);
    return {
      brand_id: brand.id,
      status: "recovered",
      asin_count: summary.asin_count,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setBrandState(admin, brand.id, "failed");
    return { brand_id: brand.id, status: "failed", error: msg };
  }
}

/**
 * Hard token-budget gate. Returns `{ skip: true, ... }` when Keepa says
 * we have fewer than `floor` tokens left. The cron uses this to bail
 * out of an entire run before touching the DB or starting any enrichment.
 * Soft-fails open (returns `skip: false`) when the token endpoint itself
 * errors — we don't want a Keepa /token outage to wedge recovery forever.
 */
export async function shouldSkipForTokenBudget(
  floor: number = TOKEN_BUDGET_FLOOR,
): Promise<{ skip: boolean; tokens_left: number | null; reason?: string }> {
  try {
    const status = await getKeepaTokenStatus(true);
    if (status.tokens_left < floor) {
      return { skip: true, tokens_left: status.tokens_left, reason: "token_budget" };
    }
    return { skip: false, tokens_left: status.tokens_left };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[recover-brands] token status check failed (continuing)", msg);
    return { skip: false, tokens_left: null };
  }
}
