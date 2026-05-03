/**
 * Phase 25 — Resolve a raw ASIN or Amazon storefront/product URL to a brand.
 *
 * The escape hatch behind the fuzzy picker: when even the loose variant
 * search misses, the user can paste any ASIN or amazon.com/dp/... URL and
 * we look up the brand via Keepa /product.
 */
import { getProductDetails } from "@/lib/keepa";

export interface ResolvedBrand {
  brand: string | null;
  asin: string | null;
  title: string | null;
  source_input: string;
}

const ASIN_RE = /[A-Z0-9]{10}/i;

/**
 * Pull an ASIN out of a raw input. Accepts:
 *   - raw ASIN
 *   - amazon.com/dp/<ASIN>
 *   - amazon.com/gp/product/<ASIN>
 *   - amazon.com/<slug>/dp/<ASIN>?...
 *   - amazon.com/stores/page/<storefrontId>  → no ASIN, returns null
 */
export function extractAsinOrUrl(input: string): {
  asin: string | null;
  storefrontId: string | null;
} {
  const trimmed = input.trim();
  if (!trimmed) return { asin: null, storefrontId: null };

  // Bare ASIN (10 chars uppercase alphanum)
  if (/^[A-Z0-9]{10}$/i.test(trimmed)) {
    return { asin: trimmed.toUpperCase(), storefrontId: null };
  }

  // Storefront page URL
  const storefrontMatch = trimmed.match(/amazon\.com\/stores\/page\/([A-Z0-9-]+)/i);
  if (storefrontMatch) {
    return { asin: null, storefrontId: storefrontMatch[1] };
  }

  // Product URL — try /dp/<ASIN>, /gp/product/<ASIN>, then any 10-char token
  const dpMatch = trimmed.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  if (dpMatch) return { asin: dpMatch[1].toUpperCase(), storefrontId: null };
  const anyAsin = trimmed.match(ASIN_RE);
  if (anyAsin) return { asin: anyAsin[0].toUpperCase(), storefrontId: null };

  return { asin: null, storefrontId: null };
}

export async function resolveBrandFromAsinOrUrl(rawInput: string): Promise<ResolvedBrand> {
  const { asin, storefrontId } = extractAsinOrUrl(rawInput);
  if (!asin && !storefrontId) {
    throw new Error("Could not parse an ASIN or Amazon URL from the input.");
  }
  if (!asin) {
    // Storefront URL alone gives us no Keepa-resolvable brand — return what
    // we know so the UI can surface the storefront link as the "brand".
    return {
      brand: null,
      asin: null,
      title: null,
      source_input: rawInput,
    };
  }
  const products = await getProductDetails([asin], 1);
  const p = products[0];
  if (!p) {
    return { brand: null, asin, title: null, source_input: rawInput };
  }
  return {
    brand: (p.brand || "").trim() || null,
    asin: p.asin,
    title: p.title ?? null,
    source_input: rawInput,
  };
}
