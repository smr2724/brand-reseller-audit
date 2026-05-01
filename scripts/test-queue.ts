// Smoke test for the /api/brands/queue ordering.
// Connects with a service-role key, fetches the user's brands, applies the
// same priority-score formula used by the API, and prints the top 20.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... USER_ID=... \
//     npx tsx scripts/test-queue.ts
//
// All three env vars are required. We do NOT hardcode any IDs.

import { createClient } from "@supabase/supabase-js";
import { sortQueue } from "../src/lib/queue";

async function main() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const userId = process.env.USER_ID;

  if (!url || !key || !userId) {
    console.log("provide SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + USER_ID");
    console.log("example:");
    console.log("  SUPABASE_URL=https://xxx.supabase.co \\");
    console.log("  SUPABASE_SERVICE_ROLE_KEY=eyJ... \\");
    console.log("  USER_ID=00000000-0000-0000-0000-000000000000 \\");
    console.log("    npx tsx scripts/test-queue.ts");
    process.exit(0);
  }

  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("brands")
    .select("id, name, brand_score, est_monthly_revenue, manual_notes, dominant_seller_sales_pct, disqualifier_tags, status, last_reviewed_at")
    .eq("user_id", userId)
    .not("status", "in", '("disqualified","client")')
    .or(`last_reviewed_at.is.null,last_reviewed_at.lt.${oneDayAgo}`)
    .limit(500);

  if (error) {
    console.error("query failed:", error.message);
    process.exit(1);
  }

  const sorted = sortQueue(data ?? []).slice(0, 20);

  console.log(`fetched ${data?.length ?? 0} brands; top 20 by priority:`);
  console.log();
  console.log(
    "rank".padStart(4),
    "score".padStart(6),
    "brand".padEnd(36),
    "bs".padStart(4),
    "rev".padStart(12),
    "dom%".padStart(5),
    "tags",
  );
  sorted.forEach((b, i) => {
    console.log(
      String(i + 1).padStart(4),
      b.priority_score.toFixed(1).padStart(6),
      (b.name ?? "").slice(0, 36).padEnd(36),
      String(b.brand_score ?? "—").padStart(4),
      String(b.est_monthly_revenue ?? "—").padStart(12),
      (b.dominant_seller_sales_pct == null
        ? "—"
        : (Number(b.dominant_seller_sales_pct) * 100).toFixed(0) + "%").padStart(5),
      (b.disqualifier_tags ?? []).join(",")
    );
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
