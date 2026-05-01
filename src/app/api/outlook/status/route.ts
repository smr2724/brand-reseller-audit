/**
 * Phase 6.5 — Outlook health check.
 *
 * Used by `BrandOutreachCard` and the report Email button to gate their
 * primary CTAs and surface a "Connect Outlook" prompt when the user
 * hasn't connected (or their refresh token has been revoked).
 */
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { inspectStoredToken } from "@/lib/microsoft/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const stored = await inspectStoredToken(user.id);
  if (!stored) {
    return NextResponse.json({
      connected: false,
      expires_at: null,
      scope: null,
      account_email: null,
      auth_url: "/api/auth/microsoft/start",
    });
  }
  return NextResponse.json({
    connected: true,
    expires_at: stored.expires_at,
    scope: stored.scope,
    account_email: stored.account_email,
    auth_url: "/api/auth/microsoft/start",
  });
}
