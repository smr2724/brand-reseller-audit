/**
 * Phase 23 — Seller-to-brand classification.
 *
 * A seller should be tagged `brand_controlled` (NOT a recoupable
 * reseller) when their name is plausibly the brand selling under an
 * LLC / Inc / DBA. The Phase 4 exact-string match was too strict —
 * "Fantaswick LLC" wasn't matching brand "Fantaswick" because the
 * `buy_box_seller` field captured a Keepa seller-id at first, then the
 * resolved name arrived later in the pipeline.
 *
 * Three signals, in order of confidence:
 *   1. Normalized substring (after stripping LLC/Inc/Ltd/Co/etc.)
 *   2. Token-level Jaccard similarity ≥ 0.6
 *   3. LLM tiebreaker for the 0.4–0.6 ambiguous band, capped per scan
 *
 * Defaults to `reseller` when the budget is exhausted and the case is
 * ambiguous — the audit under-claims brand-control rather than
 * over-claims it (which would tank the recoverable margin number).
 */
import OpenAI from "openai";

const CORPORATE_SUFFIXES = new Set<string>([
  "llc",
  "l.l.c",
  "inc",
  "incorporated",
  "ltd",
  "limited",
  "co",
  "corp",
  "corporation",
  "company",
  "gmbh",
  "ag",
  "sa",
  "sas",
  "pty",
  "pte",
  "plc",
  "holdings",
  "group",
  "groups",
  "enterprise",
  "enterprises",
  "brands",
  "brand",
  "intl",
  "international",
  "global",
  "worldwide",
  "trading",
  "shop",
  "store",
  "stores",
  "us",
  "usa",
  "na",
]);

const NOISE_RE = /[^a-z0-9 ]+/g;
const WHITESPACE_RE = /\s+/g;

export interface SellerClassification {
  is_brand_controlled: boolean;
  reason: string;
  /** Method used to reach the verdict — useful for narrative_json transparency. */
  method: "exact" | "substring" | "jaccard" | "llm" | "fallback";
  /** 0..1 — populated by jaccard / llm paths. */
  confidence: number | null;
}

export interface ClassifyOptions {
  brand_name: string;
  seller_name: string;
  /** Short-circuit signal: Amazon retail (`ATVPDKIKX0DER`) is its own
   * thing — never classify as brand-controlled. */
  seller_id?: string | null;
  /** Allow the LLM tiebreaker call. The caller bumps a counter and
   * sets this false once budget is exhausted. */
  llm_budget_remaining?: number;
}

/** Lowercase + strip punctuation + drop common corporate suffix tokens. */
export function normalizeName(name: string): { tokens: string[]; cleaned: string } {
  const lower = name.toLowerCase().replace(NOISE_RE, " ").replace(WHITESPACE_RE, " ").trim();
  const rawTokens = lower.split(" ").filter(Boolean);
  const tokens = rawTokens.filter((t) => !CORPORATE_SUFFIXES.has(t));
  return { tokens, cleaned: tokens.join("") };
}

export function tokenJaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  A.forEach((t) => {
    if (B.has(t)) inter += 1;
  });
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}

export const AMAZON_RETAIL_SELLER_ID = "ATVPDKIKX0DER";

/**
 * Classify a single seller against the brand. Synchronous-fast paths
 * resolve the obvious cases; the LLM tiebreaker is only invoked when
 * Jaccard lands in the ambiguous 0.4–0.6 band AND budget remains.
 */
