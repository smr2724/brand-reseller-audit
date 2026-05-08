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
 *
 * Phase 48 — Hardening for silent token-burn regression:
 *   - Phase 47 module imports (runQualification, runContactDiscovery,
 *     maybeTriggerQualification) are lazy-loaded so a module-load failure
 *     can never crash the Keepa recovery path.
 *   - Every Phase-47 call site is individually try/catch'd. An OpenAI/
 *     Apollo/Hunter outage during a follow-up step MUST NOT mask the
 *     enrichment that already succeeded.
 *   - `setBrandState('failed', err)` ALWAYS writes a non-null
 *     `enrichment_error` so the brand row is never left in
 *     `enriching` with `enrichment_error=null` (the "silent burn"
 *     fingerprint that motivated this fix).
 *   - A try/finally backstop guarantees a terminal write (enriched or
 *     failed-with-error) for every brand we set to `enriching`.
 *   - console.error at every catch boundary so token drains are visible
 *     in Vercel logs the next time something goes sideways.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { enrichBrandWithKeepa } from "@/lib/enrichment/keepa-brand";
import { getKeepaTokenStatus } from "@/lib/keepa";

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
 * Transition `enrichment_state` for a brand. Phase 48 — when the new state
 * is `failed`, also write a non-null `enrichment_error` so we can never
 * leave a row at `enriching`/`failed` with `enrichment_error=null` (the
 * silent-burn fingerprint that motivated Phase 48). For non-failed
 * transitions the error column is left untouched.
 */
async function setBrandState(
  admin: SupabaseClient,
  brandId: string,
  state: "enriching" | "enriched" | "failed" | "pending",
  errorMessage?: string,
): Promise<void> {
  const update: Record<string, unknown> = {
    enrichment_state: state,
    updated_at: new Date().toISOString(),
  };
  if (state === "failed") {
    update.enrichment_error = errorMessage && errorMessage.length > 0
      ? errorMessage.slice(0, 500)
      : "stuck-brand recovery failed (no error message captured)";
  }
  const { error } = await admin
    .from("brands")
    .update(update)
    .eq("id", brandId);
  if (error) {
    console.error("[recover-brands] setBrandState failed", {
      brandId,
      state,
      error: error.message,
    });
  }
}

/**
 * Phase 48 — Lazy-load Phase 47 modules. The original Phase 47 patch
 * imported `runQualification`, `runContactDiscovery`, and
 * `maybeTriggerQualification` at module top. If any of those modules
 * (or anything THEY import — OpenAI SDK, Apollo, Hunter, MillionVerifier
 * env-var assertions, `@vercel/functions`, etc.) crashes at module load
 * inside the cron lambda, the entire recovery path dies before the
 * Keepa try/catch can persist a terminal state. By switching to dynamic
 * import inside try/catch we contain that blast radius — a Phase-47
 * module load failure becomes a logged warning, never a stuck-enriching
 * silent-burn loop.
 */
async function lazyRunQualification(
  brandId: string,
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    const mod = await import("@/lib/qualification/orchestrate");
    const r = await mod.runQualification(brandId, opts);
    return { ok: !!r.ok, error: r.error };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[recover-brands] runQualification threw", { brandId, error: msg });
    return { ok: false, error: msg };
  }
}

async function lazyRunContactDiscovery(
  brandId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const mod = await import("@/lib/contacts/orchestrate");
    const r = await mod.runContactDiscovery(brandId);
    return { ok: !!r.ok, error: r.error };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[recover-brands] runContactDiscovery threw", { brandId, error: msg });
    return { ok: false, error: msg };
  }
}

