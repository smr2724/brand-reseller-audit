/**
 * Phase 75 — Per-brand worker for the bulk pipeline.
 *
 * The worker route claims a single `queued` bulk_run_brands row,
 * runs every existing pipeline step end-to-end in order, and updates
 * the row's status + progress as it goes. It uses library functions
 * (NOT HTTP routes) so it can run unauthenticated under CRON_SECRET.
 *
 * Step order:
 *   1. keepa_searching   — lookupBrand() picks the top candidate
 *   2. keepa_enriching   — enrichBrandWithKeepa() (insert brand row +
 *                          ASINs + sellers) + DataForSeo SERP
 *   3. qualifying        — runQualification() (Gate A + Gate B + Gate C)
 *   4. resolving_owner   — readback selected_entity.evidence_url → domain
 *   5. discovering_contacts — runContactDiscovery() (Apollo → Hunter → MV)
 *   6. verifying_email   — readback primary brand_contacts row
 *   7. drafting          — createDraft() with Steve's verbatim copy,
 *                          only when email_status='verified'
 *
 * Any throw lands in status='error' with error_step/error_message so
 * the run continues past the failure.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { lookupBrand } from "@/lib/brand-lookup";
import { enrichBrandWithKeepa } from "@/lib/enrichment/keepa-brand";
import { enrichBrandWithDataForSeo } from "@/lib/enrichment/dataforseo";
import { normalizeName } from "@/lib/importer/merge";
import { runQualification } from "@/lib/qualification/orchestrate";
import { runContactDiscovery } from "@/lib/contacts/orchestrate";
import { createDraft } from "@/lib/microsoft/graph";
import { persistBrandEconomics } from "@/lib/brand-detail/persist-economics";

const STEVE_SIGNATURE_HTML =
  `<p>__FIRST_NAME__</p>` +
  `<p>__BRAND__ is killing it on Amazon but you're not the one selling on most of the listings.</p>` +
  `<p>I made a quick report to show you exactly how much more you could profiting without any extra effort?</p>` +
  `<p>Are you the right person to send it to?</p>` +
  `<p>Steve Rolle</p>`;

const STEVE_SIGNATURE_TEXT =
  `__FIRST_NAME__\n\n` +
  `__BRAND__ is killing it on Amazon but you're not the one selling on most of the listings.\n\n` +
  `I made a quick report to show you exactly how much more you could profiting without any extra effort?\n\n` +
  `Are you the right person to send it to?\n\n` +
  `Steve Rolle`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildSteveEmail(brand: string, firstName: string | null): {
  subject: string;
  html: string;
  text: string;
} {
  const safeFirst =
    typeof firstName === "string" && firstName.trim().length > 0
      ? firstName.trim()
      : "there";
  return {
    subject: `Quick question about ${brand}`,
    html: STEVE_SIGNATURE_HTML.replace("__FIRST_NAME__", escapeHtml(safeFirst)).replace(
      "__BRAND__",
      escapeHtml(brand),
    ),
    text: STEVE_SIGNATURE_TEXT.replace("__FIRST_NAME__", safeFirst).replace(
      "__BRAND__",
      brand,
    ),
  };
}

function extractDomain(input: string | null): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("/")[0];
  s = s.split("?")[0];
  if (!s.includes(".")) return null;
  return s;
}

interface BulkRunBrandRow {
  id: string;
  bulk_run_id: string;
  position: number;
  input_name: string;
  status: string;
}

interface BulkRunRow {
  id: string;
  user_id: string;
  status: string;
  total_brands: number;
  brands_completed: number;
}

export interface ClaimResult {
  claimed: BulkRunBrandRow | null;
}

/**
 * Atomically claim the next queued brand for a run, flipping its
 * status to keepa_searching. Returns null when nothing is queued.
 *
 * We can't run `FOR UPDATE SKIP LOCKED` directly through PostgREST, so
 * we approximate the same guarantee with a status-conditional update
 * (the WHERE status='queued' clause means a second worker that lost
 * the race will update zero rows).
 */
export async function claimNextQueuedBrand(
  admin: SupabaseClient<any, any, any>,
  bulkRunId: string,
): Promise<BulkRunBrandRow | null> {
  const { data: next } = await admin
    .from("bulk_run_brands")
    .select("id, bulk_run_id, position, input_name, status")
    .eq("bulk_run_id", bulkRunId)
    .eq("status", "queued")
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle<BulkRunBrandRow>();
  if (!next) return null;

  const { data: claimed, error } = await admin
    .from("bulk_run_brands")
    .update({
      status: "keepa_searching",
      started_at: new Date().toISOString(),
      progress_percent: 5,
      current_step_label: `Searching Keepa for ${next.input_name}`,
      updated_at: new Date().toISOString(),
    })
    .eq("id", next.id)
    .eq("status", "queued")
    .select("id, bulk_run_id, position, input_name, status")
    .maybeSingle<BulkRunBrandRow>();

  if (error || !claimed) {
    // Lost the race or transient failure — caller will retry next tick.
    return null;
  }
  return claimed;
}