export async function classifySeller(
  opts: ClassifyOptions,
): Promise<SellerClassification> {
  const { brand_name, seller_name, seller_id } = opts;

  // Amazon retail is never a brand-controlled seller.
  if (seller_id && seller_id === AMAZON_RETAIL_SELLER_ID) {
    return {
      is_brand_controlled: false,
      reason: "Amazon Retail (ATVPDKIKX0DER) — never classified as brand-controlled.",
      method: "exact",
      confidence: 1,
    };
  }

  if (!seller_name || !brand_name) {
    return {
      is_brand_controlled: false,
      reason: "Missing seller or brand name — defaulted to reseller.",
      method: "fallback",
      confidence: null,
    };
  }

  const brandN = normalizeName(brand_name);
  const sellerN = normalizeName(seller_name);

  // Exact normalized match.
  if (brandN.cleaned && brandN.cleaned === sellerN.cleaned) {
    return {
      is_brand_controlled: true,
      reason: `Seller "${seller_name}" normalizes to the brand name after stripping corporate suffixes.`,
      method: "exact",
      confidence: 1,
    };
  }

  // Substring (after suffix stripping). "fantaswick" ⊂ "fantaswickllc"
  // works on the original strip, but corporate-suffix tokens have already
  // been removed from `cleaned`, so we check the original lower-cased
  // alphanumeric form too for robustness.
  const brandSlug = brand_name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const sellerSlug = seller_name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (
    brandSlug &&
    sellerSlug &&
    (sellerSlug.includes(brandSlug) || brandSlug.includes(sellerSlug))
  ) {
    return {
      is_brand_controlled: true,
      reason: `Seller "${seller_name}" contains the brand name "${brand_name}" as a substring.`,
      method: "substring",
      confidence: 0.95,
    };
  }
  if (
    brandN.cleaned &&
    sellerN.cleaned &&
    (sellerN.cleaned.includes(brandN.cleaned) ||
      brandN.cleaned.includes(sellerN.cleaned))
  ) {
    return {
      is_brand_controlled: true,
      reason: `Seller "${seller_name}" contains the brand name after corporate-suffix stripping.`,
      method: "substring",
      confidence: 0.9,
    };
  }

  // Token-level Jaccard. "Acme Brands International" vs "Acme" → 1/1.
  const jacc = tokenJaccard(brandN.tokens, sellerN.tokens);
  if (jacc >= 0.6) {
    return {
      is_brand_controlled: true,
      reason: `Token-level Jaccard similarity ${jacc.toFixed(2)} ≥ 0.6 between "${seller_name}" and brand "${brand_name}".`,
      method: "jaccard",
      confidence: jacc,
    };
  }

  // Ambiguous band — try the LLM tiebreaker if there's budget left.
  if (jacc >= 0.4 && (opts.llm_budget_remaining ?? 0) > 0) {
    try {
      const llm = await llmTiebreaker(brand_name, seller_name);
      if (llm) {
        return {
          is_brand_controlled: !!llm.brand_controlled,
          reason: `LLM tiebreaker: ${llm.reasoning} (confidence ${llm.confidence.toFixed(2)}).`,
          method: "llm",
          confidence: llm.confidence,
        };
      }
    } catch (e) {
      console.warn("[seller-classification] LLM tiebreaker failed:", e);
    }
    // LLM call failed — fall through to conservative default.
    return {
      is_brand_controlled: false,
      reason: `Ambiguous (Jaccard ${jacc.toFixed(2)}); LLM tiebreaker unavailable — defaulted to reseller.`,
      method: "fallback",
      confidence: jacc,
    };
  }

  return {
    is_brand_controlled: false,
    reason:
      jacc > 0
        ? `No substring match; Jaccard ${jacc.toFixed(2)} below threshold — classified as reseller.`
        : `No name overlap with brand — classified as reseller.`,
    method: "fallback",
    confidence: jacc,
  };
}

interface LlmVerdict {
  brand_controlled: boolean;
  confidence: number;
  reasoning: string;
}

let cachedClient: OpenAI | null | undefined;
function getOpenAI(): OpenAI | null {
  if (cachedClient !== undefined) return cachedClient;
  const key = process.env.OPENAI_API_KEY;
  cachedClient = key ? new OpenAI({ apiKey: key }) : null;
  return cachedClient;
}

const LLM_MODEL = process.env.OPENAI_CLASSIFIER_MODEL || "gpt-4o-mini";

