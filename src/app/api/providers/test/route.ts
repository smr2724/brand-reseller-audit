import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { testDataForSEO, isDataForSEOConfigured } from "@/lib/dataforseo";
import { testKeepa, isKeepaConfigured } from "@/lib/keepa";
import { testOpenAI, isOpenAIConfigured } from "@/lib/openai";
import { testApollo, isApolloConfigured } from "@/lib/apollo";
import { testOutlook } from "@/lib/outlook";
import { getStoredToken, isMicrosoftOAuthConfigured } from "@/lib/microsoft-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const provider = String(body?.provider ?? "");

  let result: any = { ok: false, error: "unknown provider" };
  if (provider === "supabase") {
    const { data: u } = await supabase.auth.getUser();
    result = { ok: !!u.user, user_email: u.user?.email };
  } else if (provider === "dataforseo") {
    result = isDataForSEOConfigured() ? await testDataForSEO() : { ok: false, error: "not configured" };
  } else if (provider === "keepa") {
    result = isKeepaConfigured() ? await testKeepa() : { ok: false, error: "not configured" };
  } else if (provider === "openai") {
    result = isOpenAIConfigured() ? await testOpenAI() : { ok: false, error: "not configured" };
  } else if (provider === "apollo") {
    result = isApolloConfigured() ? await testApollo() : { ok: false, error: "not configured" };
  } else if (provider === "outlook") {
    result = await testOutlook(user.id);
  }

  return NextResponse.json(result);
}

export async function GET() {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Differentiate three states for clarity:
  //   oauth_connected  — user has finished OAuth, stored refresh token
  //   legacy_env       — only the (expiring) OUTLOOK_ACCESS_TOKEN env var is set
  //   not_connected    — neither
  let mode: "oauth" | "legacy_env" | "none" = "none";
  let outlookEmail: string | null = null;
  if (user) {
    const stored = await getStoredToken(user.id);
    if (stored) {
      mode = "oauth";
      outlookEmail = stored.account_email;
    } else if (process.env.OUTLOOK_ACCESS_TOKEN) {
      mode = "legacy_env";
    }
  }
  const outlookConnected = mode === "oauth";

  return NextResponse.json({
    configured: {
      dataforseo: isDataForSEOConfigured(),
      keepa: isKeepaConfigured(),
      openai: isOpenAIConfigured(),
      apollo: isApolloConfigured(),
      outlook: outlookConnected,
      supabase: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    },
    outlook: {
      mode,
      connected: outlookConnected,
      account_email: outlookEmail,
      oauth_app_configured: isMicrosoftOAuthConfigured(),
    },
  });
}
