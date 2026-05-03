import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { searchProductsByBrand } from "@/lib/keepa";
import { generateAuditReport } from "@/lib/report/generate";
import { normalizeName } from "@/lib/importer/merge";
import {
  sendReportReadyEmail,
  sendBrandNotFoundEmail,
  isResendConfigured,
} from "@/lib/email/resend";
import { firstNameFromContact } from "@/lib/audit-request/security";
import { createDraft } from "@/lib/microsoft/graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 300;

const MAX_PER_TICK = 5;
const DEFAULT_DAILY_BUDGET = 100;

const APP_BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ||
  "https://brand-reseller-audit.vercel.app";

interface LeadRow {
  id: string;
  brand_name: string;
  requested_brand_name: string | null;
  contact_name: string | null;
  email: string;
  audit_status: string;
  brand_id: string | null;
  report_id: string | null;
  ip_address: string | null;
}

function makeReportToken(): string {
  return randomBytes(24).toString("base64url");
}

function authorize(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true; // permit when not configured (dev)
  const auth = req.headers.get("authorization") ?? "";
  const cronHeader = req.headers.get("x-vercel-cron-signature");
  if (auth === `Bearer ${expected}`) return true;
  // Vercel sets `x-vercel-cron-signature` for scheduled invocations on the
  // hobby plan; we accept the configured secret in either header.
  if (cronHeader && cronHeader === expected) return true;
  return false;
}

async function dailyEnrichmentBudget(
  admin: ReturnType<typeof createSupabaseAdminClient>,
): Promise<{ used: number; cap: number; over: boolean }> {
  const cap = Number(process.env.DAILY_ENRICHMENT_BUDGET ?? DEFAULT_DAILY_BUDGET);
  if (!admin) return { used: 0, cap, over: false };
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { count } = await admin
    .from("enrichment_runs")
    .select("id", { count: "exact", head: true })
    .gte("started_at", since.toISOString());
  const used = count ?? 0;
  return { used, cap, over: used >= cap };
}

function ownerUserId(): string {
  return (
    process.env.RCG_OWNER_USER_ID ??
    "f425219b-c4a8-402b-bcec-4b149d833c68" // steve@rollemanagementgroup.com
  );
}