async function llmTiebreaker(
  brand: string,
  seller: string,
): Promise<LlmVerdict | null> {
  const client = getOpenAI();
  if (!client) return null;

  const resp = await client.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0,
    max_tokens: 200,
    tools: [
      {
        type: "function",
        function: {
          name: "emit_verdict",
          description:
            "Decide whether the seller is plausibly the brand's own legal selling entity (e.g. its DBA, parent LLC, or subsidiary).",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              brand_controlled: { type: "boolean" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              reasoning: { type: "string" },
            },
            required: ["brand_controlled", "confidence", "reasoning"],
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "emit_verdict" } },
    messages: [
      {
        role: "system",
        content:
          "You classify Amazon sellers as either the brand's own selling entity (brand-controlled) or a third-party reseller. Be conservative: only mark brand_controlled when the seller name is clearly the brand's legal entity, DBA, or known subsidiary. When uncertain, return brand_controlled=false.",
      },
      {
        role: "user",
        content: `Given brand "${brand}" and seller "${seller}", is the seller plausibly the brand's own selling entity? Respond via the tool call.`,
      },
    ],
  });

  const call = resp.choices?.[0]?.message?.tool_calls?.[0];
  const args =
    call && "function" in call ? call.function?.arguments : undefined;
  if (!args) return null;
  try {
    const parsed = JSON.parse(args) as LlmVerdict;
    if (typeof parsed.brand_controlled !== "boolean") return null;
    const confidence =
      typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5;
    const reasoning =
      typeof parsed.reasoning === "string" && parsed.reasoning.length
        ? parsed.reasoning.slice(0, 240)
        : "no reasoning provided";
    return {
      brand_controlled: parsed.brand_controlled,
      confidence,
      reasoning,
    };
  } catch {
    return null;
  }
}

/**
 * Classify a list of sellers against a brand, sharing the LLM budget
 * across the whole call. Returns the same array order with classification
 * attached.
 */
export async function classifySellers<
  T extends { seller_name: string; seller_id?: string | null },
>(
  brand_name: string,
  sellers: T[],
  opts: { llm_budget?: number } = {},
): Promise<Array<T & { classification: SellerClassification }>> {
  const budget = Math.max(0, opts.llm_budget ?? 5);
  let remaining = budget;
  const out: Array<T & { classification: SellerClassification }> = [];
  for (const s of sellers) {
    const before = remaining;
    const classification = await classifySeller({
      brand_name,
      seller_name: s.seller_name,
      seller_id: s.seller_id ?? null,
      llm_budget_remaining: remaining,
    });
    if (classification.method === "llm") remaining = Math.max(0, before - 1);
    out.push({ ...s, classification });
  }
  return out;
}

/**
 * Aggregate brand-controlled share from already-classified sellers.
 * `share_pct` is 0..1; weight by share when available, otherwise by
 * `asins_won`. Returns null when there's nothing to weight against.
 */
export function aggregateBrandControlledShare(
  classified: Array<{
    classification: SellerClassification;
    share_pct?: number | null;
    asins_won?: number | null;
  }>,
): number | null {
  let totalShare = 0;
  let brandShare = 0;
  let useShare = false;
  for (const c of classified) {
    if (typeof c.share_pct === "number" && Number.isFinite(c.share_pct)) {
      useShare = true;
      totalShare += c.share_pct;
      if (c.classification.is_brand_controlled) brandShare += c.share_pct;
    }
  }
  if (useShare && totalShare > 0) return brandShare / totalShare;

  let totalAsins = 0;
  let brandAsins = 0;
  for (const c of classified) {
    const w = c.asins_won ?? 0;
    totalAsins += w;
    if (c.classification.is_brand_controlled) brandAsins += w;
  }
  if (totalAsins > 0) return brandAsins / totalAsins;
  return null;
}

/**
 * Amazon-1P disqualifier predicate. Computed from buy-box / asins-won
 * share where Amazon retail (`ATVPDKIKX0DER`) is the seller. Threshold
 * configurable via `AMAZON_1P_THRESHOLD_PCT` (default 0.10).
 */
export function amazon1pThreshold(): number {
  const raw = process.env.AMAZON_1P_THRESHOLD_PCT;
  if (raw == null) return 0.10;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return 0.10;
  return n;
}

export function isAmazon1pBrand(amazonShare: number | null | undefined): boolean {
  if (amazonShare == null || !Number.isFinite(amazonShare)) return false;
  return amazonShare >= amazon1pThreshold();
}
