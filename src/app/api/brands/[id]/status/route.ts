/**
 * Phase 51 — GET /api/brands/[id]/status
 *
 * Lightweight, polling-friendly status snapshot for the EnrichmentStatusCard
 * on /app/brands/[id]. The brand page polls every 3 seconds while
 * `is_busy=true` so the user sees live progress through the four pipeline
 * phases (Keepa → DataForSEO → qualification → contact discovery).
 *
 * The full step-resolution table lives in `phase51_live_status_and_verdict_fix.md`.
 */
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type EnrichmentState =
  | "pending"
  | "queued"
  | "enriching"
  | "enriched"
  | "failed"
  | "deferred";
type QualificationState =
  | "pending"
  | "running"
  | "complete"
  | "skipped"
  | "error";
type ContactsState = "pending" | "running" | "complete" | "skipped" | "error";

interface BrandStatusRow {
  id: string;
  created_at: string;
  updated_at: string;
  enrichment_state: EnrichmentState | null;
  enrichment_error: string | null;
  keepa_last_enriched_at: string | null;
  dataforseo_last_enriched_at: string | null;
  qualification_state: QualificationState | null;
  contacts_state: ContactsState | null;
}

interface QualRow {
  state: string | null;
  selected_entity: unknown;
  icp_verdict: string | null;
  narrative_markdown: string | null;
  error_message: string | null;
  updated_at: string | null;
  created_at: string | null;
}

interface ContactRunRow {
  updated_at: string | null;
  created_at: string | null;
}

interface StepResolution {
  current_step: string;
  current_step_detail: string | null;
  expected_step_duration_seconds: number;
  step_started_at: string;
  is_busy: boolean;
  error_message: string | null;
}

