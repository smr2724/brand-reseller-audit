/**
 * Phase 33 — Auto-trigger hook for owner resolution.
 *
 * Called from enrichment "mark complete" code paths whenever a brand's
 * enrichment_state transitions to 'enriched'. Fires the resolver as a
 * non-blocking follow-up: the enrichment caller never waits on it, and
 * any failure is swallowed (the manual /admin/brands/:id/owner page can
 * always re-run).
 *
 * Idempotency: skip if `owner_resolution_state` is already 'running',
 * 'candidates_ready', or 'selected'.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { resolveBrandOwner } from "./resolve";

const SKIP_STATES = new Set(["running", "candidates_ready", "selected"]);

/**
 * Fire-and-forget. Returns immediately; resolver runs in the background
 * via `Promise.resolve().then(...)` so it's compatible with Vercel
 * serverless functions that complete the response before all work is done.
 */
export function maybeTriggerOwnerResolution(brandId: string): void {
  if (!brandId) return;
  Promise.resolve()
    .then(() => runIfNeeded(brandId))
    .catch((e: unknown) => {
      console.warn(
        "[owner-resolver] auto-trigger failed",
        brandId,
        e instanceof Error ? e.message : String(e),
      );
    });
}

async function runIfNeeded(brandId: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    console.warn(
      "[owner-resolver] auto-trigger skipped — no SUPABASE_SERVICE_ROLE_KEY",
    );
    return;
  }
  const { data: brand, error } = await admin
    .from("brands")
    .select("id, owner_resolution_state")
    .eq("id", brandId)
    .maybeSingle();
  if (error || !brand) return;
  const state = String(
    (brand as { owner_resolution_state?: string }).owner_resolution_state ??
      "pending",
  );
  if (SKIP_STATES.has(state)) return;
  await resolveBrandOwner(admin, brandId, {
    triggered_by: "auto_post_enrichment",
  });
}

/**
 * Test seam — synchronous variant that callers can `await` for unit tests.
 */
export async function triggerOwnerResolutionNow(
  admin: SupabaseClient,
  brandId: string,
): Promise<void> {
  const { data: brand } = await admin
    .from("brands")
    .select("id, owner_resolution_state")
    .eq("id", brandId)
    .maybeSingle();
  if (!brand) return;
  const state = String(
    (brand as { owner_resolution_state?: string }).owner_resolution_state ??
      "pending",
  );
  if (SKIP_STATES.has(state)) return;
  await resolveBrandOwner(admin, brandId, {
    triggered_by: "auto_post_enrichment",
  });
}
