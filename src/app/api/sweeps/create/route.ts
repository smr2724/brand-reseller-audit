import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createAdminClient, dispatchJobs, getInternalToken } from "@/lib/jobs";

export const maxDuration = 30;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const seeds = (Array.isArray(body?.seeds) ? body.seeds : [])
    .map((s: any) => String(s ?? "").trim())
    .filter(Boolean);
  const depth = String(body?.depth ?? "standard") as "quick" | "standard" | "deep";
  const name = String(body?.name ?? "").trim() || `Sweep · ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;

  if (!seeds.length) return NextResponse.json({ error: "at least one seed required" }, { status: 400 });
  if (seeds.length > 50) return NextResponse.json({ error: "max 50 seeds per sweep" }, { status: 400 });

  // Dedupe (case-insensitive)
  const seen = new Set<string>();
  const unique = seeds.filter((s: string) => {
    const k = s.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Create sweep + jobs
  const { data: sweep, error: sErr } = await supabase
    .from("sweeps")
    .insert({
      user_id: user.id,
      name,
      seed_keywords: unique,
      total_jobs: unique.length,
      status: "pending",
      started_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (sErr || !sweep) return NextResponse.json({ error: sErr?.message ?? "failed to create sweep" }, { status: 500 });

  const rows = unique.map((seed: string) => ({
    user_id: user.id,
    type: "scan",
    status: "pending",
    parent_sweep_id: sweep.id,
    payload: { seed_keyword: seed, depth },
  }));
  const { error: jErr } = await supabase.from("jobs").insert(rows);
  if (jErr) return NextResponse.json({ error: jErr.message }, { status: 500 });

  // Kick the dispatcher
  try {
    const admin = createAdminClient();
    const internal = getInternalToken();
    dispatchJobs(admin, user.id, internal).catch(() => {});
  } catch {}

  return NextResponse.json({ ok: true, sweep_id: sweep.id, total: unique.length });
}
