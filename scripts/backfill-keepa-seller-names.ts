/**
 * One-off: backfill real seller names from Keepa /seller for existing
 * brand_sellers rows + reports.reseller_dossier rows that still store
 * bare seller IDs.
 *
 * Run:
 *   KEEPA_API_KEY=... \
 *   NEXT_PUBLIC_SUPABASE_URL=https://qbgchatkwaqpbvxsramw.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   npx tsx scripts/backfill-keepa-seller-names.ts [reportId|brandId|--all]
 */
import { createClient } from "@supabase/supabase-js";
import { resolveSellerNames, isAmazonSellerId } from "../src/lib/keepa";
import { makeSellerCache } from "../src/lib/enrichment/keepa-seller-cache";

async function main() {
  const arg = process.argv[2] ?? "";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const cache = makeSellerCache(supabase);

  // Figure out which brand_ids we need to touch.
  const brandIds = new Set<string>();
  let scopedReportIds: string[] | null = null;

  if (!arg || arg === "--all") {
    const { data } = await supabase
      .from("brand_sellers")
      .select("brand_id")
      .limit(10000);
    for (const r of data ?? []) brandIds.add(r.brand_id as string);
  } else if (/^[0-9a-f-]{36}$/.test(arg)) {
    // Try as report id first.
    const { data: rep } = await supabase
      .from("reports")
      .select("id, brand_id")
      .eq("id", arg)
      .maybeSingle();
    if (rep) {
      brandIds.add(rep.brand_id as string);
      scopedReportIds = [arg];
    } else {
      brandIds.add(arg);
    }
  } else {
    console.error(`unrecognized arg: ${arg}`);
    process.exit(1);
  }

  console.log(`[backfill] brands to process: ${brandIds.size}`);

  // Collect all bare-ID seller_ids that need resolving.
  const allIds = new Set<string>();
  const perBrand = new Map<string, { seller_id: string; current_name: string | null }[]>();
  for (const bid of Array.from(brandIds)) {
    const { data } = await supabase
      .from("brand_sellers")
      .select("seller_id, seller_name")
      .eq("brand_id", bid);
    const rows = (data ?? []) as { seller_id: string | null; seller_name: string | null }[];
    const list: { seller_id: string; current_name: string | null }[] = [];
    for (const r of rows) {
      if (!r.seller_id || !isAmazonSellerId(r.seller_id)) continue;
      if (
        !r.seller_name ||
        r.seller_name === r.seller_id ||
        isAmazonSellerId(r.seller_name)
      ) {
        allIds.add(r.seller_id);
      }
      list.push({ seller_id: r.seller_id, current_name: r.seller_name });
    }
    perBrand.set(bid, list);
  }

  // Also add IDs found in reports.reseller_dossier.seller_id where seller_name is bare ID.
  let reportsQuery = supabase
    .from("reports")
    .select("id, brand_id, reseller_dossier")
    .not("reseller_dossier", "is", null);
  if (scopedReportIds) {
    reportsQuery = reportsQuery.in("id", scopedReportIds);
  } else {
    reportsQuery = reportsQuery.in("brand_id", Array.from(brandIds));
  }
  const { data: reports } = await reportsQuery;
  const reportRows: { id: string; brand_id: string; dossier: any }[] = (reports ?? []).map((r: any) => ({
    id: r.id, brand_id: r.brand_id, dossier: r.reseller_dossier,
  }));
  for (const r of reportRows) {
    const d = r.dossier ?? {};
    if (d?.seller_id && isAmazonSellerId(d.seller_id) && (
      !d.seller_name || d.seller_name === d.seller_id || isAmazonSellerId(d.seller_name)
    )) {
      allIds.add(d.seller_id);
    }
    // Also handle the cross-wired case where seller_name is itself an ID.
    if (d?.seller_name && isAmazonSellerId(d.seller_name)) {
      allIds.add(d.seller_name);
    }
  }

  console.log(`[backfill] unique IDs to resolve: ${allIds.size}`);
  if (!allIds.size) {
    console.log("[backfill] nothing to do");
    return;
  }

  const resolved = await resolveSellerNames(allIds, cache);
  console.log("[backfill] resolved:", JSON.stringify(resolved, null, 2));

  // Update brand_sellers per-brand.
  for (const [bid, list] of Array.from(perBrand.entries())) {
    for (const item of list) {
      const name = resolved[item.seller_id];
      if (!name) continue;
      // Only overwrite when current name is missing / equals ID / itself a bare ID.
      const current = item.current_name ?? "";
      if (
        !current ||
        current === item.seller_id ||
        isAmazonSellerId(current)
      ) {
        const { error } = await supabase
          .from("brand_sellers")
          .update({ seller_name: name })
          .eq("brand_id", bid)
          .eq("seller_id", item.seller_id);
        if (error) console.warn("[backfill] brand_sellers update failed", bid, item.seller_id, error.message);
      }
    }
    // Recompute top seller for the brand from updated rows.
    const { data: refreshed } = await supabase
      .from("brand_sellers")
      .select("seller_name, asins_won, share_pct")
      .eq("brand_id", bid)
      .order("asins_won", { ascending: false })
      .limit(1);
    const top = (refreshed ?? [])[0];
    if (top?.seller_name) {
      await supabase
        .from("brands")
        .update({ keepa_top_seller: top.seller_name })
        .eq("id", bid);
    }
  }

  // Update reports.reseller_dossier per-report.
  for (const r of reportRows) {
    const d = r.dossier ? { ...r.dossier } : null;
    if (!d) continue;
    let mutated = false;

    // Case A: seller_name is itself a bare ID. Use that ID to look up.
    if (d.seller_name && isAmazonSellerId(d.seller_name)) {
      const name = resolved[d.seller_name];
      if (name) {
        // The seller_id field may be cross-wired (e.g. set to ATVPDKIKX0DER
        // even though the actual seller is AP3VA1GJZM3EQ). Heal it.
        if (d.seller_id && d.seller_id !== d.seller_name) {
          d.seller_id = d.seller_name;
        }
        d.seller_name = name;
        mutated = true;
      }
    }
    // Case B: seller_id present, seller_name missing or matches ID.
    else if (d.seller_id && isAmazonSellerId(d.seller_id)) {
      const name = resolved[d.seller_id];
      if (name && (!d.seller_name || d.seller_name === d.seller_id)) {
        d.seller_name = name;
        mutated = true;
      }
    }

    if (mutated) {
      const { error } = await supabase
        .from("reports")
        .update({ reseller_dossier: d })
        .eq("id", r.id);
      if (error) console.warn("[backfill] reports update failed", r.id, error.message);
      else console.log("[backfill] updated report dossier", r.id, "→", d.seller_name);
    }
  }

  // Also patch narrative_json.reseller_dossier inside the reports row
  // (the public renderer reads narrative_json, not reseller_dossier
  // directly, when version === 2).
  for (const r of reportRows) {
    const { data } = await supabase
      .from("reports")
      .select("id, narrative_json")
      .eq("id", r.id)
      .maybeSingle();
    const narrative = (data?.narrative_json ?? null) as any;
    if (!narrative || narrative.version !== 2) continue;
    let mutated = false;

    // Patch reseller_dossier inside narrative.
    const nd = narrative.reseller_dossier;
    if (nd && nd.seller_name && isAmazonSellerId(nd.seller_name)) {
      const name = resolved[nd.seller_name];
      if (name) {
        if (nd.seller_id && nd.seller_id !== nd.seller_name) {
          nd.seller_id = nd.seller_name;
        }
        nd.seller_name = name;
        mutated = true;
      }
    } else if (nd && nd.seller_id && isAmazonSellerId(nd.seller_id)) {
      const name = resolved[nd.seller_id];
      if (name && (!nd.seller_name || nd.seller_name === nd.seller_id)) {
        nd.seller_name = name;
        mutated = true;
      }
    }

    // Patch reseller_reality.top_sellers[].seller_name and KPI sub.
    const sellers = narrative?.reseller_reality?.top_sellers as any[] | undefined;
    if (Array.isArray(sellers)) {
      for (const s of sellers) {
        if (s.seller_name && isAmazonSellerId(s.seller_name)) {
          const name = resolved[s.seller_name];
          if (name) {
            s.seller_name = name;
            mutated = true;
          }
        }
      }
    }

    // Patch cover.kpis "Top reseller share" sub: "<id> (Keepa)" → "<name> (Keepa)".
    const kpis = narrative?.cover?.kpis as any[] | undefined;
    if (Array.isArray(kpis)) {
      for (const k of kpis) {
        if (typeof k.sub === "string") {
          const m = k.sub.match(/^(A[A-Z0-9]{12,13})(\s*\(.*\))?$/);
          if (m) {
            const name = resolved[m[1]];
            if (name) {
              k.sub = `${name}${m[2] ?? ""}`;
              mutated = true;
            }
          }
        }
      }
    }

    // Patch headline if it embeds a bare seller ID.
    if (typeof narrative?.cover?.headline === "string") {
      const newHeadline = narrative.cover.headline.replace(/A[A-Z0-9]{12,13}/g, (id: string) => resolved[id] ?? id);
      if (newHeadline !== narrative.cover.headline) {
        narrative.cover.headline = newHeadline;
        mutated = true;
      }
    }

    if (mutated) {
      await supabase.from("reports").update({ narrative_json: narrative }).eq("id", r.id);
      console.log("[backfill] patched narrative_json for report", r.id);
    }
  }

  console.log("[backfill] done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
