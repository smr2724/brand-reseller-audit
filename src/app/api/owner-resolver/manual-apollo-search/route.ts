/**
 * Phase 34.1 — POST /api/owner-resolver/manual-apollo-search
 *
 * User-driven fallback for cases where the auto-resolver missed. Takes a
 * company name from the brand page, runs Apollo's 3-tier fallback, and
 * inserts the resulting orgs as `apollo_manual` candidates tied to the
 * brand's latest resolution run.
 *
 * Body: { brand_id: string, company_name: string }
 * Returns: { ok, inserted_count, candidate_ids[], tier_used, no_match? }
 *
 * Auth: Supabase user session whose user_id matches `brands.user_id`.
 * Cron / service-role bearer is also accepted for ops use.
 *
 * Rate limit: 5 requests per `brand_id` per 10 minutes (sliding-window,
 * per-process). Returns HTTP 429 with `retry_after_seconds` when exceeded.
 *
 * State handling: does NOT change `brands.owner_resolution_state`. The
 * brand stays in 'candidates_ready' so the existing checkbox + Save flow
 * still picks the actual owner.
 *
 * Safety belts (NEVER remove):
 *   runtime = nodejs
 *   dynamic = force-dynamic
 *   fetchCache = force-no-store
 *   revalidate = 0
 *   maxDuration = 60
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { authorizeOwnerResolverRequest } from "@/lib/owner-resolver/auth";
import { createApolloClient } from "@/lib/owner-resolver/apollo-client";
import { checkSlidingWindow } from "@/lib/owner-resolver/rate-limit";
import {
  buildManualNoMatchRow,
  runManualApolloSearch,
} from "@/lib/owner-resolver/manual-apollo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 60;

const Body = z.object({
  brand_id: z.string().trim().min(1),
  company_name: z.string().trim().min(1).max(200),
});

const RATE_LIMIT_PER_BRAND = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

interface InsertedRow {
  id: string;
  apollo_organization_name: string | null;
  apollo_organization_id: string | null;
}

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
  const { brand_id, company_name } = parsed.data;

  const auth = await authorizeOwnerResolverRequest(req, brand_id);
  if (auth.kind === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Sliding-window rate limit per brand_id (5 / 10 min).
  const decision = checkSlidingWindow(
    `manual-apollo:${brand_id}`,
    RATE_LIMIT_PER_BRAND,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!decision.allowed) {
    return NextResponse.json(
      {
        error: "rate limit exceeded — try again later",
        retry_after_seconds: Math.ceil(decision.retry_after_ms / 1000),
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(decision.retry_after_ms / 1000)),
        },
      },
    );
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  // Find the latest resolution run so we can attach the manual rows to it.
  const { data: runs } = await admin
    .from("owner_resolution_runs")
    .select("id")
    .eq("brand_id", brand_id)
    .order("started_at", { ascending: false })
    .limit(1);
  const latestRunId = ((runs ?? [])[0] as { id?: string } | undefined)?.id ?? null;
  if (!latestRunId) {
    return NextResponse.json(
      {
        error:
          "brand has no resolution runs — trigger the resolver first before searching Apollo manually",
      },
      { status: 400 },
    );
  }

  const apollo = createApolloClient();
  const search = await runManualApolloSearch(brand_id, company_name, apollo);

  const rowsToInsert =
    search.no_match || search.rows.length === 0
      ? [buildManualNoMatchRow(brand_id, latestRunId, company_name)]
      : search.rows.map((r) => ({ ...r, resolution_run_id: latestRunId }));

  // Phase 34.7 — supabase-js `.upsert(..., { onConflict })` blew up
  // with SQLSTATE 42P10 because the unique index uses expressions
  // (lower(name), COALESCE(...)) and PostgREST's emitted ON CONFLICT
  // target only references plain columns. Delegate to a SECURITY
  // DEFINER function that runs the INSERT with a matching expression
  // ON CONFLICT clause and returns the inserted rows.
  const { data: insRows, error: insErr } = await admin.rpc(
    "insert_owner_candidates_dedup",
    { rows: rowsToInsert as unknown as object[] },
  );
  if (insErr) {
    return NextResponse.json(
      { error: `insert failed: ${insErr.message}` },
      { status: 500 },
    );
  }
  const inserted: InsertedRow[] = ((insRows ?? []) as InsertedRow[]).map((r) => ({
    id: r.id,
    apollo_organization_name: r.apollo_organization_name ?? null,
    apollo_organization_id: r.apollo_organization_id ?? null,
  }));

  return NextResponse.json({
    ok: true,
    inserted_count: inserted.length,
    candidate_ids: inserted.map((r) => r.id),
    tier_used: search.tier_used,
    no_match: search.no_match,
    rate_limit_remaining: decision.remaining,
  });
}
