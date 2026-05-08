/**
 * Phase 53 — per-visit log for the public /r/[token] page.
 *
 * Inserts one row per visit into `report_views` and decides whether the
 * aggregate `reports.views` counter should also be bumped. The counter is
 * meant to reflect *customer* engagement, so internal (steve@…) sessions
 * and bot crawlers/unfurlers are logged but not counted.
 *
 * All work is best-effort: callers wrap in try/catch and never let a
 * logging failure break the page render.
 */
import { headers } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const INTERNAL_EMAIL = "steve@rollemanagementgroup.com";
const UA_MAX = 500;

// Best-effort UA-based bot heuristic. We only need to catch the common
// link-unfurlers and big crawlers that would otherwise inflate the
// counter; missing some is fine — they just count as a customer view.
const BOT_UA_RE = /bot|crawler|spider|slurp|facebookexternalhit|embedly|preview|fetch|monitor|curl|wget|python-requests|axios|node-fetch|googlebot|bingbot|slackbot|discordbot|telegrambot|whatsapp|twitterbot|linkedinbot|applebot|duckduckbot|yandex|baiduspider|petalbot|semrushbot|ahrefsbot|mj12bot|archive\.org_bot|headlesschrome/i;

function isBotUA(ua: string | null): boolean {
  if (!ua) return true; // missing UA on a public URL is almost always a bot
  return BOT_UA_RE.test(ua);
}

function firstHop(xff: string | null): string | null {
  if (!xff) return null;
  const first = xff.split(",")[0]?.trim();
  return first || null;
}

export interface ViewLogResult {
  /** Insert succeeded. */
  inserted: boolean;
  /** Row counts toward the public counter (customer view). */
  isCustomerView: boolean;
  /** Marked internal (steve session) or bot. */
  isInternal: boolean;
}

/**
 * Capture request headers, classify the visit, INSERT into report_views,
 * and report whether the public counter should bump.
 */
export async function logReportView(
  admin: SupabaseClient,
  reportId: string,
): Promise<ViewLogResult> {
  let h: ReturnType<typeof headers>;
  try {
    h = headers();
  } catch {
    return { inserted: false, isCustomerView: false, isInternal: true };
  }

  const ua = (h.get("user-agent") ?? "").slice(0, UA_MAX) || null;
  const xff = h.get("x-forwarded-for");
  const ip = firstHop(xff) ?? h.get("x-real-ip") ?? null;
  const referrer = h.get("referer") || h.get("referrer") || null;
  const country = h.get("x-vercel-ip-country") || null;
  const city = (() => {
    const raw = h.get("x-vercel-ip-city");
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();
  const region = h.get("x-vercel-ip-country-region") || null;

  // Internal = signed-in steve@ session (admin viewing their own share)
  // OR a known bot UA. Either way, log but don't bump the public counter.
  let isSteve = false;
  try {
    const supa = createSupabaseServerClient();
    const { data } = await supa.auth.getUser();
    if (data?.user?.email?.toLowerCase() === INTERNAL_EMAIL) isSteve = true;
  } catch {
    /* anon session — fine */
  }

  const bot = isBotUA(ua);
  const isInternal = isSteve || bot;

  let inserted = false;
  try {
    const { error } = await admin.from("report_views").insert({
      report_id: reportId,
      ip_address: ip,
      user_agent: ua,
      referrer,
      country,
      city,
      region,
      is_internal: isInternal,
    });
    if (error) {
      console.error("[report-view-log] insert failed:", error.message);
    } else {
      inserted = true;
    }
  } catch (e) {
    console.error("[report-view-log] insert threw:", e);
  }

  return {
    inserted,
    isCustomerView: !isInternal,
    isInternal,
  };
}
