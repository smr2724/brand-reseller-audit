/**
 * Supabase-backed cache for Keepa /seller responses.
 *
 * Wraps the optional `keepa_seller_cache` table. The table may not exist
 * yet (migration 0021); read/write quietly no-op in that case so the
 * resolver still works (with in-memory caching only).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

interface CachedRow {
  seller_id: string;
  seller_name: string | null;
  fetched_at: string;
  payload?: any;
}

export function makeSellerCache(supabase: SupabaseClient<any, any, any>) {
  return {
    async read(
      ids: string[],
    ): Promise<Record<string, { name: string | null; fetched_at: string; payload?: any }>> {
      const out: Record<string, { name: string | null; fetched_at: string; payload?: any }> = {};
      if (!ids.length) return out;
      try {
        const { data, error } = await supabase
          .from("keepa_seller_cache")
          .select("seller_id, seller_name, fetched_at, payload")
          .in("seller_id", ids);
        if (error) return out;
        for (const row of (data as CachedRow[] | null) ?? []) {
          out[row.seller_id] = {
            name: row.seller_name,
            fetched_at: row.fetched_at,
            payload: row.payload ?? null,
          };
        }
      } catch {
        // table may not exist yet
      }
      return out;
    },
    async write(
      rows: { seller_id: string; seller_name: string | null; payload: any }[],
    ): Promise<void> {
      if (!rows.length) return;
      try {
        await supabase
          .from("keepa_seller_cache")
          .upsert(
            rows.map((r) => ({
              seller_id: r.seller_id,
              seller_name: r.seller_name,
              payload: r.payload ?? null,
              fetched_at: new Date().toISOString(),
            })),
            { onConflict: "seller_id" },
          );
      } catch {
        // best-effort
      }
    },
  };
}
