import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createAdminClient, dispatchJobs, getInternalToken } from "@/lib/jobs";

export const maxDuration = 30;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kick the dispatcher: pick up pending jobs for the current user and fire workers.
 * Returns immediately. Safe to call multiple times.
 */
export async function POST() {
  const userClient = createSupabaseServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let internal: string;
  try {
    internal = getInternalToken();
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "internal token missing" }, { status: 500 });
  }

  const admin = createAdminClient();
  const result = await dispatchJobs(admin, user.id, internal);
  return NextResponse.json({ ok: true, ...result });
}
