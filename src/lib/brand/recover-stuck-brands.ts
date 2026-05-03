/**
 * Phase 29 — Stuck-brand recovery helper.
 *
 * Finds brands that were created via the picker (or any insert path) but
 * never finished Keepa enrichment — typically because the
 * /api/brands/create-from-lookup function hit Vercel's maxDuration and
 * was killed mid-flight before keepa_last_enriched_at could be stamped.
 *
 * Symptom we recover from:
 *   created_at < now() - 5 minutes
 *   AND keepa_last_enriched_at IS NULL
 *
 * Re-runs enrichBrandWithKeepa against the brand row in place. The
 * Keepa enricher itself is idempotent (it deletes + re-inserts brand_sellers
 * and upserts brand_asins on (brand_id, asin)), so a second pass is safe.
 *
 * Mirrors the Phase 21 stuck-report recovery pattern.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { enrichBrandWithKeepa } from "@/lib/enrichment/keepa-brand";

export interface StuckBrand {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
}

export const STUCK_BRAND_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
export const RECOVERY_BRAND_BATCH_LIMIT = 3;

export async function findStuckBrands(
  admin: SupabaseClient,
  thresholdMs: number = STUCK_BRAND_THRESHOLD_MS,
  limit: number = RECOVERY_BRAND_BATCH_LIMIT,
): Promise<StuckBrand[]> {
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();
  const { data, error } = await admin
    .from("brands")
    .select("id, user_id, name, created_at")
    .is("keepa_last_enriched_at", null)
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

export async function recoverStuckBrand(
  admin: SupabaseClient,
  brand: StuckBrand,
): Promise<RecoverBrandResult> {
  try {
    const summary = await enrichBrandWithKeepa(admin, {
      brand_id: brand.id,
      brand_name: brand.name,
      user_id: brand.user_id,
    });
    return {
      brand_id: brand.id,
      status: "recovered",
      asin_count: summary.asin_count,
      error: summary.enrichment_error ?? undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { brand_id: brand.id, status: "failed", error: msg };
  }
}
