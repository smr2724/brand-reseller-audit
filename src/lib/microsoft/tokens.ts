/**
 * Phase 6.5 — Per-user Microsoft Graph token loader.
 *
 * Thin wrapper over the existing `microsoft-oauth` helpers so the new
 * `lib/microsoft/graph.ts` client doesn't have to know about the storage
 * shape of `oauth_tokens`. Refresh-on-expiry is delegated to
 * `getValidOutlookToken`, which rotates the refresh token where Microsoft
 * returns one.
 */
import {
  getStoredToken,
  getValidOutlookToken,
  type StoredOauthToken,
} from "@/lib/microsoft-oauth";

export interface UserGraphToken {
  accessToken: string;
  accountEmail: string | null;
}

/**
 * Return a fresh access token for the user, refreshing in-place if the
 * stored one is within ~2 minutes of expiry. Returns null if the user has
 * not connected, or if the refresh token has been revoked / expired.
 */
export async function loadUserGraphToken(userId: string): Promise<UserGraphToken | null> {
  return await getValidOutlookToken(userId);
}

/**
 * Inspect the raw stored row (without refreshing). Used by the
 * `/api/outlook/status` health check.
 */
export async function inspectStoredToken(userId: string): Promise<StoredOauthToken | null> {
  return await getStoredToken(userId);
}
