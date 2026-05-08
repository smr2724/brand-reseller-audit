/**
 * Phase 47 — Auto-trigger hooks for Module 1 (qualification) and
 * Module 2 (contact discovery).
 *
 * Both fire as fire-and-forget background work via Vercel `waitUntil`.
 * Mirrors the Phase 33 owner-resolver trigger pattern so the enrichment
 * caller never waits and any failure is non-blocking.
 *
 * Pipeline:
 *   - `enrichment_state='enriched'` → fire `runQualification(brandId)`.
 *   - `qualification_state='complete'` AND
 *     (icp_verdict in ('qualified','needs_review') OR manual_override=true)
 *     → fire `runContactDiscovery(brandId)`.
 */
import { waitUntil } from "@vercel/functions";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { runQualification } from "./orchestrate";
import { runContactDiscovery } from "@/lib/contacts/orchestrate";

export function maybeTriggerQualification(brandId: string): void {
  if (!brandId) return;
  const work = runQualificationIfNeeded(brandId).catch((e: unknown) => {
    console.warn(
      "[qualification] auto-trigger failed",
      brandId,
      e instanceof Error ? e.message : String(e),
    );
  });
  try {
    waitUntil(work);
  } catch {
    // Outside a Vercel request context, the bare promise still completes.
  }
}

export function maybeTriggerContactDiscovery(brandId: string): void {
  if (!brandId) return;
  const work = runContactDiscoveryIfNeeded(brandId).catch((e: unknown) => {
    console.warn(
      "[contacts] auto-trigger failed",
      brandId,
      e instanceof Error ? e.message : String(e),
    );
  });
  try {
    waitUntil(work);
  } catch {
    // No-op outside Vercel request context.
  }
}

async function runQualificationIfNeeded(brandId: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  const { data: brand } = await admin
    .from("brands")
    .select("id, qualification_state")
    .eq("id", brandId)
    .maybeSingle<{ id: string; qualification_state: string | null }>();
  if (!brand) return;
  const state = brand.qualification_state ?? "pending";
  if (state === "running" || state === "complete") return;
  const result = await runQualification(brandId, {});
  // Chain: when complete, fire contact discovery if eligible.
  if (result.ok && result.state === "complete") {
    await runContactDiscoveryIfNeeded(brandId);
  }
}

async function runContactDiscoveryIfNeeded(brandId: string): Promise<void> {
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  const { data: brand } = await admin
    .from("brands")
    .select("id, contacts_state")
    .eq("id", brandId)
    .maybeSingle<{ id: string; contacts_state: string | null }>();
  if (!brand) return;
  const cs = brand.contacts_state ?? "pending";
  if (cs === "running" || cs === "complete") return;
  const { data: qual } = await admin
    .from("brand_qualifications")
    .select("icp_verdict, manual_override, state")
    .eq("brand_id", brandId)
    .maybeSingle<{
      icp_verdict: string;
      manual_override: boolean;
      state: string;
    }>();
  if (!qual || qual.state !== "complete") return;
  const eligible =
    qual.icp_verdict === "qualified" ||
    qual.icp_verdict === "needs_review" ||
    qual.manual_override === true;
  if (!eligible) return;
  await runContactDiscovery(brandId);
}
