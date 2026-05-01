/**
 * Microsoft OAuth helper.
 *
 * Implements the standard authorization-code flow against Microsoft Identity
 * Platform v2.0 with offline_access for refresh tokens.
 *
 *   1. /api/auth/microsoft/start       — redirect user to Microsoft login
 *   2. /api/auth/microsoft/callback    — exchange `code` for access + refresh tokens
 *   3. getValidOutlookToken(userId)    — return a fresh access token, refreshing if needed
 *
 * Tokens are stored in the `oauth_tokens` table keyed by (user_id, provider="microsoft").
 * Once the user connects, the refresh token is good for ~90 days of inactivity, and
 * each refresh call extends that window.
 */

import { createSupabaseAdminClient } from "@/lib/supabase/server";

function adminClient() {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is missing — required for Microsoft OAuth token storage.",
    );
  }
  return admin;
}

// Microsoft Identity v2.0 endpoints. Use "common" by default so any Microsoft
// account (work, school, or personal) can sign in. If you registered a
// single-tenant app, set MICROSOFT_TENANT_ID to your tenant GUID instead.
const TENANT = process.env.MICROSOFT_TENANT_ID || "common";
const AUTHORITY = `https://login.microsoftonline.com/${TENANT}`;
export const AUTH_URL = `${AUTHORITY}/oauth2/v2.0/authorize`;
export const TOKEN_URL = `${AUTHORITY}/oauth2/v2.0/token`;

// We need Mail.ReadWrite to create drafts in the user's mailbox, and
// offline_access to receive a refresh token. openid + profile + email give
// us the signed-in user's identity for display purposes.
export const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "Mail.ReadWrite",
  "Mail.Send",
].join(" ");

export const PROVIDER = "microsoft";

export function isMicrosoftOAuthConfigured(): boolean {
  return !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);
}

export function getRedirectUri(origin: string): string {
  // Allow override via env so we can use the production URL even from preview deploys
  // if needed. Otherwise mirror the request origin.
  return process.env.MICROSOFT_REDIRECT_URI || `${origin}/api/auth/microsoft/callback`;
}

export function buildAuthorizeUrl(opts: { origin: string; state: string }): string {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) throw new Error("MICROSOFT_CLIENT_ID missing");
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: getRedirectUri(opts.origin),
    response_mode: "query",
    scope: SCOPES,
    state: opts.state,
    prompt: "select_account",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  token_type: string;
  scope: string;
  expires_in: number;
  ext_expires_in?: number;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}

export async function exchangeCodeForTokens(opts: {
  code: string;
  origin: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID!,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
    code: opts.code,
    grant_type: "authorization_code",
    redirect_uri: getRedirectUri(opts.origin),
    scope: SCOPES,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Token exchange failed (${r.status}): ${text.slice(0, 300)}`);
  }
  return (await r.json()) as TokenResponse;
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID!,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: SCOPES,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Token refresh failed (${r.status}): ${text.slice(0, 300)}`);
  }
  return (await r.json()) as TokenResponse;
}

/**
 * Look up the signed-in user's email from Microsoft Graph using a fresh access
 * token. Used once at connect time so the settings page can show "Connected as ...".
 */
export async function fetchGraphMe(accessToken: string): Promise<{ email?: string; name?: string }> {
  try {
    const r = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return {};
    const d = await r.json();
    return {
      email: d.mail ?? d.userPrincipalName,
      name: d.displayName,
    };
  } catch {
    return {};
  }
}

export interface StoredOauthToken {
  user_id: string;
  provider: string;
  account_email: string | null;
  access_token: string;
  refresh_token: string;
  scope: string | null;
  expires_at: string;
}

/**
 * Save (or upsert) the OAuth token row after a successful authorization or refresh.
 */
export async function saveOauthToken(opts: {
  userId: string;
  accountEmail?: string | null;
  accessToken: string;
  refreshToken: string;
  scope?: string | null;
  expiresInSec: number;
}): Promise<void> {
  const admin = adminClient();
  const expiresAt = new Date(Date.now() + opts.expiresInSec * 1000).toISOString();
  const { error } = await admin.from("oauth_tokens").upsert(
    {
      user_id: opts.userId,
      provider: PROVIDER,
      account_email: opts.accountEmail ?? null,
      access_token: opts.accessToken,
      refresh_token: opts.refreshToken,
      scope: opts.scope ?? null,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" },
  );
  if (error) throw new Error(`saveOauthToken: ${error.message}`);
}

/**
 * Fetch the stored token row for a user, or null if they haven't connected.
 */
export async function getStoredToken(userId: string): Promise<StoredOauthToken | null> {
  const admin = adminClient();
  const { data } = await admin
    .from("oauth_tokens")
    .select("user_id, provider, account_email, access_token, refresh_token, scope, expires_at")
    .eq("user_id", userId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  return (data as StoredOauthToken | null) ?? null;
}

/**
 * Return a valid (non-expired) access token for the user, refreshing if needed.
 * Returns null if the user has not connected yet OR if the refresh token has
 * been revoked / expired (90+ days inactive).
 */
export async function getValidOutlookToken(userId: string): Promise<{
  accessToken: string;
  accountEmail: string | null;
} | null> {
  const stored = await getStoredToken(userId);
  if (!stored) return null;

  // Refresh if the token expires within the next 2 minutes (skew buffer).
  const now = Date.now();
  const expiresAt = new Date(stored.expires_at).getTime();
  if (expiresAt - now > 120_000) {
    return { accessToken: stored.access_token, accountEmail: stored.account_email };
  }

  // Refresh
  try {
    const fresh = await refreshAccessToken(stored.refresh_token);
    // Microsoft rotates refresh tokens; fall back to the old one if not returned.
    const newRefresh = fresh.refresh_token ?? stored.refresh_token;
    await saveOauthToken({
      userId,
      accountEmail: stored.account_email,
      accessToken: fresh.access_token,
      refreshToken: newRefresh,
      scope: fresh.scope ?? stored.scope,
      expiresInSec: fresh.expires_in,
    });
    return { accessToken: fresh.access_token, accountEmail: stored.account_email };
  } catch (e) {
    console.error("[microsoft-oauth] refresh failed:", e);
    return null;
  }
}

/**
 * Disconnect: delete the stored token row. The Microsoft consent itself
 * remains in the user's account until they revoke it from
 * https://myapps.microsoft.com — but this is enough to stop us from being
 * able to act on their mailbox.
 */
export async function disconnectMicrosoft(userId: string): Promise<void> {
  const admin = adminClient();
  await admin.from("oauth_tokens").delete().eq("user_id", userId).eq("provider", PROVIDER);
}