function resolveStep(
  brand: BrandStatusRow,
  qual: QualRow | null,
  contactsLatest: ContactRunRow | null,
): StepResolution {
  const enr = brand.enrichment_state ?? "pending";
  const qualState = brand.qualification_state ?? "pending";
  const contactsState = brand.contacts_state ?? "pending";
  const verdict = qual?.icp_verdict ?? null;
  // Phase 52: contact discovery is only auto-run on qualified brands.
  // For disqualified / needs_review / override_disqualified verdicts the
  // user manually clicks "Discover" — so a contacts_state='pending' row
  // should NOT be shown as queued.
  const skipContactsForVerdict =
    qualState === "complete" &&
    contactsState === "pending" &&
    (verdict === "disqualified" ||
      verdict === "needs_review" ||
      verdict === "override_disqualified");

  // Failed states win first — they short-circuit everything else.
  if (enr === "failed") {
    return {
      current_step: `Failed: ${brand.enrichment_error ?? "Amazon enrichment failed"}`,
      current_step_detail: null,
      expected_step_duration_seconds: 0,
      step_started_at: brand.updated_at,
      is_busy: false,
      error_message: brand.enrichment_error,
    };
  }
  if (qualState === "error") {
    return {
      current_step: `Failed: ${qual?.error_message ?? "Qualification failed"}`,
      current_step_detail: null,
      expected_step_duration_seconds: 0,
      step_started_at: qual?.updated_at ?? brand.updated_at,
      is_busy: false,
      error_message: qual?.error_message ?? "Qualification failed",
    };
  }
  if (contactsState === "error") {
    return {
      current_step: "Failed: Contact discovery failed",
      current_step_detail: null,
      expected_step_duration_seconds: 0,
      step_started_at: contactsLatest?.updated_at ?? brand.updated_at,
      is_busy: false,
      error_message: "Contact discovery failed",
    };
  }

  // Phase 1 — Keepa + DataForSEO enrichment.
  if (enr === "pending" || enr === "queued") {
    return {
      current_step: "Queued for enrichment",
      current_step_detail: null,
      expected_step_duration_seconds: 30,
      step_started_at: brand.updated_at,
      is_busy: true,
      error_message: null,
    };
  }
  if (enr === "enriching") {
    if (!brand.keepa_last_enriched_at) {
      return {
        current_step: "Fetching Amazon seller data (Keepa)",
        current_step_detail: null,
        expected_step_duration_seconds: 240,
        step_started_at: brand.updated_at,
        is_busy: true,
        error_message: null,
      };
    }
    return {
      current_step: "Pulling search trends (DataForSEO)",
      current_step_detail: null,
      expected_step_duration_seconds: 60,
      step_started_at: brand.keepa_last_enriched_at,
      is_busy: true,
      error_message: null,
    };
  }

  // Phase 2 — Qualification.
  if (enr === "enriched" && qualState === "pending") {
    return {
      current_step: "Queued for brand qualification",
      current_step_detail: null,
      expected_step_duration_seconds: 30,
      step_started_at: brand.dataforseo_last_enriched_at ?? brand.updated_at,
      is_busy: true,
      error_message: null,
    };
  }
  if (qualState === "running") {
    if (!qual || !qual.selected_entity) {
      return {
        current_step: "Disambiguating legal entity",
        current_step_detail: null,
        expected_step_duration_seconds: 60,
        step_started_at: qual?.updated_at ?? brand.updated_at,
        is_busy: true,
        error_message: null,
      };
    }
    if (!qual.icp_verdict) {
      return {
        current_step: "Running ICP analysis",
        current_step_detail: null,
        expected_step_duration_seconds: 60,
        step_started_at: qual.updated_at ?? brand.updated_at,
        is_busy: true,
        error_message: null,
      };
    }
    if (!qual.narrative_markdown) {
      return {
        current_step: "Generating analyst-memo narrative",
        current_step_detail: null,
        expected_step_duration_seconds: 90,
        step_started_at: qual.updated_at ?? brand.updated_at,
        is_busy: true,
        error_message: null,
      };
    }
    return {
      current_step: "Wrapping up qualification",
      current_step_detail: null,
      expected_step_duration_seconds: 30,
      step_started_at: qual.updated_at ?? brand.updated_at,
      is_busy: true,
      error_message: null,
    };
  }

  // Phase 3 — Contact discovery.
  if (
    qualState === "complete" &&
    contactsState === "pending" &&
    !skipContactsForVerdict
  ) {
    return {
      current_step: "Queued for contact discovery",
      current_step_detail: null,
      expected_step_duration_seconds: 30,
      step_started_at: qual?.updated_at ?? brand.updated_at,
      is_busy: true,
      error_message: null,
    };
  }
  if (contactsState === "running") {
    return {
      current_step:
        "Finding decision-maker contacts (Apollo + Hunter + MillionVerifier)",
      current_step_detail: null,
      expected_step_duration_seconds: 120,
      step_started_at: contactsLatest?.updated_at ?? brand.updated_at,
      is_busy: true,
      error_message: null,
    };
  }

  // All terminal states.
  return {
    current_step: "Done",
    current_step_detail: null,
    expected_step_duration_seconds: 0,
    step_started_at: brand.updated_at,
    is_busy: false,
    error_message: null,
  };
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data: brand } = await supabase
    .from("brands")
    .select(
      "id, created_at, updated_at, enrichment_state, enrichment_error, keepa_last_enriched_at, dataforseo_last_enriched_at, qualification_state, contacts_state",
    )
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle<BrandStatusRow>();
  if (!brand) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: qual } = await supabase
    .from("brand_qualifications")
    .select(
      "state, selected_entity, icp_verdict, narrative_markdown, error_message, updated_at, created_at",
    )
    .eq("brand_id", params.id)
    .maybeSingle<QualRow>();

  // We only need the latest contact row's timestamp to anchor the
  // contact-discovery elapsed-time clock. RLS on brand_contacts is the
  // user's own brand → safe under the user-scoped supabase client.
  const { data: contactsLatest } = await supabase
    .from("brand_contacts")
    .select("updated_at, created_at")
    .eq("brand_id", params.id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle<ContactRunRow>();

  const step = resolveStep(brand, qual, contactsLatest);

  // Stale marker: current step has been running > 1.5x its expected duration.
  let isStale = false;
  if (step.is_busy && step.expected_step_duration_seconds > 0) {
    const startedMs = new Date(step.step_started_at).getTime();
    if (!Number.isNaN(startedMs)) {
      const elapsedSec = (Date.now() - startedMs) / 1000;
      isStale = elapsedSec > step.expected_step_duration_seconds * 1.5;
    }
  }

  // Phase 52: contact discovery is opt-in (manual click) when the brand
  // is disqualified / needs_review / override_disqualified. The client
  // uses this flag to suppress the "Contact discovery" row in those cases.
  const verdict = qual?.icp_verdict ?? null;
  const contactsAutoSkipped =
    (brand.qualification_state ?? "pending") === "complete" &&
    (brand.contacts_state ?? "pending") === "pending" &&
    (verdict === "disqualified" ||
      verdict === "needs_review" ||
      verdict === "override_disqualified");

  return NextResponse.json({
    enrichment_state: brand.enrichment_state ?? "pending",
    qualification_state: brand.qualification_state ?? "pending",
    contacts_state: brand.contacts_state ?? "pending",
    icp_verdict: verdict,
    contacts_auto_skipped: contactsAutoSkipped,
    current_step: step.current_step,
    current_step_detail: step.current_step_detail,
    step_started_at: step.step_started_at,
    total_started_at: brand.created_at,
    last_updated_at: brand.updated_at,
    error_message: step.error_message,
    is_busy: step.is_busy,
    is_stale: isStale,
    expected_step_duration_seconds: step.expected_step_duration_seconds,
  });
}
