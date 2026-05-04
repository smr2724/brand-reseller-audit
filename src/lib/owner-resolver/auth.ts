/**
 * Phase 33 (review fix M10/B1/B4) — Single auth helper for owner-resolver
 * routes. Resolves to one of:
 *   - { kind: 'admin' }           CRON_SECRET / x-vercel-cron-signature / service-role
 *   - { kind: 'user', userId }    valid Supabase session matching brand.user_id
 *   - { kind: 'unauthorized' }    no valid credential
 *
 * The page and the API routes call this same helper so behavior is uniform.
 * The browser never needs a bearer.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";

export type OwnerResolverAuth =
  | { kind: "admin"; userId: null }
  | { kind: "user"; userId: string }
  | { kind: "unauthorized" };

function bearerMatchesSecret(req: Request): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const cronHeader = req.headers.get("x-vercel-cron-signature");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    if (auth === `Bearer ${cronSecret}`) return true;
    if (cronHeader && cronHeader === cronSecret) return true;
  }
  const sr = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (sr && auth === `Bearer ${sr}`) return true;
  return false;
}

/**
 * Authorize an owner-resolver API request. If `brandId` is supplied, the
 * user-session path additionally verifies `brands.user_id = current_user.id`.
 * If `brandId` is null, only the bearer path is accepted.
 */
export async function authorizeOwnerResolverRequest(
  req: Request,
  brandId: string | null,
): Promise<OwnerResolverAuth> {
  if (bearerMatchesSecret(req)) {
    return { kind: "admin", userId: null };
  }

  // Fall through to user-session check.
  let supabase;
  try {
    supabase = createSupabaseServerClient();
  } catch {
    return { kind: "unauthorized" };
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: "unauthorized" };

  if (!brandId) {
    // Routes that must be brand-scoped should always pass a brandId; if
    // not, deny rather than grant blanket access.
    return { kind: "unauthorized" };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return { kind: "unauthorized" };
  const { data: brand } = await admin
    .from("brands")
    .select("user_id")
    .eq("id", brandId)
    .maybeSingle();
  if (!brand) return { kind: "unauthorized" };
  const ownerId = (brand as { user_id: string | null }).user_id;
  if (!ownerId || ownerId !== user.id) return { kind: "unauthorized" };
  return { kind: "user", userId: user.id };
}

/**
 * Variant for the server page: returns user info if the caller is allowed
 * to view the brand. No bearer-bypass — the page is browser-only.
 */
export async function authorizeBrandPageView(
  brandId: string,
): Promise<{ allowed: boolean; userId: string | null; admin: SupabaseClient | null }> {
  let supabase;
  try {
    supabase = createSupabaseServerClient();
  } catch {
    return { allowed: false, userId: null, admin: null };
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { allowed: false, userId: null, admin: null };
  const admin = createSupabaseAdminClient();
  if (!admin) return { allowed: false, userId: user.id, admin: null };
  const { data: brand } = await admin
    .from("brands")
    .select("user_id")
    .eq("id", brandId)
    .maybeSingle();
  if (!brand) return { allowed: false, userId: user.id, admin };
  const ownerId = (brand as { user_id: string | null }).user_id;
  if (!ownerId || ownerId !== user.id) {
    return { allowed: false, userId: user.id, admin };
  }
  return { allowed: true, userId: user.id, admin };
}