async function patchRow(
  admin: SupabaseClient<any, any, any>,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await admin
    .from("bulk_run_brands")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
}

async function bumpRunCompleted(
  admin: SupabaseClient<any, any, any>,
  runId: string,
): Promise<void> {
  // Recount completed-ish brands directly (cheap and avoids races).
  const { count } = await admin
    .from("bulk_run_brands")
    .select("id", { count: "exact", head: true })
    .eq("bulk_run_id", runId)
    .in("status", ["completed", "disqualified", "keepa_not_found", "error"]);
  await admin
    .from("bulk_runs")
    .update({
      brands_completed: count ?? 0,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);
}

async function markError(
  admin: SupabaseClient<any, any, any>,
  rowId: string,
  step: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await patchRow(admin, rowId, {
    status: "error",
    error_step: step,
    error_message: message.slice(0, 500),
    progress_percent: 100,
    completed_at: new Date().toISOString(),
  });
}

interface BrandLookupCandidateShape {
  brand: string;
  asin_count: number;
}

/**
 * Process a single bulk_run_brands row end-to-end. Always resolves
 * (never throws) — the per-step try/catch leaves a terminal status on
 * the row even when something blows up so the run continues.
 */
export async function processBulkBrand(
  rowId: string,
): Promise<{ ok: boolean; status: string; error?: string }> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return { ok: false, status: "error", error: "SUPABASE_SERVICE_ROLE_KEY missing" };
  }

  const { data: row } = await admin
    .from("bulk_run_brands")
    .select("id, bulk_run_id, input_name")
    .eq("id", rowId)
    .maybeSingle<{ id: string; bulk_run_id: string; input_name: string }>();
  if (!row) return { ok: false, status: "error", error: "row not found" };

  const { data: runRow } = await admin
    .from("bulk_runs")
    .select("id, user_id")
    .eq("id", row.bulk_run_id)
    .maybeSingle<{ id: string; user_id: string }>();
  if (!runRow) {
    await markError(admin, rowId, "init", new Error("bulk_runs row missing"));
    await bumpRunCompleted(admin, row.bulk_run_id);
    return { ok: false, status: "error", error: "bulk_runs missing" };
  }

  const userId = runRow.user_id;
  const brandInput = row.input_name;

  await admin
    .from("bulk_runs")
    .update({
      current_brand_name: brandInput,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.bulk_run_id);

  // ---- Step 1: Keepa search ----
  let topCandidate: BrandLookupCandidateShape | null = null;
  try {
    const result = await lookupBrand(admin, brandInput, { force: false });
    const candidates = (result.candidates ?? []) as BrandLookupCandidateShape[];
    topCandidate = candidates.length > 0 ? candidates[0] : null;
  } catch (e) {
    await markError(admin, rowId, "keepa_search", e);
    await bumpRunCompleted(admin, row.bulk_run_id);
    return { ok: false, status: "error", error: String(e) };
  }

  if (!topCandidate || !topCandidate.brand || topCandidate.asin_count === 0) {
    await patchRow(admin, rowId, {
      status: "keepa_not_found",
      progress_percent: 100,
      current_step_label: "No Keepa hits — skipped",
      completed_at: new Date().toISOString(),
    });
    await bumpRunCompleted(admin, row.bulk_run_id);
    return { ok: true, status: "keepa_not_found" };
  }

  const resolvedBrandName = topCandidate.brand;

  // ---- Step 2: Keepa enrich ----
  await patchRow(admin, rowId, {
    status: "keepa_enriching",
    progress_percent: 15,
    current_step_label: `Enriching ${resolvedBrandName} from Keepa`,
  });

  let brandId: string;
  try {
    const norm = normalizeName(resolvedBrandName);
    // Reuse if already present for this user.
    const { data: existing } = await admin
      .from("brands")
      .select("id")
      .eq("user_id", userId)
      .eq("name_normalized", norm)
      .maybeSingle<{ id: string }>();

    if (existing?.id) {
      brandId = existing.id;
    } else {
      const { data: created, error: insErr } = await admin
        .from("brands")
        .insert({
          user_id: userId,
          name: resolvedBrandName,
          name_normalized: norm,
          status: "new",
        })
        .select("id")
        .single();
      if (insErr || !created) {
        throw new Error(insErr?.message ?? "brand insert failed");
      }
      brandId = created.id;
    }

    await admin
      .from("brands")
      .update({ enrichment_state: "enriching", updated_at: new Date().toISOString() })
      .eq("id", brandId);

    const summary = await enrichBrandWithKeepa(admin, {
      brand_id: brandId,
      brand_name: resolvedBrandName,
      user_id: userId,
    });

    const keepaError = summary.enrichment_error;
    const asinCount = summary.asin_count;
    const enrichedNow = !(keepaError != null || asinCount === 0);
    await admin
      .from("brands")
      .update({
        enrichment_state: enrichedNow ? "enriched" : "failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", brandId);

    if (!enrichedNow) {
      throw new Error(keepaError ?? `Keepa enrichment returned 0 ASINs`);
    }

    // DataForSeo SERP — non-fatal.
    try {
      await enrichBrandWithDataForSeo(admin, {
        brand_id: brandId,
        brand_name: resolvedBrandName,
        user_id: userId,
      });
    } catch {
      // ignored; DFS is enrichment fluff
    }
  } catch (e) {
    await markError(admin, rowId, "keepa_enrich", e);
    await bumpRunCompleted(admin, row.bulk_run_id);
    return { ok: false, status: "error", error: String(e) };
  }

  await patchRow(admin, rowId, {
    brand_id: brandId,
  });
  await admin
    .from("bulk_runs")
    .update({ current_brand_id: brandId, updated_at: new Date().toISOString() })
    .eq("id", row.bulk_run_id);

  // ---- Step 3: Qualify ----
  await patchRow(admin, rowId, {
    status: "qualifying",
    progress_percent: 30,
    current_step_label: "Running Gate A + Gate B qualification",
  });

  let qualifiedFlag = false;
  let disqualReason: string | null = null;
  let selectedEntityName: string | null = null;
  let evidenceUrl: string | null = null;

  try {
    const result = await runQualification(brandId, {});
    if (result.state === "error") {
      throw new Error(result.error ?? "qualification error");
    }

    // Read verdict
    const { data: qual } = await admin
      .from("brand_qualifications")
      .select(
        "icp_verdict, disqualification_pattern, selected_entity",
      )
      .eq("brand_id", brandId)
      .maybeSingle<{
        icp_verdict: string;
        disqualification_pattern: string | null;
        selected_entity: { name?: string; evidence_url?: string } | null;
      }>();

    const verdict = qual?.icp_verdict ?? result.verdict ?? null;
    qualifiedFlag = verdict === "qualified" || verdict === "needs_review";
    selectedEntityName = qual?.selected_entity?.name ?? null;
    evidenceUrl = qual?.selected_entity?.evidence_url ?? null;

    if (verdict === "disqualified") {
      disqualReason = qual?.disqualification_pattern ?? "disqualified";
      await patchRow(admin, rowId, {
        status: "disqualified",
        qualified: false,
        disqualification_reason: disqualReason,
        selected_entity_name: selectedEntityName,
        progress_percent: 100,
        current_step_label: `Disqualified: ${disqualReason}`,
        completed_at: new Date().toISOString(),
      });
      await bumpRunCompleted(admin, row.bulk_run_id);
      return { ok: true, status: "disqualified" };
    }
  } catch (e) {
    await markError(admin, rowId, "qualify", e);
    await bumpRunCompleted(admin, row.bulk_run_id);
    return { ok: false, status: "error", error: String(e) };
  }

  // ---- Step 4: Resolve owner domain (bookkeeping) ----
  await patchRow(admin, rowId, {
    status: "resolving_owner",
    progress_percent: 50,
    current_step_label: "Resolving owner domain",
    qualified: true,
    selected_entity_name: selectedEntityName,
  });

  let resolvedDomain: string | null = null;
  try {
    const { data: brandRow } = await admin
      .from("brands")
      .select("resolved_owner_domain")
      .eq("id", brandId)
      .maybeSingle<{ resolved_owner_domain: string | null }>();
    resolvedDomain =
      brandRow?.resolved_owner_domain ||
      extractDomain(evidenceUrl) ||
      null;

    if (resolvedDomain && !brandRow?.resolved_owner_domain) {
      await admin
        .from("brands")
        .update({
          resolved_owner_domain: resolvedDomain,
          updated_at: new Date().toISOString(),
        })
        .eq("id", brandId);
    }
    await patchRow(admin, rowId, { resolved_owner_domain: resolvedDomain });
  } catch (e) {
    // Soft-fail: a missing domain is handled by orchestrator below.
    console.warn(`[bulk-worker] owner-domain resolve soft-failed for ${brandId}:`, e);
  }

  // ---- Step 5: Contact discovery (Apollo → Hunter → MV) ----
  await patchRow(admin, rowId, {
    status: "discovering_contacts",
    progress_percent: 65,
    current_step_label: "Apollo + Hunter contact discovery",
  });

  let primaryContact: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    full_name: string | null;
    email: string | null;
    email_source: string | null;
    email_status: string | null;
  } | null = null;

  try {
    await runContactDiscovery(brandId);
  } catch (e) {
    // Orchestrator itself shouldn't throw — but if it does, we record
    // it and continue: a brand without contacts still appears in the
    // ranked report.
    console.warn(`[bulk-worker] contact orchestrator threw for ${brandId}:`, e);
  }

  // ---- Step 6: Read back primary contact + verify ----
  await patchRow(admin, rowId, {
    status: "verifying_email",
    progress_percent: 80,
    current_step_label: "MillionVerifier email validation",
  });

  try {
    const { data: contacts } = await admin
      .from("brand_contacts")
      .select(
        "id, first_name, last_name, full_name, email, email_source, email_status, is_primary",
      )
      .eq("brand_id", brandId)
      .order("is_primary", { ascending: false })
      .order("updated_at", { ascending: false });

    const list = (contacts ?? []) as Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      full_name: string | null;
      email: string | null;
      email_source: string | null;
      email_status: string | null;
      is_primary: boolean | null;
    }>;
    primaryContact = list.find((c) => c.is_primary === true && !!c.email) ?? null;
    if (!primaryContact) {
      primaryContact = list.find((c) => !!c.email) ?? null;
    }
  } catch (e) {
    console.warn(`[bulk-worker] readback failed for ${brandId}:`, e);
  }

  // Persist contact fields on the bulk row regardless of draft outcome.
  await patchRow(admin, rowId, {
    contact_name: primaryContact?.full_name ?? null,
    contact_email: primaryContact?.email ?? null,
    email_verifier: primaryContact?.email_source ?? null,
    email_status: primaryContact?.email_status ?? null,
  });

  // Compute and persist legion economics now that revenue is known.
  let legionScore: number | null = null;
  let legionOpportunity: number | null = null;
  try {
    await persistBrandEconomics(admin, brandId);
    const { data: brandEcon } = await admin
      .from("brands")
      .select("additional_profit, seven_x_multiple_value")
      .eq("id", brandId)
      .maybeSingle<{
        additional_profit: number | null;
        seven_x_multiple_value: number | null;
      }>();
    legionOpportunity = brandEcon?.additional_profit ?? null;
    legionScore = brandEcon?.seven_x_multiple_value ?? null;
  } catch (e) {
    console.warn(`[bulk-worker] economics persist failed for ${brandId}:`, e);
  }
  await patchRow(admin, rowId, {
    legion_score: legionScore,
    legion_opportunity: legionOpportunity,
  });

  // ---- Step 7: Draft if email is MV-verified ----
  if (!primaryContact || !primaryContact.email) {
    await patchRow(admin, rowId, {
      status: "completed",
      progress_percent: 100,
      current_step_label: "Qualified — no decision-maker contact found",
      completed_at: new Date().toISOString(),
    });
    await bumpRunCompleted(admin, row.bulk_run_id);
    return { ok: true, status: "completed" };
  }

  if (primaryContact.email_status !== "verified") {
    await patchRow(admin, rowId, {
      status: "completed",
      progress_percent: 100,
      current_step_label: `Qualified — contact ${primaryContact.email_status ?? "unverified"}; draft skipped`,
      completed_at: new Date().toISOString(),
    });
    await bumpRunCompleted(admin, row.bulk_run_id);
    return { ok: true, status: "completed" };
  }

  await patchRow(admin, rowId, {
    status: "drafting",
    progress_percent: 90,
    current_step_label: "Creating Outlook draft",
  });

  try {
    const { subject, html, text } = buildSteveEmail(
      resolvedBrandName,
      primaryContact.first_name,
    );
    const draft = await createDraft({
      userId,
      to: {
        address: primaryContact.email,
        name: primaryContact.full_name ?? undefined,
      },
      subject,
      html,
      text,
    });
    if (!draft.ok) {
      throw new Error(draft.error || "Outlook draft creation failed");
    }
    await patchRow(admin, rowId, {
      status: "completed",
      outlook_draft_id: draft.messageId,
      outlook_draft_web_link: draft.webLink ?? null,
      progress_percent: 100,
      current_step_label: "Draft created",
      completed_at: new Date().toISOString(),
    });
  } catch (e) {
    await markError(admin, rowId, "draft", e);
    await bumpRunCompleted(admin, row.bulk_run_id);
    return { ok: false, status: "error", error: String(e) };
  }

  await bumpRunCompleted(admin, row.bulk_run_id);
  return { ok: true, status: "completed" };
}
