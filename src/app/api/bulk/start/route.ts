/**
 * Phase 75 — POST /api/bulk/start.
 *
 * Parses the pasted brand list, opens a bulk_runs row, queues one
 * bulk_run_brands row per parsed name, and kicks off the worker
 * fire-and-forget. The worker route self-recurses through brands one
 * at a time under CRON_SECRET.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";
import { parseBrandList } from "@/lib/bulk/parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const Body = z.object({
  raw_input: z.string().min(1).max(50_000),
});

const MAX_BRANDS = 100;

function resolveOrigin(req: Request): string {
  const envBase = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "raw_input required" }, { status: 400 });
  }

  const brands = parseBrandList(parsed.data.raw_input);
  if (brands.length === 0) {
    return NextResponse.json(
      { error: "no brands parsed from input" },
      { status: 400 },
    );
  }
  if (brands.length > MAX_BRANDS) {
    return NextResponse.json(
      {
        error: `too many brands — bulk runs are capped at ${MAX_BRANDS} per submission (received ${brands.length}).`,
      },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  const { data: run, error: runErr } = await admin
    .from("bulk_runs")
    .insert({
      user_id: user.id,
      status: "pending",
      total_brands: brands.length,
    })
    .select("id")
    .single();
  if (runErr || !run) {
    return NextResponse.json(
      { error: runErr?.message ?? "failed to create bulk_runs row" },
      { status: 500 },
    );
  }

  const rows = brands.map((name, i) => ({
    bulk_run_id: run.id,
    position: i + 1,
    input_name: name,
    status: "queued",
    progress_percent: 0,
    current_step_label: "Queued",
  }));

  const { error: rowsErr } = await admin.from("bulk_run_brands").insert(rows);
  if (rowsErr) {
    return NextResponse.json(
      { error: rowsErr.message },
      { status: 500 },
    );
  }

  // Fire-and-forget kick the worker. Do NOT await — the worker can
  // run for minutes per brand and we want to return to the UI fast.
  const origin = resolveOrigin(req);
  const workerUrl = `${origin}/api/bulk/${run.id}/worker`;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    fetch(workerUrl, {
      method: "POST",
      headers: { "x-cron-secret": cronSecret },
      cache: "no-store",
    }).catch((e) => {
      console.warn("[bulk/start] worker kickoff failed:", String(e?.message ?? e));
    });
  } else {
    // Dev fallback: try kicking anyway.
    fetch(workerUrl, { method: "POST", cache: "no-store" }).catch(() => undefined);
  }

  return NextResponse.json({
    run_id: run.id,
    total_brands: brands.length,
    parsed_brands: brands,
  });
}