export async function GET(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  // Daily budget circuit breaker.
  const budget = await dailyEnrichmentBudget(admin);
  if (budget.over) {
    console.warn("[cron/audit-queue] daily enrichment budget exhausted", budget);
    return NextResponse.json({ paused: true, ...budget }, { status: 200 });
  }

  // Strict allowlist: only `pending` leads are eligible. Logged so the
  // exact filter is visible in Vercel logs alongside the response.
  console.log("[cron/audit-queue] selecting leads", {
    filter: "audit_status='pending'",
    order: "audit_requested_at asc",
    limit: MAX_PER_TICK,
  });

  const { data: leadRows, error: selectErr } = await admin
    .from("leads")
    .select(
      "id, brand_name, requested_brand_name, contact_name, email, audit_status, brand_id, report_id, ip_address",
    )
    .eq("audit_status", "pending")
    .order("audit_requested_at", { ascending: true })
    .limit(MAX_PER_TICK);

  if (selectErr) {
    console.error("[cron/audit-queue] lead select failed", selectErr);
    return NextResponse.json({ error: "select_failed" }, { status: 500 });
  }

  const leads = (leadRows ?? []) as LeadRow[];
  console.log("[cron/audit-queue] select returned", {
    count: leads.length,
    rows: leads.map((l) => ({ id: l.id, audit_status: l.audit_status })),
  });

  if (leads.length === 0) {
    return NextResponse.json({ processed: 0, budget });
  }

  const ownerId = ownerUserId();
  const results: Array<{ lead_id: string; status: string; error?: string }> = [];

  for (const lead of leads) {
    // Belt-and-suspenders guard against a stale/garbled SELECT result.
    // The atomic claim below is the real safety belt; this just refuses
    // obviously-wrong rows before any DB writes.
    if (lead.audit_status !== "pending") {
      console.warn("[cron/audit-queue] select returned non-pending row, skipping", {
        lead_id: lead.id,
        audit_status: lead.audit_status,
      });
      results.push({ lead_id: lead.id, status: "skipped_not_pending" });
      continue;
    }

    // Atomic claim: flip pending → matching only if it is still pending
    // at write time. This closes the race between two concurrent ticks
    // (cron runs every minute; a slow tick can overlap the next), and
    // also blocks any path where the SELECT result was stale relative to
    // the database. RETURNING * tells us whether we won the claim.
    const { data: claimedRows, error: claimErr } = await admin
      .from("leads")
      .update({ audit_status: "matching" })
      .eq("id", lead.id)
      .eq("audit_status", "pending")
      .select("id, audit_status");

    if (claimErr) {
      console.error("[cron/audit-queue] claim update failed", { lead_id: lead.id, error: claimErr });
      results.push({ lead_id: lead.id, status: "claim_failed", error: claimErr.message });
      continue;
    }
    if (!claimedRows || claimedRows.length === 0) {
      console.warn("[cron/audit-queue] lost claim race (lead no longer pending)", {
        lead_id: lead.id,
      });
      results.push({ lead_id: lead.id, status: "skipped_claim_lost" });
      continue;
    }

    try {
      await processLead(admin, lead, ownerId);
      results.push({ lead_id: lead.id, status: "ok" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[cron/audit-queue] lead failed", { lead_id: lead.id, error: msg });
      await admin
        .from("leads")
        .update({
          audit_status: "failed",
          failure_reason: msg.slice(0, 500),
        })
        .eq("id", lead.id);
      await postSlackAlert(`Phase 9 audit failed for lead ${lead.id} (${lead.email}): ${msg}`);
      results.push({ lead_id: lead.id, status: "failed", error: msg });
    }
  }

  return NextResponse.json({ processed: results.length, results, budget });
}

async function processLead(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  lead: LeadRow,
  ownerId: string,
) {
  const brandName = lead.requested_brand_name ?? lead.brand_name;

  // ---- 1. Status already flipped to `matching` by the atomic claim
  // in the GET handler. Skip the redundant write. ----

  // ---- 2. Keepa brand search ----
  const search = await searchProductsByBrand(brandName, 5);
  if (!search.asins.length) {
    await admin
      .from("leads")
      .update({
        audit_status: "not_found",
        failure_reason: "No ASINs found on Amazon US for this brand name.",
      })
      .eq("id", lead.id);
    if (isResendConfigured()) {
      await sendBrandNotFoundEmail({
        to: lead.email,
        firstName: firstNameFromContact(lead.contact_name),
        brandName,
      });
    }
    return;
  }

  // ---- 3. Resolve / create the brand row under the owner ----
  let brandId: string | null = lead.brand_id;
  if (!brandId) {
    const norm = normalizeName(brandName);
    const { data: existing } = await admin
      .from("brands")
      .select("id")
      .eq("user_id", ownerId)
      .eq("name_normalized", norm)
      .maybeSingle();
    if (existing?.id) {
      brandId = existing.id;
    } else {
      const { data: created, error: insErr } = await admin
        .from("brands")
        .insert({
          user_id: ownerId,
          name: brandName,
          name_normalized: norm,
          status: "lead_request",
        })
        .select("id")
        .single();
      if (insErr || !created) {
        throw new Error(`brand insert failed: ${insErr?.message ?? "unknown"}`);
      }
      brandId = created.id;
    }
    await admin.from("leads").update({ brand_id: brandId }).eq("id", lead.id);
  }
  if (!brandId) throw new Error("brand_id resolution failed");

  // ---- 4. Mark enriching, create reports row, run generate ----
  await admin
    .from("leads")
    .update({ audit_status: "enriching" })
    .eq("id", lead.id);

  // Idempotency: if a recent completed report already exists for this
  // brand, reuse it instead of regenerating. Bounds the blast radius if
  // this lead ever gets reclaimed mid-flight.
  const reuseCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: existingReport } = await admin
    .from("reports")
    .select("id, token")
    .eq("user_id", ownerId)
    .eq("brand_id", brandId)
    .eq("kind", "channel_ownership_audit")
    .eq("status", "completed")
    .gte("created_at", reuseCutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let reportId: string;
  let reusedReport = false;
  if (existingReport?.id && existingReport.token) {
    reportId = existingReport.id;
    reusedReport = true;
    await admin
      .from("leads")
      .update({ audit_status: "generating_report", report_id: reportId })
      .eq("id", lead.id);
  } else {
    const { data: report, error: reportErr } = await admin
      .from("reports")
      .insert({
        user_id: ownerId,
        brand_id: brandId,
        kind: "channel_ownership_audit",
        status: "generating",
        title: `${brandName} — Channel Ownership Audit`,
        token: makeReportToken(),
      })
      .select("id, token")
      .single();
    if (reportErr || !report) {
      throw new Error(`report insert failed: ${reportErr?.message ?? "unknown"}`);
    }
    reportId = report.id;

    await admin
      .from("leads")
      .update({ audit_status: "generating_report", report_id: reportId })
      .eq("id", lead.id);

    // Phase 6.7 hotfix lesson: await generation. Do not waitUntil — we need
    // the row finalized before we can email the prospect on the same tick.
    await generateAuditReport({
      reportId,
      userId: ownerId,
      brandId,
      contactEmail: lead.email,
    });
  }

  // ---- 5. Read final report token ----
  const { data: finalReport } = await admin
    .from("reports")
    .select("status, token, error_message")
    .eq("id", reportId)
    .maybeSingle();
  if (finalReport?.status !== "completed" || !finalReport.token) {
    throw new Error(
      `report did not complete: ${finalReport?.error_message ?? finalReport?.status ?? "unknown"}`,
    );
  }

  await admin
    .from("leads")
    .update({
      audit_status: "report_ready",
      audit_completed_at: new Date().toISOString(),
    })
    .eq("id", lead.id);

  // If we reused a recent report, the prospect was already emailed and
  // an Outlook draft already exists from the original tick. Re-firing
  // both is the duplicate-email pain Steve hit in prod (14 copies).
  // Mark the lead `sent` and exit without side effects.
  if (reusedReport) {
    console.log("[cron/audit-queue] reused existing report, skipping email/draft", {
      lead_id: lead.id,
      report_id: reportId,
    });
    await admin
      .from("leads")
      .update({ audit_status: "sent" })
      .eq("id", lead.id);
    return;
  }

  // ---- 6. Send report-ready email via Resend ----
  if (isResendConfigured()) {
    const send = await sendReportReadyEmail({
      to: lead.email,
      firstName: firstNameFromContact(lead.contact_name),
      brandName,
      reportToken: finalReport.token,
    });
    if (!send.ok) {
      throw new Error(`resend failed: ${send.error}`);
    }
  } else {
    console.warn("[cron/audit-queue] RESEND_API_KEY missing — skipping prospect email");
  }

  // ---- 7. Hybrid: also create an Outlook draft in Steve's mailbox ----
  // Phase 24 — pull the report's narrative_json so we can branch the
  // draft subject + body for diy_fit reports. The standard pitch subject
  // ("Following up — <brand> Channel Ownership Audit") doesn't fit when
  // the report itself is friendly DIY advice, not a sales pitch.
  let reportMode: "high_fit" | "diy_fit" | "not_a_fit" | null = null;
  try {
    const { data: reportRow } = await admin
      .from("reports")
      .select("narrative_json")
      .eq("id", reportId)
      .maybeSingle();
    const n = (reportRow?.narrative_json as { report_mode?: string } | null) ?? null;
    if (n?.report_mode === "diy_fit" || n?.report_mode === "high_fit" || n?.report_mode === "not_a_fit") {
      reportMode = n.report_mode;
    }
  } catch {
    // soft fail — fall back to the high_fit subject below.
  }

  const reportUrl = `${APP_BASE_URL}/r/${encodeURIComponent(finalReport.token)}`;
  const firstName = firstNameFromContact(lead.contact_name) ?? "there";

  const isDiyDraft = reportMode === "diy_fit";
  const draftSubject = isDiyDraft
    ? `Quick recommendations for your Amazon channel`
    : `Following up — ${brandName} Channel Ownership Audit`;
  const draftHtml = isDiyDraft
    ? `<p>Hey ${escapeHtml(firstName)},</p>` +
      `<p>Took a quick look at <strong>${escapeHtml(brandName)}</strong>'s Amazon channel — you're in much better shape than most brands we audit.</p>` +
      `<p>Wrote up a short note with what we saw and three things you can do yourself to clean up the residual reseller share:</p>` +
      `<p><a href="${reportUrl}">${reportUrl}</a></p>` +
      `<p>No pitch attached — just thought it might be useful. Happy to chat any time if you want a second pair of eyes.</p>` +
      `<p>— Steve</p>`
    : `<p>Hey ${escapeHtml(firstName)},</p>` +
      `<p>Just sent over your Channel Ownership Audit for <strong>${escapeHtml(brandName)}</strong>.</p>` +
      `<p><a href="${reportUrl}">${reportUrl}</a></p>` +
      `<p>Worth 15 minutes to walk through what we found?</p>` +
      `<p>— Steve</p>`;
  const draftText = isDiyDraft
    ? `Hey ${firstName}, took a quick look at ${brandName}'s Amazon channel — you're in better shape than most brands we audit. Wrote up a short note with three things you can do yourself: ${reportUrl}\n\nNo pitch attached — just thought it might be useful.\n\n— Steve`
    : `Hey ${firstName}, just sent over your Channel Ownership Audit for ${brandName}: ${reportUrl}\n\nWorth 15 minutes to walk through what we found?\n\n— Steve`;

  const draft = await createDraft({
    userId: ownerId,
    to: { address: lead.email, name: lead.contact_name ?? undefined },
    subject: draftSubject,
    html: draftHtml,
    text: draftText,
  });

  let outlookDraftId: string | null = null;
  if (draft.ok) {
    outlookDraftId = draft.messageId;
  } else {
    // Don't fail the whole pipeline if Outlook isn't connected — the
    // prospect still got the Resend email. Log + alert so Steve can
    // reconnect Outlook from /app/settings.
    console.warn("[cron/audit-queue] Outlook draft failed", {
      lead_id: lead.id,
      reason: draft.error,
    });
    if (draft.reauthRequired) {
      await postSlackAlert(
        `Outlook draft skipped for ${lead.email} (${brandName}) — reconnect Outlook in /app/settings.`,
      );
    }
  }

  await admin
    .from("leads")
    .update({
      audit_status: "sent",
      audit_email_sent_at: new Date().toISOString(),
      outlook_draft_id: outlookDraftId,
    })
    .eq("id", lead.id);
}

async function postSlackAlert(message: string): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  } catch (e) {
    console.warn("[cron/audit-queue] slack alert failed", e);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