function lazyMaybeTriggerQualification(brandId: string): void {
  // Truly fire-and-forget. Any failure inside the trigger module — or in
  // its module load — is swallowed here so the Keepa recovery's success
  // path can return cleanly to the cron loop.
  import("@/lib/qualification/triggers")
    .then((mod) => {
      try {
        mod.maybeTriggerQualification(brandId);
      } catch (e) {
        console.error("[recover-brands] maybeTriggerQualification threw", {
          brandId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })
    .catch((e: unknown) => {
      console.error("[recover-brands] failed to load qualification triggers", {
        brandId,
        error: e instanceof Error ? e.message : String(e),
      });
    });
}

export async function recoverStuckBrand(
  admin: SupabaseClient,
  brand: StuckBrand,
): Promise<RecoverBrandResult> {
  // Phase 47 — Module-aware recovery. When the brand is wedged in
  // qualification_state='running' or contacts_state='running' past the
  // threshold, re-run the matching Phase-47 module instead of touching
  // Keepa enrichment. Same force:true semantics as the legacy admin
  // override path. Phase 48 — these calls go through lazy wrappers so
  // a module-load failure cannot crash the recovery cron.
  if (brand.stuck_module === "qualification") {
    const r = await lazyRunQualification(brand.id, { force: true });
    return {
      brand_id: brand.id,
      status: r.ok ? "recovered" : "failed",
      error: r.error,
    };
  }
  if (brand.stuck_module === "contacts") {
    const r = await lazyRunContactDiscovery(brand.id);
    return {
      brand_id: brand.id,
      status: r.ok ? "recovered" : "failed",
      error: r.error,
    };
  }

  // Phase 48 — `try/finally` backstop. Once we've claimed the row by
  // setting it to `enriching`, we MUST end this function with a terminal
  // state write. Otherwise a thrown-and-uncaught error leaves the row at
  // `enriching` with `enrichment_error=null` and the next cron run
  // re-picks it 10 min later, burning Keepa tokens forever.
  await setBrandState(admin, brand.id, "enriching");
  let terminalWritten = false;
  try {
    let summary;
    try {
      summary = await enrichBrandWithKeepa(admin, {
        brand_id: brand.id,
        brand_name: brand.name,
        user_id: brand.user_id,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[recover-brands] enrichBrandWithKeepa threw", {
        brandId: brand.id,
        name: brand.name,
        error: msg,
      });
      await setBrandState(admin, brand.id, "failed", `keepa enrichment threw: ${msg}`);
      terminalWritten = true;
      return { brand_id: brand.id, status: "failed", error: msg };
    }

    // enrichBrandWithKeepa may return a "no ASINs" summary without throwing.
    // Treat that as a soft failure so the cron backs off (otherwise we'd
    // re-enrich the same dead-end brand every 5 min).
    if (summary.enrichment_error) {
      await setBrandState(admin, brand.id, "failed", summary.enrichment_error);
      terminalWritten = true;
      return {
        brand_id: brand.id,
        status: "failed",
        asin_count: summary.asin_count,
        error: summary.enrichment_error,
      };
    }
    await setBrandState(admin, brand.id, "enriched");
    terminalWritten = true;

    // Phase 47 — fire qualification (Module 1).
    // Phase 48 — wrapped in try/catch so a follow-up failure cannot
    // mask the successful enrichment we just persisted.
    // Phase 49 — owner resolution auto-trigger removed; qualification
    // supersedes it.
    try {
      lazyMaybeTriggerQualification(brand.id);
    } catch (e) {
      console.error("[recover-brands] lazyMaybeTriggerQualification threw", {
        brandId: brand.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return {
      brand_id: brand.id,
      status: "recovered",
      asin_count: summary.asin_count,
    };
  } finally {
    if (!terminalWritten) {
      // Defense-in-depth: if any thrown-but-uncaught error skipped both
      // explicit terminal writes above (e.g. a fault between the
      // `enriched` setBrandState and this `finally`), make sure the row
      // does not stay stuck at `enriching` with a null error.
      try {
        await setBrandState(
          admin,
          brand.id,
          "failed",
          "stuck-brand recovery exited without terminal state (Phase 48 backstop)",
        );
        console.error("[recover-brands] Phase 48 backstop fired", {
          brandId: brand.id,
          name: brand.name,
        });
      } catch (e) {
        console.error("[recover-brands] Phase 48 backstop write failed", {
          brandId: brand.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
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
