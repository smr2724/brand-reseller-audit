/**
 * Phase 21 — Public report-status polling for the predictability UX.
 *
 * GET /api/public/report-status?token=<reports.token>
 *
 * Returns a coarse step + percent based on observable side-effects on the
 * brand row, so the marketing audit-request flow and the dashboard
 * "Generating report…" card can show live progress instead of a blind
 * spinner.
 *
 * Steps (in order):
 *   1. queued                — reports row exists, no enrichment yet
 *   2. fetching_asins        — keepa_last_enriched_at populated
 *   3. analyzing_sellers     — enrichment progressed past Keepa
 *   4. keywords_competitors  — dataforseo_last_enriched_at populated
 *   5. generating_report     — narrative_json populated but status still 'generating'
 *   6. ready                 — status='completed'
 *   7. failed                — status='failed'
 *
 * Public route: the token IS the secret. We don't return any sensitive
 * data — just step name, percent, and a few timestamps.
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

type Step =
  | "queued"
  | "fetching_asins"
  | "analyzing_sellers"
  | "keywords_competitors"
  | "generating_report"
  | "ready"
  | "failed";

interface StatusResponse {
  step: Step;
  percent: number;
  status: string;
  created_at: string;
  keepa_last_enriched_at: string | null;
  dataforseo_last_enriched_at: string | null;
  narrative_ready: boolean;
  error_message: string | null;
  elapsed_seconds: number;
  estimated_total_seconds: number;
  report_url: string | null;
}

const STEP_PERCENT: Record<Step, number> = {
  queued: 5,
  fetching_asins: 25,
  analyzing_sellers: 45,
  keywords_competitors: 65,
  generating_report: 85,
  ready: 100,
  failed: 100,
};

const ESTIMATED_TOTAL_SECONDS = 180; // 3 min — typical case

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = (url.searchParams.get("token") ?? "").trim();
  if (!token) {
    return NextResponse.json({ error: "token required" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  }

  const { data: report } = await admin
    .from("reports")
    .select(
      "id, brand_id, status, narrative_json, error_message, created_at, generated_at, token",
    )
    .eq("token", token)
    .maybeSingle();

  if (!report) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let keepaAt: string | null = null;
  let dfsAt: string | null = null;
  if (report.brand_id) {
    const { data: brand } = await admin
      .from("brands")
      .select("keepa_last_enriched_at, dataforseo_last_enriched_at")
      .eq("id", report.brand_id)
      .maybeSingle();
    keepaAt = brand?.keepa_last_enriched_at ?? null;
    dfsAt = brand?.dataforseo_last_enriched_at ?? null;
  }

  const narrativeReady = !!report.narrative_json;
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ||
    "https://brand-reseller-audit.vercel.app";

  let step: Step;
  if (report.status === "completed") step = "ready";
  else if (report.status === "failed") step = "failed";
  else if (narrativeReady) step = "generating_report";
  else if (dfsAt) step = "keywords_competitors";
  else if (keepaAt) step = "analyzing_sellers";
  else step = "queued";

  // Bump one notch up after 30s in queue so the UI doesn't sit at 5% if
  // enrichment timestamps haven't been written yet (they're only set when
  // actual fetches succeed; cached enrichment can skip the write).
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(report.created_at).getTime()) / 1000),
  );
  if (step === "queued" && elapsedSeconds > 30) step = "fetching_asins";

  const body: StatusResponse = {
    step,
    percent: STEP_PERCENT[step],
    status: report.status,
    created_at: report.created_at,
    keepa_last_enriched_at: keepaAt,
    dataforseo_last_enriched_at: dfsAt,
    narrative_ready: narrativeReady,
    error_message: report.error_message ?? null,
    elapsed_seconds: elapsedSeconds,
    estimated_total_seconds: ESTIMATED_TOTAL_SECONDS,
    report_url: step === "ready" ? `${baseUrl}/r/${encodeURIComponent(token)}` : null,
  };
  return NextResponse.json(body);
}
