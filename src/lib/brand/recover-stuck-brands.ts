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
import { maybeTriggerQualification } from "@/lib/qualification/triggers";
import { runQualification } from "@/lib/qualification/orchestrate";
import { runContactDiscovery } from "@/lib/contacts/orchestrate";

export interface StuckBrand {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  enrichment_state?: string | null;
  /** Phase 47 — when set, the recovery sweep will re-run the matching
   *  Phase-47 module instead of Keepa enrichment. `null` (the default)
   *  means "stuck on enrichment_state = pending|failed|enriching" and
   *  the legacy enrichment-recovery path applies. */
  stuck_module?: "qualification" | "contacts" | null;
}

export const STUCK_BRAND_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
export const RECOVERY_BRAND_BATCH_LIMIT = 5;
export const TOKEN_BUDGET_FLOOR = 50;
/**
 * Phase 45 — A brand whose lambda died mid-flight will sit in
 * `enrichment_state='enriching'` forever otherwise. After this many
 * minutes since `updated_at`, treat it as stuck and let recovery
 * pick it up. Threshold is high enough that we don't fight a healthy
 * in-progress enrichment (Keepa enrichment runs typically finish in
 * 1–9 minutes; the create-from-lookup route's `maxDuration` is 300s).
 */
export const STUCK_ENRICHING_THRESHOLD_MIN = 10;
export const STUCK_ENRICHING_THRESHOLD_MS = STUCK_ENRICHING_THRESHOLD_MIN * 60 * 1000;
/** States the recovery sweep is allowed to touch unconditionally.
 * `enriching` is also recoverable but only when `updated_at` is older
 * than `STUCK_ENRICHING_THRESHOLD_MIN` — see `RECOVERABLE_ENRICHING_STATE`
 * and `isEnrichingRecoverable`. `deferred` requires explicit `force` from
 * the admin route. `enriched`/`queued` are never picked up by the cron. */
export const RECOVERABLE_STATES = ["pending", "failed"] as const;
export const RECOVERABLE_ENRICHING_STATE = "enriching" as const;

/**
 * Phase 45 — true when an `enriching` brand has been sitting past
 * `updated_at` longer than the threshold (i.e. the lambda almost
 * certainly died mid-flight and nobody is going to finish it).
 */
export function isEnrichingRecoverable(updatedAt: string | null | undefined): boolean {
  if (!updatedAt) return false;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t >= STUCK_ENRICHING_THRESHOLD_MS;
}

export async function findStuckBrands(
  admin: SupabaseClient,
  thresholdMs: number = STUCK_BRAND_THRESHOLD_MS,
  limit: number = RECOVERY_BRAND_BATCH_LIMIT,
): Promise<StuckBrand[]> {
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();
  const enrichingCutoff = new Date(Date.now() - STUCK_ENRICHING_THRESHOLD_MS).toISOString();

  const [pendingFailedRes, enrichingRes, qualRunningRes, contactsRunningRes] =
    await Promise.all([
      admin
        .from("brands")
        .select("id, user_id, name, created_at, enrichment_state")
        .in("enrichment_state", RECOVERABLE_STATES as unknown as string[])
        .lte("created_at", cutoff)
        .order("created_at", { ascending: true })
        .limit(limit),
      // Phase 45 — also pick up brands stuck in `enriching` whose
      // `updated_at` (last state transition) is older than the threshold.
      admin
        .from("brands")
        .select("id, user_id, name, created_at, enrichment_state")
        .eq("enrichment_state", RECOVERABLE_ENRICHING_STATE)
        .lte("updated_at", enrichingCutoff)
        .order("updated_at", { ascending: true })
        .limit(limit),
      // Phase 47 — pick up qualification-stuck rows, same threshold.
      admin
        .from("brands")
        .select("id, user_id, name, created_at, enrichment_state, qualification_state")
        .eq("qualification_state", "running")
        .lte("updated_at", enrichingCutoff)
        .order("updated_at", { ascending: true })
        .limit(limit),
      // Phase 47 — pick up contact-discovery-stuck rows.
      admin
        .from("brands")
        .select("id, user_id, name, created_at, enrichment_state, contacts_state")
        .eq("contacts_state", "running")
        .lte("updated_at", enrichingCutoff)
        .order("updated_at", { ascending: true })
        .limit(limit),
    ]);

  if (pendingFailedRes.error) {
    console.error("[recover-brands] findStuckBrands (pending|failed) error", pendingFailedRes.error);
  }
  if (enrichingRes.error) {
    console.error("[recover-brands] findStuckBrands (enriching) error", enrichingRes.error);
  }
  if (qualRunningRes.error) {
    console.error(
      "[recover-brands] findStuckBrands (qualification:running) error",
      qualRunningRes.error,
    );
  }
  if (contactsRunningRes.error) {
    console.error(
      "[recover-brands] findStuckBrands (contacts:running) error",
      contactsRunningRes.error,
    );
  }

  const tagged: StuckBrand[] = [
    ...((pendingFailedRes.data ?? []) as StuckBrand[]).map((b) => ({
      ...b,
      stuck_module: null,
    })),
    ...((enrichingRes.data ?? []) as StuckBrand[]).map((b) => ({
      ...b,
      stuck_module: null,
    })),
    ...((qualRunningRes.data ?? []) as StuckBrand[]).map((b) => ({
      ...b,
      stuck_module: "qualification" as const,
    })),
    ...((contactsRunningRes.data ?? []) as StuckBrand[]).map((b) => ({
      ...b,
      stuck_module: "contacts" as const,
    })),
  ];
  // De-dupe by id (defensive — the four queries are disjoint by state).
  const seen = new Set<string>();
  const out: StuckBrand[] = [];
  for (const b of tagged) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    out.push(b);
    if (out.length >= limit) break;
  }
  return out;
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
  // Phase 47 — Module-aware recovery. When the brand is wedged in
  // qualification_state='running' or contacts_state='running' past the
  // threshold, re-run the matching Phase-47 module instead of touching
  // Keepa enrichment. Same force:true semantics as the legacy admin
  // override path.
  if (brand.stuck_module === "qualification") {
    try {
      const r = await runQualification(brand.id, { force: true });
      return {
        brand_id: brand.id,
        status: r.ok ? "recovered" : "failed",
        error: r.error,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { brand_id: brand.id, status: "failed", error: msg };
    }
  }
  if (brand.stuck_module === "contacts") {
    try {
      const r = await runContactDiscovery(brand.id);
      return {
        brand_id: brand.id,
        status: r.ok ? "recovered" : "failed",
        error: r.error,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { brand_id: brand.id, status: "failed", error: msg };
    }
  }
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
    // Phase 47 — also fire qualification (Module 1).
    maybeTriggerOwnerResolution(brand.id);
    maybeTriggerQualification(brand.id);
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
