/**
 * Phase 57 — One-time backfill for the qualification `pitch_math` column.
 *
 * The Phase 50 narrative LLM was writing a hedged `pitch_math` JSON
 * (recoverable_share=0.65, "industry-standard reclaim is 60-70%"). This
 * script overwrites every existing brand_qualifications.pitch_math row
 * with the canonical 100%-recapture projection computed by
 * `computePitchMath`. The narrative_markdown column is NOT touched —
 * regenerating prose is a re-qualify operation, not a backfill, and the
 * runtime sanitizer will neutralize any stale hedging at read time too.
 *
 * Usage:
 *   npx tsx scripts/phase57-backfill-pitch-math.ts            # dry-run
 *   npx tsx scripts/phase57-backfill-pitch-math.ts --apply    # write
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment.
 */
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { computePitchMath } from "@/lib/qualification/pitch-math";
import type { Segment } from "@/lib/qualification/segments";
import { aggregateClassificationShares } from "@/lib/brand-detail/seller-classification-shares";

interface QualRow {
  id: string;
  brand_id: string;
  segment: string | null;
  channel_pattern: string | null;
  icp_verdict: string;
  ttm_revenue_estimate_usd: number | null;
  pitch_math: unknown;
}

interface SellerRow {
  share_pct: number | null;
  classification: string | null;
}

const QUALIFIED_SEGMENTS = new Set([
  "reseller_controlled",
  "authorized_network_healthy",
  "mixed_control",
  "brand_managed_with_leakage",
]);

export async function backfillPitchMath(opts: { apply: boolean }): Promise<{
  scanned: number;
  updated: number;
  skipped: number;
  errors: number;
}> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
  }

  // Scan every qualification row that has a non-null pitch_math. We
  // intentionally do NOT filter on icp_verdict — a stale pitch_math on a
  // brand that has since been downgraded should still be cleared (the
  // recompute below returns null for disqualified segments, which we
  // persist as `null`).
  const { data, error } = await admin
    .from("brand_qualifications")
    .select(
      "id, brand_id, segment, channel_pattern, icp_verdict, ttm_revenue_estimate_usd, pitch_math",
    )
    .not("pitch_math", "is", null);
  if (error) {
    throw new Error(`scan failed: ${error.message}`);
  }
  const rows: QualRow[] = (data ?? []) as QualRow[];

  let updated = 0;
  let skipped = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      const segment = (row.segment ?? row.channel_pattern) as Segment | null;
      if (!segment || !QUALIFIED_SEGMENTS.has(segment)) {
        // Disqualified or unknown segment — null out the pitch_math.
        if (opts.apply) {
          const { error: updErr } = await admin
            .from("brand_qualifications")
            .update({ pitch_math: null, updated_at: new Date().toISOString() })
            .eq("id", row.id);
          if (updErr) throw new Error(updErr.message);
        }
        updated += 1;
        continue;
      }

      // Compute the canonical reseller-controlled share from
      // brand_sellers. Same aggregation the brand-detail financial model
      // uses → the pitch math + brand page stay symmetric.
      const { data: sellers } = await admin
        .from("brand_sellers")
        .select("share_pct, classification")
        .eq("brand_id", row.brand_id);
      const sellerRows: SellerRow[] = (sellers ?? []) as SellerRow[];
      const shares = aggregateClassificationShares(
        sellerRows.map((s) => ({
          share_pct: typeof s.share_pct === "number" ? s.share_pct : null,
          classification: s.classification ?? null,
        })),
      );
      const isTight = segment === "authorized_network_healthy";
      const resellerControlledShare = isTight
        ? shares.authorized_share_pct
        : shares.reseller_share_pct;

      const pitchMath = computePitchMath({
        ttm_revenue_usd: row.ttm_revenue_estimate_usd,
        reseller_controlled_share: resellerControlledShare,
        segment,
      });

      if (opts.apply) {
        const { error: updErr } = await admin
          .from("brand_qualifications")
          .update({
            pitch_math: pitchMath,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        if (updErr) throw new Error(updErr.message);
      }
      updated += 1;
      console.log(
        `[backfill] brand=${row.brand_id} segment=${segment} ` +
          `ttm=${row.ttm_revenue_estimate_usd} share=${resellerControlledShare.toFixed(4)} ` +
          `delta=${pitchMath?.delta_profit_usd ?? "null"} ` +
          `exit_lift=${pitchMath?.exit_lift_usd ?? "null"}`,
      );
    } catch (e) {
      errors += 1;
      console.error(
        `[backfill] error on brand=${row.brand_id}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  return {
    scanned: rows.length,
    updated,
    skipped,
    errors,
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(
    `[phase57-backfill] ${apply ? "APPLY mode" : "DRY-RUN mode"} — overwriting LLM pitch_math with canonical projection`,
  );
  const result = await backfillPitchMath({ apply });
  console.log("[phase57-backfill] done:", result);
  if (!apply) {
    console.log(
      "[phase57-backfill] DRY-RUN — re-run with --apply to persist.",
    );
  }
}

// Run when invoked directly. Importable for unit tests.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
