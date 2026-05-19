/**
 * Phase 4 — single-brand Keepa enrichment orchestrator.
 *
 * Steps:
 *  1) Insert enrichment_runs row (status=running)
 *  2) Search Keepa for ASINs under brand name
 *  3) Batch-fetch product/offer details (chunks of 5)
 *  4) Upsert brand_asins
 *  5) Aggregate brand_sellers (replace per brand)
 *  6) Compute brand-level keepa_* summary + validation_score
 *  7) Mark run completed; stamp keepa_last_enriched_at
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  searchProductsByBrand,
  getProductDetails,
  KEEPA_PRODUCT_BATCH_MAX,
  resolveSellerInfo,
  isAmazonSellerId,
  expandVariationAsins,
  consumeKeepaProductRetryCount,
  type KeepaProductDetails,
} from "@/lib/keepa";
import { makeSellerCache } from "./keepa-seller-cache";
import {
  reapStaleRuns,
  shouldAbortForWallClock,
  withDeadline,
  logKeepaProgress,
  classifyTerminalStatus,
  KEEPA_ENRICHMENT_WALL_CLOCK_MS,
  KEEPA_HARD_ASIN_CAP,
} from "./keepa-run-defense";
import {
  computeValidationScore,
  computeCombinedValidationScore,
  type DataForSeoSignals,
} from "./scoring";
import {
  classifySellers,
  aggregateBrandControlledShare,
  amazon1pThreshold,
  isAmazon1pBrand,
  AMAZON_RETAIL_SELLER_ID,
  type SellerClassification,
} from "./seller-classification";
import { rankToMonthlyUnits } from "./revenue-estimator";
import {
  attributeVariationSales,
  indexAttributionByAsin,
} from "./variation-attribution";

export interface EnrichmentSummary {
  run_id: string;
  brand_id: string;
  asin_count: number;
  unique_seller_count: number;
  brand_controlled_pct: number | null;
  top_seller: string | null;
  /**
   * Phase 84 follow-up — buy-box share of the top reseller. This is the
   * "fraction of ASINs whose Buy Box this seller wins" number, preserved
   * exactly so `computeValidationScore` / `computeCombinedValidationScore`
   * keep producing the same magnitudes they were tuned on. Stored on
   * `brands.keepa_top_seller_share_pct`. Renderers that want the modal's
   * offer-share metric should read `top_seller_offer_share_pct` instead.
   */
  top_seller_share_pct: number | null;
  /**
   * Phase 84 — offer share of the top reseller (offer_count / total_live_offers
   * across the brand catalog). This is the metric that makes the modal's
   * bar chart meaningful — a brand with 30 active sellers should show a
   * long-tail distribution, not a 33/33/33 split. NOT used by scoring;
   * scoring continues to use `top_seller_share_pct` (buy-box share).
   */
  top_seller_offer_share_pct: number | null;
  avg_offers: number | null;
  validation_score: number | null;
  tokens_used: number;
  amazon_1p_share: number;
  /** Phase 23 — true when Amazon retail (ATVPDKIKX0DER) holds ≥
   * AMAZON_1P_THRESHOLD_PCT of buy boxes. Triggers the not_a_fit report
   * shape upstream. */
  amazon_1p_disqualified: boolean;
  enrichment_error: string | null;
  /**
   * Phase 79 — number of times the Keepa /product call retried after a
   * fetchWithTimeout abort during this enrichment. The bulk worker reads
   * this to increment `bulk_run_brands.retry_count`. 0 on a clean run.
   */
  keepa_product_retry_count: number;
  /**
   * Phase 66 partial-save — true when the /product fetch failed
   * mid-stream (withDeadline trip or Keepa 429 cascade) but at least
   * one chunk landed successfully, so the brand was still marked
   * `enriched` with the prefix of products we did get. The UI uses
   * this (mirrored on `brands.enrichment_metadata.partial_save`) to
   * render a "partial coverage" badge. False on a clean full run.
   */
  partial_save: boolean;
  /** Phase 66 — first 500 chars of the inner /product error when
   * `partial_save` is true. Null on a clean run. */
  partial_reason: string | null;
}

export interface EnrichInput {
  brand_id: string;
  brand_name: string;
  user_id: string;
  existing_disqualifier_tags?: string[];
  /**
   * Phase 82 review fix #1 — optional async heartbeat invoked at each
   * major step boundary inside enrichBrandWithKeepa. The bulk pipeline
   * passes this to bump `bulk_runs.updated_at` so the janitor's stuck
   * filter (90s on run-level updated_at) does not flag a healthy but
   * legitimately slow enrich as stale. Best-effort — caller swallows
   * errors.
   */
  heartbeat?: () => Promise<void>;
}

