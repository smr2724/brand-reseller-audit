/**
 * Phase 33 — Auto-trigger hook for owner resolution.
 *
 * Called from enrichment "mark complete" code paths whenever a brand's
 * enrichment_state transitions to 'enriched'. Fires the resolver as a
 * non-blocking follow-up: the enrichment caller never waits on it, and
 * any failure is swallowed (the user can always re-run from the Brand
 * Owner section on /app/brands/:id).
 *
 * Idempotency (B5): the resolver itself does an atomic CAS-claim, so even
 * if multiple call-sites race we only run once.
 *
 * Vercel safety (B6): we register the work with `waitUntil` so the
 * function host extends its lifetime for the background work instead of
 * dropping it after the response is sent.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { waitUntil } from "@vercel/functions";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { resolveBrandOwner } from "./resolve";

const SKIP_STATES = new Set([
  "running",
  "awaiting_apollo_selection",
  "enriching_apollo",
  "candidates_ready",
  "selected",
]);

/**
 * Fire-and-forget. Returns immediately; resolver runs in the background
 * via Vercel's `waitUntil` so the function host keeps it alive after the
 * response has been sent.
 */
export function maybeTriggerOwnerResolution(brandId: string): void {
  if (!brandId) return;
  const work = runIfNeeded(brandId).catch((e: unknown) => {
    console.warn(
      "[owner-resolver] auto-trigger failed",
      brandId,
      e instanceof Error ? e.message : String(e),
    );
  });
  try {
    waitUntil(work);
  } catch {
    // waitUntil only available inside a Vercel request context — outside
    // (cron scripts, local dev, tests) the bare promise still completes
    // because the surrounding process is long-lived.
  }
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
  // Cheap pre-check before the CAS — avoids creating a noisy "skipped"
  // result for the common case where state is already terminal.
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
