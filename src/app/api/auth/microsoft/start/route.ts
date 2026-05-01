import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  buildAuthorizeUrl,
  isMicrosoftOAuthConfigured,
} from "@/lib/microsoft-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kick off Microsoft OAuth. Generates a CSRF state, stashes it in an httpOnly
 * cookie, and 302s the user to login.microsoftonline.com.
 */
export async function GET(req: NextRequest) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (!isMicrosoftOAuthConfigured()) {
    return NextResponse.json(
      {
        error:
          "Microsoft OAuth not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in Vercel.",
      },
      { status: 500 },
    );
  }

  const state = randomBytes(24).toString("base64url");
  const url = buildAuthorizeUrl({ origin: req.nextUrl.origin, state });

  const res = NextResponse.redirect(url);
  res.cookies.set("ms_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 600, // 10 minutes
  });
  return res;
}