export async function enrichBrandWithKeepa(
  supabase: SupabaseClient<any, any, any>,
  input: EnrichInput,
): Promise<EnrichmentSummary> {
  const { brand_id, brand_name, user_id } = input;
  const existingTags = new Set<string>(input.existing_disqualifier_tags ?? []);
  const runStartedAtMs = Date.now();
  // Phase 82 review fix #1 — heartbeat helper. Wraps the optional
  // caller-supplied callback in a try/catch so a heartbeat failure
  // never derails enrichment.
  const heartbeat = async (): Promise<void> => {
    if (!input.heartbeat) return;
    try {
      await input.heartbeat();
    } catch {
      // best-effort; ignore
    }
  };

  // Phase 66 — Before starting a new run, mark any prior `running` row
  // for the same brand as `error` if it has been wedged past the stale
  // threshold. Sport-Tek accumulated 4 such rows (3, 13, 23, and 37
  // minute hangs) because the orchestrator was killed by Vercel before
  // it could write a terminal state. Without this reaper, the
  // enrichment_runs table grows orphan rows indefinitely and the next
  // user retry just adds another wedged row.
  await reapStaleRuns(supabase, brand_id, "keepa");

  const runIns = await supabase
    .from("enrichment_runs")
    .insert({
      user_id,
      brand_id,
      source: "keepa",
      status: "running",
      started_at: new Date(runStartedAtMs).toISOString(),
    })
    .select("id")
    .single();

  const run_id: string = runIns.data?.id ?? "";

  logKeepaProgress({
    brand_id,
    brand_name,
    stage: "run_started",
    elapsed_ms: 0,
    extra: {
      run_id,
      wall_clock_budget_ms: KEEPA_ENRICHMENT_WALL_CLOCK_MS,
      hard_asin_cap: KEEPA_HARD_ASIN_CAP,
    },
  });

  let tokensUsed = 0;
  try {
    // Phase 33 — request up to 500 brand parents. The Phase 11 cap of 40
    // silently dropped the long tail of large catalogs (Terra Pure
    // 663 → 44, Yeti 8,486 → 20, OXO 6,517 → 45). The 500 ceiling is
    // enforced inside `searchProductsByBrand` via KEEPA_MAX_PAGES_PER_BRAND
    // (5 pages × perPage 100), with an in-loop token-budget guard so a
    // single big brand can't drain Keepa's ~3,900-token bucket.
    // Variation expansion below still bounds children at 200 combined.
    const search = await searchProductsByBrand(brand_name, 500);
    tokensUsed += search.tokens_used;
    logKeepaProgress({
      brand_id,
      brand_name,
      stage: "brand_search_complete",
      accumulated: search.asins.length,
      elapsed_ms: Date.now() - runStartedAtMs,
      extra: { tokens_used: tokensUsed, tokens_left: search.tokens_left },
    });
    await heartbeat();
    if (shouldAbortForWallClock(runStartedAtMs)) {
      throw new Error(
        `[phase66] wall-clock budget (${KEEPA_ENRICHMENT_WALL_CLOCK_MS}ms) exceeded after brand_search; aborting before product fetch`,
      );
    }
    // Phase 66 — hard ASIN cap. Even though searchProductsByBrand
    // already caps at 500 parents and expandVariationAsins caps at 200
    // children, this is an outer belt-and-suspenders for any future
    // call site that passes a larger maxResults. If we ever exceed
    // KEEPA_HARD_ASIN_CAP we truncate and log instead of fanning out
    // into a multi-thousand-ASIN /product fetch that can't complete in
    // the function budget.
    if (search.asins.length > KEEPA_HARD_ASIN_CAP) {
      console.warn(
        `[phase66] brand_search returned ${search.asins.length} ASINs for "${brand_name}"; truncating to KEEPA_HARD_ASIN_CAP=${KEEPA_HARD_ASIN_CAP}`,
      );
      search.asins = search.asins.slice(0, KEEPA_HARD_ASIN_CAP);
    }
    // Keepa's brand search returns parents only. Expand child variations
    // so Beauty/Health/Grocery brands (where 1 parent listing maps to
    // 5–20 child SKUs each with its own BSR + price) get fully measured.
    // Phase 82 review fix #5 — raise the variation-expansion cap from
    // 200 to PHASE82_ASIN_CAP (500) so the downstream Phase 82 cap is
    // meaningful. Seeds come from `searchProductsByBrand` already sorted
    // by current_SALES asc (best-rank-first), and we prepend seeds
    // before children, so a 500-cap truncation drops the long tail
    // contributing essentially zero revenue.
    let asins = search.asins;
    let expansion: { children: string[]; hit_cap: boolean } = { children: [], hit_cap: false };
    if (asins.length) {
      try {
        const exp = await expandVariationAsins(asins, 500);
        asins = exp.combined;
        expansion = { children: exp.children, hit_cap: exp.hit_cap };
        if (exp.hit_cap) {
          console.warn(
            `[keepa-brand] variation cap hit for "${brand_name}" — capped at 500 ASINs`,
          );
        }
        console.log(
          `[keepa-brand] "${brand_name}" expanded: parents=${search.asins.length} children=${exp.children.length} total=${asins.length}`,
        );
      } catch (e) {
        console.warn(`[keepa-brand] variation expansion failed for "${brand_name}":`, e);
      }
    }

    if (!asins.length) {
      const summary: EnrichmentSummary = {
        run_id,
        brand_id,
        asin_count: 0,
        unique_seller_count: 0,
        brand_controlled_pct: null,
        top_seller: null,
        top_seller_share_pct: null,
        top_seller_offer_share_pct: null,
        avg_offers: null,
        validation_score: null,
        tokens_used: tokensUsed,
        amazon_1p_share: 0,
        amazon_1p_disqualified: false,
        enrichment_error: "No ASINs found",
        keepa_product_retry_count: consumeKeepaProductRetryCount(),
        partial_save: false,
        partial_reason: null,
      };

      await supabase
        .from("brands")
        .update({
          keepa_last_enriched_at: new Date().toISOString(),
          keepa_asin_count: 0,
          keepa_unique_seller_count: 0,
          keepa_brand_controlled_pct: null,
          keepa_top_seller: null,
          keepa_top_seller_share_pct: null,
          keepa_avg_offers: null,
          validation_score: null,
          enrichment_error: "No ASINs found",
          updated_at: new Date().toISOString(),
        })
        .eq("id", brand_id)
        .eq("user_id", user_id);

      if (run_id) {
        await supabase
          .from("enrichment_runs")
          .update({
            status: "completed",
            tokens_used: tokensUsed,
            asins_found: 0,
            completed_at: new Date().toISOString(),
            error_message: "No ASINs found",
          })
          .eq("id", run_id);
      }
      return summary;
    }

    if (shouldAbortForWallClock(runStartedAtMs)) {
      // Phase 66 follow-up — graceful degrade. If variation_expansion alone
      // blew the wall-clock budget, drop the expanded children and continue
      // with the parent seeds we already have. The user gets enriched data
      // (perhaps fewer variants) instead of a hard failure.
      if (expansion.children.length && search.asins.length) {
        console.warn(
          `[phase66] wall-clock budget (${KEEPA_ENRICHMENT_WALL_CLOCK_MS}ms) exceeded after variation_expansion for "${brand_name}"; dropping ${expansion.children.length} expanded children and proceeding with ${search.asins.length} seed parents`,
        );
        asins = search.asins;
        expansion = { children: [], hit_cap: false };
      } else {
        throw new Error(
          `[phase66] wall-clock budget (${KEEPA_ENRICHMENT_WALL_CLOCK_MS}ms) exceeded after variation_expansion; aborting before product fetch`,
        );
      }
    }

    // Phase 82 — Hard cap at the top 500 ASINs by sales signal.
    //
    // Sort order strategy (review fix #6): the only sales-rank signal
    // we have BEFORE the /product fetch is the brand-search ordering.
    // `searchProductsByBrand` requests `sort: current_SALES asc`, so the
    // seed parents arrive best-rank-first. `expandVariationAsins`
    // preserves that order by prepending all seeds before child
    // variations. We do NOT re-sort here because (a) we have no
    // per-ASIN BSR yet (that's what /product is for), and (b) issuing
    // a light pre-call would burn the same token budget we're trying
    // to bound. The "seeds first, by current_SALES asc; then variation
    // children" order is the cheapest stable proxy and keeps the long
    // tail at the end of the list — exactly what we want to truncate.
    //
    // Even when a brand has thousands of listings, the long tail
    // contributes essentially zero TTM revenue but burns Keepa tokens
    // and wall clock (Phase 79 saw 6 brands die in keepa_enriching
    // between 3.5–5 min on sequential 7s calls). Truncating here keeps
    // bulk runs predictable.
    const PHASE82_ASIN_CAP = 500;
    const preCapCount = asins.length;
    if (asins.length > PHASE82_ASIN_CAP) {
      console.warn(
        `[phase82] "${brand_name}" exceeded ${PHASE82_ASIN_CAP}-ASIN cap (had ${asins.length}); truncating long tail before product fetch`,
      );
      asins = asins.slice(0, PHASE82_ASIN_CAP);
      // Persist truncation marker so downstream consumers can see the
      // brand's coverage is partial. Best-effort — a write failure
      // never blocks enrichment.
      //
      // Phase 82 review fix #7: merge into `enrichment_metadata`
      // instead of replacing it wholesale. Uses the
      // `jsonb_merge_brand_enrichment_metadata` RPC if available;
      // falls back to read-merge-write on older environments.
      try {
        const mergePatch = {
          enrichment_truncated_at: PHASE82_ASIN_CAP,
          total_asins_seen: preCapCount,
        };
        let merged = false;
        try {
          const { error: rpcErr } = await supabase.rpc(
            "merge_brand_enrichment_metadata",
            { p_brand_id: brand_id, p_patch: mergePatch },
          );
          if (!rpcErr) merged = true;
        } catch {
          // RPC missing — fall back to read-merge-write
        }
        if (!merged) {
          const { data: cur } = await supabase
            .from("brands")
            .select("enrichment_metadata")
            .eq("id", brand_id)
            .eq("user_id", user_id)
            .maybeSingle<{ enrichment_metadata: Record<string, unknown> | null }>();
          const next = { ...(cur?.enrichment_metadata ?? {}), ...mergePatch };
          const { error: metaErr } = await supabase
            .from("brands")
            .update({
              enrichment_metadata: next,
              updated_at: new Date().toISOString(),
            })
            .eq("id", brand_id)
            .eq("user_id", user_id);
          if (metaErr) {
            console.warn(
              `[phase82] enrichment_metadata write failed for ${brand_id}: ${metaErr.message}`,
            );
          }
        }
      } catch (e) {
        console.warn(`[phase82] enrichment_metadata write threw:`, e);
      }
    }

    logKeepaProgress({
      brand_id,
      brand_name,
      stage: "product_fetch_start",
      accumulated: asins.length,
      elapsed_ms: Date.now() - runStartedAtMs,
    });

    // Phase 66 — wrap the long-tail /product fetch in a wall-clock
    // deadline so a stuck batch can't silently consume the entire
    // function budget. The remaining budget after pagination still
    // gives the orchestrator enough headroom to write a terminal state
    // when the deadline trips.
    const remainingBudget = Math.max(
      10_000,
      KEEPA_ENRICHMENT_WALL_CLOCK_MS - (Date.now() - runStartedAtMs) - 20_000,
    );
    // Phase 82 — Switch from 5-ASIN sequential chunks to 100-ASIN
    // batched calls. 500 ASINs → 5 batched calls (≈30s) instead of 100
    // sequential calls (≈11+ min). `getProductDetailsBatch` writes each
    // result into the same 24h PRODUCT_CACHE that `getProductDetails`
    // reads, so cached parents from variation expansion are still
    // skipped via the explicit pre-filter below.
    await heartbeat();
    // Phase 82 R2 review fix N2 — fire a heartbeat after every batched
    // /product call inside `getProductDetails`. For a 500-ASIN brand
    // (5 sequential 100-ASIN batches at ~30s each + Phase 79's retry-on-
    // timeout doubling that ceiling), no intra-loop heartbeat means the
    // brand row can sit untouched for 150s–300s+ — well past the
    // janitor's 240s `keepa_enriching` soft cap. The heartbeat (passed
    // by the bulk worker) refreshes both run-level and brand-row
    // `updated_at` so the janitor sees a healthy in-flight enrich.
    //
    // Phase 66 partial-save — collect each completed batch into
    // `partialProducts` BEFORE awaiting the next one. If `withDeadline`
    // trips or the /product call throws (e.g. Keepa 429 cascade) mid-
    // stream, the chunks that already landed are still usable. Large
    // brands (n=315 Fiebing's) were reliably failing entirely because
    // every chunk's results were discarded when the wrapping promise
    // rejected. Now we mark the brand `enriched` with whatever we got
    // and stamp `enrichment_metadata.partial_save=true`.
    const partialProducts: KeepaProductDetails[] = [];
    let partialSave = false;
    let partialReason: string | null = null;
    let products: KeepaProductDetails[];
    try {
      products = await withDeadline(
        getProductDetails(
          asins,
          KEEPA_PRODUCT_BATCH_MAX,
          async (chunkResults) => {
            // Accumulate chunk-by-chunk so mid-stream failure still
            // leaves us with the completed prefix to persist.
            if (chunkResults?.length) {
              partialProducts.push(...chunkResults);
            }
            await heartbeat();
          },
        ),
        remainingBudget,
        `getProductDetailsBatch(brand="${brand_name}", n=${asins.length})`,
      );
    } catch (productErr: any) {
      const errMsg = String(productErr?.message ?? productErr).slice(0, 500);
      // No data persisted yet → preserve the original behavior: throw
      // so the outer catch routes this to the terminal 'error'/'failed'
      // state. Partial-save only kicks in when we have something worth
      // saving.
      if (partialProducts.length === 0) {
        throw productErr;
      }
      partialSave = true;
      partialReason = errMsg;
      // Snapshot — `withDeadline` only stops *waiting* on the inner
      // promise; the stranded getProductDetails loop may keep appending
      // to `partialProducts` after we enter this catch. Freeze a copy
      // so downstream aggregation operates on a stable list and the
      // late-arriving pushes become harmless log lines.
      products = [...partialProducts];
      console.warn(
        `[phase66] partial-save: "${brand_name}" /product fetch failed mid-stream ` +
          `(${errMsg}); proceeding with ${products.length}/${asins.length} ASINs.`,
      );
      logKeepaProgress({
        brand_id,
        brand_name,
        stage: "product_fetch_partial",
        accumulated: products.length,
        elapsed_ms: Date.now() - runStartedAtMs,
        extra: {
          attempted: asins.length,
          partial_reason: errMsg,
        },
      });
    }
    tokensUsed += products.length * 5; // rough estimate (cache hits don't count perfectly)
    logKeepaProgress({
      brand_id,
      brand_name,
      stage: "product_fetch_complete",
      accumulated: products.length,
      elapsed_ms: Date.now() - runStartedAtMs,
      extra: { tokens_used: tokensUsed },
    });
    await heartbeat();

    // Phase 84 — Aggregate brand_sellers across ALL live offers, not just
    // the buy-box winner per ASIN. Bug #5: pre-Phase-84 we only counted
    // `p.buy_box_seller_id` once per ASIN, so a brand whose 30 listings
    // each had 30 active offers came back with `keepa_unique_seller_count=3`
    // and a 33%/33%/33% modal — completely masking the recoverable-revenue
    // opportunity. Now we walk `p.offers[]` (already filtered to live by
    // `liveOffersOrder` in extractOffers) and tally each seller's offer
    // appearances across the catalog. We still keep `asins_won` as the
    // buy-box-winner count (preserves the existing top-seller / share_pct
    // semantics and Phase 46 brand-controlled classification), but the
    // SELLER UNIVERSE we surface to the report now includes every active
    // 3P competitor on every listing.
    const sellerMap = new Map<string, {
      seller_name: string;
      seller_id?: string;
      seller_country?: string;
      is_fba?: boolean;
      asins_won: number;        // buy-box wins (preserved)
      offer_count: number;      // Phase 84: appearances across all live offers
      asin_count: number;       // Phase 84: distinct ASINs where seller has a live offer
    }>();

    let amazonOnesP = 0;
    let totalLiveOffers = 0;
    for (const p of products) {
      const winnerId = p.buy_box_seller_id ?? null;
      const winnerName = p.buy_box_seller ?? null;
      // Walk every live offer on the ASIN. Each offer contributes one
      // `offer_count`; each distinct (seller, asin) pair contributes one
      // `asin_count`. The buy-box winner gets +1 `asins_won` too.
      const seenOnThisAsin = new Set<string>();
      for (const o of p.offers ?? []) {
        const sid = o.seller_id ?? null;
        // Skip offers with no identifiable seller (rare — usually means a
        // historical row Keepa didn't fully resolve). Without a key we
        // can't aggregate.
        if (!sid) continue;
        const key = sid.toLowerCase();
        totalLiveOffers += 1;
        let existing = sellerMap.get(key);
        if (!existing) {
          existing = {
            seller_name: o.seller_name ?? sid,
            seller_id: sid,
            seller_country: o.is_amazon ? "US" : undefined,
            is_fba: !!o.is_fba,
            asins_won: 0,
            offer_count: 0,
            asin_count: 0,
          };
          sellerMap.set(key, existing);
        }
        existing.offer_count += 1;
        if (!seenOnThisAsin.has(key)) {
          existing.asin_count += 1;
          seenOnThisAsin.add(key);
        }
        // Promote a better name if we now have one.
        if ((!existing.seller_name || existing.seller_name === existing.seller_id) && o.seller_name) {
          existing.seller_name = o.seller_name;
        }
      }
      // Buy-box winner gets credit for `asins_won`. If the winner isn't
      // already in the map (e.g. liveOffersOrder didn't surface them, or
      // they appear only via buyBoxSellerIdHistory), seed an entry so we
      // don't lose the historical signal that drives top-seller and
      // brand-controlled classification.
      if (winnerId) {
        const key = winnerId.toLowerCase();
        let existing = sellerMap.get(key);
        if (!existing) {
          existing = {
            seller_name: winnerName ?? winnerId,
            seller_id: winnerId,
            seller_country: p.buy_box_is_amazon ? "US" : undefined,
            is_fba: !!p.buy_box_is_fba,
            asins_won: 0,
            offer_count: 0,
            asin_count: 0,
          };
          sellerMap.set(key, existing);
        }
        existing.asins_won += 1;
        if ((!existing.seller_name || existing.seller_name === existing.seller_id) && winnerName) {
          existing.seller_name = winnerName;
        }
      } else if (winnerName) {
        // Edge case: buy-box winner has no seller_id (very rare). Key by
        // name so the row still lands; classification will treat it as
        // a name-only seller.
        const key = winnerName.toLowerCase();
        const existing = sellerMap.get(key);
        if (existing) existing.asins_won += 1;
        else sellerMap.set(key, {
          seller_name: winnerName,
          seller_id: undefined,
          seller_country: p.buy_box_is_amazon ? "US" : undefined,
          is_fba: !!p.buy_box_is_fba,
          asins_won: 1,
          offer_count: 0,
          asin_count: 0,
        });
      }
      if (p.buy_box_is_amazon) amazonOnesP += 1;
    }

    // Replace existing brand_sellers rows for this brand to keep aggregates fresh
    const { error: delErr } = await supabase
      .from("brand_sellers")
      .delete()
      .eq("brand_id", brand_id);
    if (delErr) throw new Error(`brand_sellers delete: ${delErr.message}`);

    // Resolve real seller names for any IDs that came back as bare
    // sellerIds (e.g. "AP3VA1GJZM3EQ"). Keepa's /seller endpoint costs
    // 1 token per ID and accepts up to 100 per call. Cached 30 days.
    const idsToResolve = new Set<string>();
    for (const s of Array.from(sellerMap.values())) {
      if (s.seller_id && isAmazonSellerId(s.seller_id) && (
        !s.seller_name ||
        s.seller_name === s.seller_id ||
        isAmazonSellerId(s.seller_name)
      )) {
        idsToResolve.add(s.seller_id);
      }
    }
    // Resolve every seller (not just unresolved-name IDs) so we pick up
    // a country for sellers whose names already came back from /product.
    const allSellerIds = new Set<string>();
    for (const s of Array.from(sellerMap.values())) {
      if (s.seller_id && isAmazonSellerId(s.seller_id)) {
        allSellerIds.add(s.seller_id);
      }
    }
    let resolvedInfo: Record<string, { name: string | null; country: string | null }> = {};
    try {
      resolvedInfo = await resolveSellerInfo(allSellerIds, makeSellerCache(supabase));
    } catch {
      // soft fail — fall back to IDs
    }

    const totalWon = Array.from(sellerMap.values()).reduce((a, s) => a + s.asins_won, 0);
    // Phase 84 — `share_pct` now reflects each seller's slice of the
    // brand's full live-offer universe (offer_count / totalLiveOffers),
    // not just their buy-box wins. This is the metric that makes the
    // modal's bar chart meaningful for the reseller-removal pitch — a
    // brand with 30 active sellers should show a long-tail distribution,
    // not three 33% slices. Falls back to the legacy asins_won-based
    // share when totalLiveOffers is 0 (older callers / brands with no
    // offers data at all).
    const preResolved = Array.from(sellerMap.values()).map((s) => {
      const resolved = s.seller_id ? resolvedInfo[s.seller_id] : null;
      const resolvedName = resolved?.name?.trim() || null;
      // Hotfix — May 2026: when Keepa's /seller endpoint can't resolve a
      // storefront name, persist NULL instead of falling back to the raw
      // seller_id. The renderer (`friendlySellerName`) already shows
      // "Unknown 3P seller (ID: …)" for IDs masquerading as names — but
      // by storing NULL we let the classifier skip these rows cleanly
      // and the renderer fall through to its NULL branch.
      const finalName: string | null =
        resolvedName
          ? resolvedName
          : s.seller_name && !isAmazonSellerId(s.seller_name)
          ? s.seller_name
          : null;
      const country = resolved?.country ?? s.seller_country ?? null;
      const sharePct =
        totalLiveOffers > 0
          ? s.offer_count / totalLiveOffers
          : totalWon > 0
          ? s.asins_won / totalWon
          : null;
      return {
        seller_name: finalName,
        seller_id: s.seller_id ?? null,
        seller_country: country,
        share_pct: sharePct,
        asins_won: s.asins_won,
        is_fba: s.is_fba ?? null,
      };
    });

    // Phase 23 — classify each seller against the brand AFTER name
    // resolution (the Phase 4 path classified pre-resolution against
    // raw seller-ids, which is why "Fantaswick LLC" was tagged a
    // reseller). Cap the LLM tiebreaker at 5 calls per scan so the
    // ambiguous-band fallback can never blow our budget.
    const classified = await classifySellers(brand_name, preResolved, {
      llm_budget: 5,
    });

    const sellerRows = classified.map((s) => {
      // Phase 56 — auto-classify Amazon retail (ATVPDKIKX0DER) as
      // 'amazon' on import. User can override via the modal. This
      // complements the DB-level trigger added in migration 0045.
      const isAmazon = s.seller_id === "ATVPDKIKX0DER";
      return {
        brand_id,
        seller_name: s.seller_name,
        seller_id: s.seller_id ?? null,
        seller_country: s.seller_country,
        share_pct: s.share_pct,
        asins_won: s.asins_won,
        is_fba: s.is_fba,
        is_brand_controlled: s.classification.is_brand_controlled,
        classification_reason: s.classification.reason.slice(0, 500),
        classification: isAmazon ? "amazon" : "reseller",
        last_seen_at: new Date().toISOString(),
      };
    });

    if (sellerRows.length) {
      const { error: insErr } = await supabase
        .from("brand_sellers")
        .insert(sellerRows);
      if (insErr) {
        // Phase 23 — retry without the new classification columns when
        // the migration hasn't landed yet. The classifier still drives
        // brand_controlled_pct + top_seller below; persistence of the
        // reason on brand_sellers is best-effort transparency.
        const msg = insErr.message ?? "";
        const looksLikeMissingColumn = /column .* does not exist|is_brand_controlled|classification_reason|classification/i.test(msg);
        if (looksLikeMissingColumn) {
          console.warn(
            `[keepa-brand] brand_sellers insert with classification columns failed (${msg}); retrying without them.`,
          );
          const legacyRows = sellerRows.map(({ is_brand_controlled, classification_reason, classification, ...rest }) => rest);
          const { error: retryErr } = await supabase
            .from("brand_sellers")
            .insert(legacyRows);
          if (retryErr) throw new Error(`brand_sellers insert: ${retryErr.message}`);
        } else {
          throw new Error(`brand_sellers insert: ${msg}`);
        }
      }
    }

    // Build a seller-key → classification map so per-ASIN
    // is_brand_controlled lines up with the seller-level verdict.
    const classificationByKey = new Map<string, SellerClassification>();
    for (const c of classified) {
      const idKey = c.seller_id ? c.seller_id.toLowerCase() : null;
      const nameKey = c.seller_name?.toLowerCase() ?? null;
      if (idKey) classificationByKey.set(idKey, c.classification);
      if (nameKey) classificationByKey.set(nameKey, c.classification);
    }

    // Phase 31 — compute pre-attribution monthly-units for each ASIN
    // (rank → units lookup, same curves the brand-level estimator uses)
    // and then run variation-aware attribution so per-ASIN persistence
    // already carries the post-attribution numbers. Sibling pallet ASINs
    // sharing a parent listing with active 4-pack/12-pack siblings
    // collapse to ~0 attributed units, and the brand's TTM sum stops
    // double-counting.
    // Phase 34 — Amazon's published "X+ bought in past month" badge
    // (Keepa `monthlySold`) takes precedence over the BSR-curve estimate
    // when present. The curve still acts as a defensive floor via
    // `Math.max` in case Amazon temporarily strips the badge from a
    // high-velocity ASIN. Per-row `units_source` is captured for
    // diagnostics / log-line summaries.
    type UnitsSource =
      | "keepa_monthly_sold"
      | "bsr_curve"
      | "keepa_monthly_sold_floored"
      | "none";
    const unitsSourceByAsin = new Map<string, UnitsSource>();
    let withMonthlySoldCount = 0;
    let monthlySoldTotal = 0;
    let curveTotal = 0;
    const attributionInputs = products.map((p) => {
      const rank = p.sales_rank_avg365 ?? p.sales_rank_current ?? null;
      const categoryPath = p.category_tree?.map((c) => c.name).join(" > ") ?? null;
      const fromKeepa = p.monthly_sold ?? null;
      const fromCurve = rankToMonthlyUnits(rank, p.product_group ?? null, categoryPath);
      const raw =
        fromKeepa != null ? Math.max(fromKeepa, fromCurve ?? 0) : fromCurve;
      let source: UnitsSource;
      if (fromKeepa != null) {
        withMonthlySoldCount += 1;
        monthlySoldTotal += fromKeepa;
        source =
          fromCurve != null && fromCurve > fromKeepa
            ? "keepa_monthly_sold_floored"
            : "keepa_monthly_sold";
      } else if (fromCurve != null) {
        source = "bsr_curve";
      } else {
        source = "none";
      }
      if (fromCurve != null) curveTotal += fromCurve;
      unitsSourceByAsin.set(p.asin, source);
      return {
        asin: p.asin,
        parent_asin: p.parent_asin ?? null,
        raw_monthly_units: raw,
        // Without paying for full review history, total review_count is
        // the best free proxy for "is this variation actually selling".
        // Pallet/dead variations carry near-zero reviews; active 4-pack
        // / 12-pack siblings carry hundreds. The brief allows this
        // fallback explicitly.
        recent_review_count: p.review_count ?? null,
        // Phase 32 — sharper attribution signal: Buy Box winner churn
        // in the last 90 days. Combined with reviews via blend weights.
        buy_box_change_count_90d: p.buy_box_change_count_90d ?? null,
        // Phase 36 — Amazon's per-ASIN published monthlySold badge.
        // When non-null, attributeVariationSales bypasses the
        // re-attribution split for this sibling (Phase 32.1 zero-signal
        // still wins for parent shells / dormant pallets).
        keepa_monthly_sold: p.monthly_sold ?? null,
      };
    });
    const attribution = indexAttributionByAsin(
      attributeVariationSales(attributionInputs),
    );

    // Phase 34 — diagnostic summary: how many ASINs received a Keepa
    // `monthlySold` value, and how the totals stack up vs the curve-only
    // estimate. Intentionally pre-attribution so it reflects the raw
    // signal Keepa published (not the post-variation-weighting result).
    const blendedTotal = attributionInputs.reduce(
      (a, r) => a + (r.raw_monthly_units ?? 0),
      0,
    );
    console.log(
      `[phase34] units derivation — brand="${brand_name}", ` +
        `asins_total=${products.length}, ` +
        `with_monthly_sold=${withMonthlySoldCount}, ` +
        `monthly_sold_total_units=${monthlySoldTotal}, ` +
        `curve_total_units=${curveTotal}, ` +
        `blended_total_units=${blendedTotal}`,
    );

    // Upsert brand_asins. is_brand_controlled is derived from the
    // already-classified seller list (resolved name + Jaccard / LLM
    // signals) rather than a raw substring match against
    // p.buy_box_seller, which can be a Keepa seller-id pre-resolution.
    const asinRows = products.map((p) => {
      const idKey = p.buy_box_seller_id?.toLowerCase() ?? null;
      const nameKey = p.buy_box_seller?.toLowerCase() ?? null;
      const cls =
        (idKey ? classificationByKey.get(idKey) : undefined) ??
        (nameKey ? classificationByKey.get(nameKey) : undefined);
      const isBrand = cls
        ? cls.is_brand_controlled
        : isBrandControlled(p.buy_box_seller, brand_name);
      const att = attribution.get(p.asin) ?? null;
      return {
        brand_id,
        asin: p.asin,
        title: p.title ?? null,
        buy_box_seller: p.buy_box_seller ?? null,
        buy_box_price: p.buy_box_price ?? null,
        offers_count: p.total_offers_count ?? 0,
        fba_offers_count: p.fba_offers_count ?? 0,
        is_brand_controlled: isBrand,
        last_checked_at: new Date().toISOString(),
        // Phase 31/32 — variation attribution.
        parent_asin: att?.parent_asin ?? p.parent_asin ?? null,
        variation_group_size: att?.variation_group_size ?? 1,
        variation_weight: att?.variation_weight ?? 1,
        recent_review_count: p.review_count ?? null,
        buy_box_change_count_90d: p.buy_box_change_count_90d ?? null,
        raw_monthly_units: att?.raw_monthly_units ?? null,
        attributed_monthly_units: att?.attributed_monthly_units ?? null,
        // Phase 34 — Amazon-published monthly_sold badge (or null).
        keepa_monthly_sold: p.monthly_sold ?? null,
      };
    });

    if (asinRows.length) {
      const { error: upErr } = await supabase
        .from("brand_asins")
        .upsert(asinRows, { onConflict: "brand_id,asin" });
      if (upErr) {
        // Pre-migration soft fall back: retry without the new
        // variation-attribution columns so older environments don't
        // block the whole enrichment run on a missing column.
        const msg = upErr.message ?? "";
        const looksLikeMissingColumn = /column .* does not exist|parent_asin|variation_group_size|variation_weight|recent_review_count|buy_box_change_count_90d|raw_monthly_units|attributed_monthly_units|keepa_monthly_sold/i.test(msg);
        if (looksLikeMissingColumn) {
          console.warn(
            `[keepa-brand] brand_asins upsert with variation columns failed (${msg}); retrying without them.`,
          );
          const legacyRows = asinRows.map(({
            parent_asin: _p,
            variation_group_size: _gs,
            variation_weight: _w,
            recent_review_count: _rr,
            buy_box_change_count_90d: _bb,
            raw_monthly_units: _rm,
            attributed_monthly_units: _am,
            keepa_monthly_sold: _km,
            ...rest
          }) => rest);
          const { error: retryErr } = await supabase
            .from("brand_asins")
            .upsert(legacyRows, { onConflict: "brand_id,asin" });
          if (retryErr) throw new Error(`brand_asins upsert: ${retryErr.message}`);
        } else {
          throw new Error(`brand_asins upsert: ${msg}`);
        }
      }
    }

    // Brand-level summary
    const asin_count = products.length;
    const unique_seller_count = sellerMap.size;
    const totalOffers = products.reduce((a, p) => a + (p.total_offers_count ?? 0), 0);
    const avg_offers = asin_count ? totalOffers / asin_count : null;

    // Brand-controlled share is now derived from the classified seller
    // list (weighted by share_pct, falling back to asins_won) instead
    // of a per-ASIN exact-string match against the buy-box winner.
    const brand_controlled_pct = aggregateBrandControlledShare(classified);

    // Top reseller = the classified-as-reseller seller with the largest
    // share. The dossier and cover hero want the actionable outsider,
    // not the brand's own LLC (Fantaswick LLC) sitting at the top.
    //
    // Phase 84 follow-up #2 — sort by `share_pct` DESC (offer-share, the
    // metric users see in the modal) with `asins_won` DESC as a tiebreak.
    // Pre-fix the sort keyed only on `asins_won`, which became misleading
    // once `share_pct` shifted to offer-share — two resellers tied on
    // asins_won could appear in any order regardless of how much of the
    // live-offer pie they actually held.
    const resellersSorted = classified
      .filter((s) => !s.classification.is_brand_controlled)
      .sort((a, b) => {
        const bs = b.share_pct ?? 0;
        const as = a.share_pct ?? 0;
        if (bs !== as) return bs - as;
        return (b.asins_won ?? 0) - (a.asins_won ?? 0);
      });
    const topReseller = resellersSorted[0] ?? null;
    const top_seller = topReseller?.seller_name ?? null;
    // Phase 84 follow-up #1 — keep `top_seller_share_pct` semantically
    // equal to its pre-Phase-84 value (buy-box-share: max reseller
    // asins_won / total brand asins_won) so `computeValidationScore` /
    // `computeCombinedValidationScore` keep producing the same magnitude
    // they were tuned on. Offer-share (the new metric for the modal /
    // UI bar chart) is exposed separately as `top_seller_offer_share_pct`.
    //
    // Decoupled from `topReseller` identity: FU2 changed `topReseller`
    // selection to sort by `share_pct` DESC (offer-share leader), which
    // may not be the buy-box leader. Using `topReseller.asins_won` here
    // would silently lower the scoring magnitude whenever the offer-share
    // leader ≠ buy-box leader. Compute the max independently over the
    // (already brand-controlled-filtered, per Phase 46) resellers list.
    const top_seller_share_pct =
      totalWon > 0 && resellersSorted.length > 0
        ? Math.max(...resellersSorted.map((r) => (r.asins_won ?? 0) / totalWon))
        : null;
    const top_seller_offer_share_pct = topReseller?.share_pct ?? null;
    const top_seller_country = topReseller?.seller_country ?? null;

    // Combine Keepa channel signals with the latest DataForSEO snapshot
    // (if any) so validation_score reflects both pillars. Falls back to
    // the legacy Keepa-only score when no DFS data exists yet.
    const dfsSignals = await loadLatestDfsSignals(supabase, brand_id);
    const validation_score = dfsSignals
      ? computeCombinedValidationScore(
          {
            top_seller_share_pct,
            brand_controlled_pct,
            unique_seller_count,
            asin_count,
            top_seller_country,
          },
          dfsSignals,
        )
      : computeValidationScore({
          top_seller_share_pct,
          brand_controlled_pct,
          unique_seller_count,
          asin_count,
          top_seller_country,
        });

    // Amazon-1P share — what fraction of buy boxes is Amazon retail
    // (ATVPDKIKX0DER) winning? Computed from products (winner buyer)
    // for stability against the seller-aggregation step.
    const amazon1pShare = asin_count ? amazonOnesP / asin_count : 0;

    const nextTags = new Set(existingTags);
    // Phase 23 — if Amazon retail holds >= AMAZON_1P_THRESHOLD_PCT of
    // buy boxes, the brand has a wholesale (1P) relationship with
    // Amazon. RCG's reseller-removal play doesn't apply, so the report
    // should short-circuit to a "not a fit" page. Threshold is
    // configurable via AMAZON_1P_THRESHOLD_PCT (default 0.10).
    const amazon1pDisqualified = isAmazon1pBrand(amazon1pShare);
    if (amazon1pDisqualified) {
      nextTags.add("amazon_1p");
      // Keep the legacy ≥50% tag for downstream review consumers.
      if (amazon1pShare > 0.5) nextTags.add("amazon_1p_vendor");
    } else if (amazon1pShare > 0.5) {
      nextTags.add("amazon_1p_vendor");
    }
    console.log(
      `[keepa-brand] "${brand_name}" classification: brand_controlled_pct=${brand_controlled_pct?.toFixed(3) ?? "null"} ` +
      `amazon_1p_share=${amazon1pShare.toFixed(3)} (threshold=${amazon1pThreshold().toFixed(2)}, disqualified=${amazon1pDisqualified}) ` +
      `top_reseller="${top_seller ?? "—"}" (${top_seller_share_pct?.toFixed(3) ?? "null"})`,
    );

    await supabase
      .from("brands")
      .update({
        keepa_last_enriched_at: new Date().toISOString(),
        keepa_asin_count: asin_count,
        keepa_unique_seller_count: unique_seller_count,
        keepa_brand_controlled_pct: brand_controlled_pct,
        keepa_top_seller: top_seller,
        keepa_top_seller_share_pct: top_seller_share_pct,
        keepa_avg_offers: avg_offers,
        validation_score,
        enrichment_error: null,
        disqualifier_tags: Array.from(nextTags),
        updated_at: new Date().toISOString(),
      })
      .eq("id", brand_id)
      .eq("user_id", user_id);

    // Phase 66 partial-save — stamp `enrichment_metadata.partial_save`
    // so the UI can render a "partial coverage" badge / tooltip and ops
    // can grep partial runs later. Best-effort, mirrors the merge pattern
    // used by the Phase 82 truncation marker above. When `partialSave`
    // is false (the common path) this block is skipped entirely so a
    // healthy full enrich leaves the metadata blob untouched.
    if (partialSave) {
      try {
        const partialPatch = {
          partial_save: true,
          partial_reason: partialReason ?? "unknown",
          partial_saved_asins: products.length,
          partial_attempted_asins: asins.length,
          partial_saved_at: new Date().toISOString(),
        };
        let merged = false;
        try {
          const { error: rpcErr } = await supabase.rpc(
            "merge_brand_enrichment_metadata",
            { p_brand_id: brand_id, p_patch: partialPatch },
          );
          if (!rpcErr) merged = true;
        } catch {
          // RPC missing — fall back to read-merge-write
        }
        if (!merged) {
          const { data: cur } = await supabase
            .from("brands")
            .select("enrichment_metadata")
            .eq("id", brand_id)
            .eq("user_id", user_id)
            .maybeSingle<{ enrichment_metadata: Record<string, unknown> | null }>();
          const next = { ...(cur?.enrichment_metadata ?? {}), ...partialPatch };
          const { error: metaErr } = await supabase
            .from("brands")
            .update({
              enrichment_metadata: next,
              updated_at: new Date().toISOString(),
            })
            .eq("id", brand_id)
            .eq("user_id", user_id);
          if (metaErr) {
            console.warn(
              `[phase66] partial_save metadata write failed for ${brand_id}: ${metaErr.message}`,
            );
          }
        }
      } catch (e) {
        console.warn(`[phase66] partial_save metadata write threw:`, e);
      }
    }

    // Phase 38 — persist computeLegionEconomics output to the brand row
    // so the brand page (and any other consumer) reads numbers from the
    // database instead of re-deriving them at render time. Best-effort:
    // a write failure does not fail the enrichment summary.
    try {
      const { persistBrandEconomics } = await import(
        "@/lib/brand-detail/persist-economics"
      );
      const persisted = await persistBrandEconomics(supabase, brand_id);
      if (!persisted.ok) {
        console.warn(
          `[keepa-brand] persistBrandEconomics skipped/failed for ${brand_id}: ${persisted.reason ?? "unknown"} ${persisted.error ?? ""}`,
        );
      }
    } catch (e) {
      console.warn(`[keepa-brand] persistBrandEconomics threw for ${brand_id}:`, e);
    }

    if (run_id) {
      await supabase
        .from("enrichment_runs")
        .update({
          status: "completed",
          tokens_used: tokensUsed,
          asins_found: asin_count,
          completed_at: new Date().toISOString(),
          // Phase 66 partial-save — surface the partial reason on the
          // run row so ops can grep `enrichment_runs` for partial
          // completions without joining brands.enrichment_metadata.
          // The brand row itself keeps `enrichment_error=null` (the
          // brand IS enriched, just with reduced coverage).
          ...(partialSave
            ? { error_message: `partial_save: ${partialReason ?? "unknown"}` }
            : {}),
        })
        .eq("id", run_id);
    }

    return {
      run_id,
      brand_id,
      asin_count,
      unique_seller_count,
      brand_controlled_pct,
      top_seller,
      top_seller_share_pct,
      top_seller_offer_share_pct,
      avg_offers,
      validation_score,
      tokens_used: tokensUsed,
      amazon_1p_share: amazon1pShare,
      amazon_1p_disqualified: amazon1pDisqualified,
      enrichment_error: null,
      keepa_product_retry_count: consumeKeepaProductRetryCount(),
      partial_save: partialSave,
      partial_reason: partialReason,
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 500);
    // Phase 66 — Use status='error' for Phase 66 wall-clock / hard-cap /
    // deadline aborts so ops can distinguish "we proactively bailed out
    // before Vercel killed us" from other thrown errors that already
    // surface as 'failed'. Both end states satisfy the same invariant:
    // never leave a row at 'running'.
    const terminalStatus = classifyTerminalStatus(msg);
    logKeepaProgress({
      brand_id,
      brand_name,
      stage: "run_terminal_error",
      elapsed_ms: Date.now() - runStartedAtMs,
      extra: {
        run_id,
        status: terminalStatus,
        tokens_used: tokensUsed,
        error_message: msg,
      },
    });
    if (run_id) {
      await supabase
        .from("enrichment_runs")
        .update({
          status: terminalStatus,
          tokens_used: tokensUsed,
          completed_at: new Date().toISOString(),
          error_message: msg,
        })
        .eq("id", run_id);
    }
    await supabase
      .from("brands")
      .update({
        enrichment_error: msg,
        updated_at: new Date().toISOString(),
      })
      .eq("id", brand_id)
      .eq("user_id", user_id);
    throw err;
  }
}

async function loadLatestDfsSignals(
  supabase: SupabaseClient<any, any, any>,
  brandId: string,
): Promise<DataForSeoSignals | null> {
  try {
    const { data } = await supabase
      .from("brand_search_metrics")
      .select("branded_search_volume, branded_trend_pct, competitor_brands")
      .eq("brand_id", brandId)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    const competitors = Array.isArray(data.competitor_brands) ? data.competitor_brands : [];
    const top = competitors[0];
    return {
      branded_search_volume: data.branded_search_volume ?? null,
      branded_trend_pct: data.branded_trend_pct ?? null,
      competitor_top_share: typeof top?.share_of_serp === "number" ? top.share_of_serp : null,
      competitor_count: competitors.length || null,
    };
  } catch {
    return null;
  }
}

export function isBrandControlled(buyBoxSeller: string | null | undefined, brandName: string): boolean {
  if (!buyBoxSeller) return false;
  const a = buyBoxSeller.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = brandName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!a || !b) return false;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}
