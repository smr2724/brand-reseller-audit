/**
 * Phase 34.2 — POST /api/owner-resolver/run-apollo
 *
 * Second leg of the brand-owner-resolver pipeline. The user reviews the
 * extractor candidates emitted by `resolveBrandOwner` (Phase 1) on the
 * brand page and picks which ones to look up in Apollo. This route runs
 * the 3-tier Apollo search for each selected candidate, persists the
 * resulting orgs as `apollo` rows linked back to the originating
 * extractor row, and writes the request/response audit trail to
 * `owner_resolution_runs.raw_apollo_payload`.
 *
 * Body: { brand_id: string, candidate_ids: UUID[] }
 *
 * Auth: same helper as the rest of the resolver — Supabase user session
 * matching `brands.user_id`, or CRON_SECRET / service-role bearer.
 *
 * State: brand must be in `awaiting_apollo_selection`. The CAS RPC
 * `claim_apollo_enrichment_run` flips it to `enriching_apollo`
 * atomically; a stale double-click that loses the race gets a 409.
 *
 * The route returns quickly after kicking off the Apollo work via
 * `waitUntil`. The client polls /api/owner-resolver/candidates for the
 * `candidates_ready` transition.
 *
 * Safety belts (NEVER remove):
 *   runtime = nodejs
 *   dynamic = force-dynamic
 *   fetchCache = force-no-store
 *   revalidate = 0
 *   maxDuration = 300
 */
import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { authorizeOwnerResolverRequest } from "@/lib/owner-resolver/auth";
import {
  enrichSelectedCandidatesWithApollo,
  type ExtractorCandidateRow,
} from "@/lib/owner-resolver/resolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 300;

const Body = z.object({
  brand_id: z.string().trim().min(1),
  candidate_ids: z.array(z.string().trim().min(1)).min(1).max(50),
});

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = Body.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", details: parsed.error.format() },
      { status: 400 },
    );
  }
  const { brand_id, candidate_ids } = parsed.data;

  const auth = await authorizeOwnerResolverRequest(req, brand_id);
  if (auth.kind === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  // Verify the latest run exists and the candidate ids belong to it.
  const { data: runs } = await admin
    .from("owner_resolution_runs")
    .select("id")
    .eq("brand_id", brand_id)
    .order("started_at", { ascending: false })
    .limit(1);
  const latestRunId = ((runs ?? [])[0] as { id?: string } | undefined)?.id ?? null;
  if (!latestRunId) {
    return NextResponse.json(
      { error: "brand has no resolution runs" },
      { status: 400 },
    );
  }

  const { data: cands, error: candErr } = await admin
    .from("owner_candidates")
    .select(
      "id, brand_id, resolution_run_id, candidate_company_name, candidate_domain, extractor_confidence, extractor_reasoning, evidence_urls, candidate_source",
    )
    .in("id", candidate_ids)
    .eq("brand_id", brand_id)
    .eq("resolution_run_id", latestRunId);
  if (candErr) {
    return NextResponse.json(
      { error: `failed to load candidates: ${candErr.message}` },
      { status: 500 },
    );
  }
  const rows = (cands ?? []) as Array<
    ExtractorCandidateRow & { candidate_source: string }
  >;
  if (rows.length !== candidate_ids.length) {
    return NextResponse.json(
      {
        error:
          "one or more candidate_ids do not belong to this brand's latest run",
      },
      { status: 400 },
    );
  }
  // Only extractor / extractor_manual rows are valid Phase-2 inputs.
  for (const r of rows) {
    if (
      r.candidate_source !== "extractor" &&
      r.candidate_source !== "extractor_manual"
    ) {
      return NextResponse.json(
        {
          error: `candidate ${r.id} is not an extractor row (source=${r.candidate_source})`,
        },
        { status: 400 },
      );
    }
  }

  // CAS-flip awaiting_apollo_selection -> enriching_apollo. If lost, 409.
  const { data: claimRows, error: claimErr } = await admin.rpc(
    "claim_apollo_enrichment_run",
    { p_brand_id: brand_id },
  );
  if (claimErr) {
    return NextResponse.json(
      { error: `claim RPC failed: ${claimErr.message}` },
      { status: 500 },
    );
  }
  const claimed =
    Array.isArray(claimRows) &&
    claimRows.length > 0 &&
    (claimRows[0] as { claimed?: boolean }).claimed === true;
  if (!claimed) {
    return NextResponse.json(
      {
        error:
          "brand is not in awaiting_apollo_selection — refresh the page",
      },
      { status: 409 },
    );
  }

  // Kick off Apollo enrichment in the background; return quickly so the
  // user sees the new state immediately and the client can poll.
  const work = runApolloEnrichment(admin, brand_id, latestRunId, rows).catch(
    (e: unknown) => {
      console.error(
        "[owner-resolver] apollo enrichment failed",
        brand_id,
        e instanceof Error ? e.message : String(e),
      );
    },
  );
  try {
    waitUntil(work);
  } catch {
    // Outside a Vercel request context — promise still completes.
  }

  return NextResponse.json({
    ok: true,
    state: "enriching_apollo",
    selected_count: rows.length,
  });
}

async function runApolloEnrichment(
  admin: SupabaseClient,
  brandId: string,
  runId: string,
  candidates: ReadonlyArray<ExtractorCandidateRow>,
): Promise<void> {
  const result = await enrichSelectedCandidatesWithApollo(
    admin,
    brandId,
    runId,
    candidates,
  );

  // Persist audit trail no matter what (success or partial failure).
  const { data: existingRun } = await admin
    .from("owner_resolution_runs")
    .select("raw_apollo_payload")
    .eq("id", runId)
    .maybeSingle();
  const existingPayload =
    (existingRun as { raw_apollo_payload?: unknown } | null)
      ?.raw_apollo_payload ?? null;
  const existingArr =
    Array.isArray(existingPayload) ? existingPayload : [];
  const merged = [
    ...existingArr,
    ...result.audit_entries,
  ];
  await admin
    .from("owner_resolution_runs")
    .update({ raw_apollo_payload: merged })
    .eq("id", runId);

  if (!result.ok) {
    await admin
      .from("owner_resolution_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_message: result.error ?? "apollo enrichment failed",
      })
      .eq("id", runId);
    await admin
      .from("brands")
      .update({
        owner_resolution_state: "failed",
        owner_resolution_error:
          result.error ?? "apollo enrichment failed",
      })
      .eq("id", brandId);
    return;
  }

  await admin
    .from("owner_resolution_runs")
    .update({
      status: "succeeded",
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
  await admin
    .from("brands")
    .update({
      owner_resolution_state: "candidates_ready",
      owner_resolution_error: null,
    })
    .eq("id", brandId);
}
