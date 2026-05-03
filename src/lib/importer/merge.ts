import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedBrand } from "./smartscout";
import { tagDisqualifiers } from "./disqualifiers";
import type { BrandField } from "./mapper";

export function normalizeName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

export interface MergeResult {
  inserted: number;
  updated: number;
  skipped: number;
}

/**
 * Upsert parsed brand rows into `brands`.
 * Dedup by name_normalized within the user. Overlay data overwrites only fields
 * it provides — never null-out an existing populated field.
 */
export async function mergeBrands(
  supabase: SupabaseClient,
  userId: string,
  parsed: ParsedBrand[]
): Promise<MergeResult> {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  // Group by normalized name; later rows overwrite earlier ones (last-row wins per file)
  const byName = new Map<string, ParsedBrand>();
  for (const p of parsed) {
    const norm = normalizeName(p.name);
    if (!norm) {
      skipped++;
      continue;
    }
    const existing = byName.get(norm);
    if (existing) {
      byName.set(norm, {
        name: p.name,
        fields: { ...existing.fields, ...p.fields },
        unmappedColumns: existing.unmappedColumns,
      });
    } else {
      byName.set(norm, p);
    }
  }

  for (const [norm, p] of Array.from(byName.entries())) {
    const { data: existingRow, error: selectErr } = await supabase
      .from("brands")
      .select("id, manual_notes, dominant_seller_country, disqualifier_tags")
      .eq("user_id", userId)
      .eq("name_normalized", norm)
      .maybeSingle();

    if (selectErr) {
      skipped++;
      continue;
    }

    const fields = p.fields as Partial<Record<BrandField, unknown>>;

    if (existingRow) {
      const update: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== null && v !== undefined) update[k] = v;
      }
      const notesForTags = (update.manual_notes as string | undefined) ?? existingRow.manual_notes ?? null;
      const countryForTags =
        (update.dominant_seller_country as string | undefined) ??
        existingRow.dominant_seller_country ??
        null;
      const tags = tagDisqualifiers({ notes: notesForTags, dominant_seller_country: countryForTags });
      // Merge with any existing tags so we never null-out flags set by other sources
      const merged = Array.from(new Set([...(existingRow.disqualifier_tags ?? []), ...tags])).sort();
      update.disqualifier_tags = merged;
      update.updated_at = new Date().toISOString();

      if (Object.keys(update).length === 0) {
        skipped++;
        continue;
      }

      const { error: updateErr } = await supabase
        .from("brands")
        .update(update)
        .eq("id", existingRow.id)
        .eq("user_id", userId);

      if (updateErr) skipped++;
      else updated++;
    } else {
      const insertRow: Record<string, unknown> = {
        user_id: userId,
        name: p.name,
        name_normalized: norm,
        // Phase 30 — Bulk imports are a "library to research later," not
        // an active scan list. `deferred` keeps the recovery cron from
        // hammering Keepa on 100s of rows the user never asked to enrich.
        // The brand-detail page shows a "Run scan" button to flip it on
        // demand.
        enrichment_state: "deferred",
      };
      for (const [k, v] of Object.entries(fields)) {
        if (v !== null && v !== undefined && k !== "name") insertRow[k] = v;
      }
      const tags = tagDisqualifiers({
        notes: (insertRow.manual_notes as string | undefined) ?? null,
        dominant_seller_country: (insertRow.dominant_seller_country as string | undefined) ?? null,
      });
      insertRow.disqualifier_tags = tags;

      const { error: insertErr } = await supabase.from("brands").insert(insertRow);
      if (insertErr) skipped++;
      else inserted++;
    }
  }

  return { inserted, updated, skipped };
}

/**
 * In-memory merge for testing/scripts. No DB required.
 * Returns a Map of name_normalized → merged record.
 */
export function mergeInMemory(rows: ParsedBrand[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const p of rows) {
    const norm = normalizeName(p.name);
    if (!norm) continue;
    const existing = out.get(norm) ?? { name: p.name, name_normalized: norm };
    for (const [k, v] of Object.entries(p.fields)) {
      if (v !== null && v !== undefined) existing[k] = v;
    }
    const tags = tagDisqualifiers({
      notes: (existing.manual_notes as string | undefined) ?? null,
      dominant_seller_country: (existing.dominant_seller_country as string | undefined) ?? null,
    });
    existing.disqualifier_tags = tags;
    out.set(norm, existing);
  }
  return out;
}
