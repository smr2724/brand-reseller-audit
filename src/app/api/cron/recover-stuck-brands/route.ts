/**
 * Phase 29 — Stuck-brand recovery cron.
 * Phase 30 — Filter by `enrichment_state` (pending|failed only), add a
 * Keepa token-budget gate, bound the per-run batch size, and add an env
 * kill-switch so we can disable the sweep without redeploying when Keepa
 * is throttled.
 *
 * Mirrors /api/cron/recover-stuck-reports (Phase 21). Runs every 5 minutes
 * (see vercel.json).
 *
 * Triggered by the H2O Therapy bug: /api/brands/create-from-lookup hit
 * its Vercel maxDuration before Keepa enrichment finished, leaving the
 * brand permanently stuck (0 ASINs, 0 sellers, 0 reports). Without this
 * sweep the user has to manually delete + retry.
 *
 * Safety belts (NEVER remove):
 *   runtime = nodejs
 *   dynamic = force-dynamic
 *   fetchCache = force-no-store
 *   revalidate = 0
 *   maxDuration = 300
 */
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import {
  findStuckBrands,
  recoverStuckBrand,
  shouldSkipForTokenBudget,
  RECOVERY_BRAND_BATCH_LIMIT,
  STUCK_BRAND_THRESHOLD_MS,
  TOKEN_BUDGET_FLOOR,
} from "@/lib/brand/recover-stuck-brands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 300;

function authorize(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true; // dev: permit when not configured
  const auth = req.headers.get("authorization") ?? "";
  if (auth === `Bearer ${expected}`) return true;
  const cronHeader = req.headers.get("x-vercel-cron-signature");
  if (cronHeader && cronHeader === expected) return true;
  return false;
}

function isEnabled(): boolean {
  const v = (process.env.RECOVER_STUCK_BRANDS_ENABLED ?? "true").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "off";
}

function isDisabledKillSwitch(): boolean {
  const v = (process.env.RECOVER_STUCK_BRANDS_DISABLED ?? "").trim().toLowerCase();
  return v === "true";
}

function batchLimit(): number {
  const raw = process.env.RECOVER_MAX_BRANDS_PER_RUN;
  if (!raw) return RECOVERY_BRAND_BATCH_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return RECOVERY_BRAND_BATCH_LIMIT;
  return Math.min(25, Math.floor(n));
}

export async function GET(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (isDisabledKillSwitch()) {
    console.warn(
      "[cron/recover-stuck-brands] kill-switch active via RECOVER_STUCK_BRANDS_DISABLED=true — no DB or Keepa work performed",
    );
    return NextResponse.json({ skipped: true, reason: "kill_switch" });
  }

  if (!isEnabled()) {
    console.warn("[cron/recover-stuck-brands] disabled via RECOVER_STUCK_BRANDS_ENABLED=false");
    return NextResponse.json({ skipped: true, reason: "disabled" });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "server missing SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 },
    );
  }

  // Token budget gate — abort BEFORE touching DB or Keepa. Prevents the
  // cron from grinding through retries on a depleted account.
  const budget = await shouldSkipForTokenBudget(TOKEN_BUDGET_FLOOR);
  if (budget.skip) {
    console.warn("[cron/recover-stuck-brands] skipped: token budget", {
      tokens_left: budget.tokens_left,
      floor: TOKEN_BUDGET_FLOOR,
    });
    return NextResponse.json({
      skipped: true,
      reason: "token_budget",
      tokens_left: budget.tokens_left,
    });
  }

  const limit = batchLimit();
  const stuck = await findStuckBrands(admin, STUCK_BRAND_THRESHOLD_MS, limit);
  console.log("[cron/recover-stuck-brands] candidates", {
    count: stuck.length,
    limit,
    tokens_left: budget.tokens_left,
    ids: stuck.map((s) => s.id),
  });

  if (stuck.length === 0) {
    return NextResponse.json({ processed: 0, tokens_left: budget.tokens_left });
  }

  const results: Array<{
    brand_id: string;
    status: string;
    asin_count?: number;
    error?: string;
  }> = [];
  for (const b of stuck) {
    const res = await recoverStuckBrand(admin, b);
    results.push(res);
  }

  return NextResponse.json({
    processed: results.length,
    tokens_left: budget.tokens_left,
    results,
  });
}
