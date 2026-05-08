/**
 * Phase 47 — Module 1 orchestrator.
 *
 * Reads the brand row + Keepa snapshot + top sellers, runs the three
 * prompts (disambiguation → ICP → hooks) with USPTO enrichment in
 * between, and persists the verdict to `brand_qualifications`. Drives
 * `brands.qualification_state` through pending → running →
 * complete | error.
 */
import OpenAI from "openai";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { searchTrademark, summarizeUspto } from "./uspto";
import {
  disambiguationPrompt,
  hookPrompt,
  icpPrompt,
  narrativePrompt,
} from "./prompts";
import type {
  BrandAssociatedSeller,
  CandidateEntity,
  CandidateHook,
  ChannelPattern,
  FalsePositiveFlag,
  IcpVerdict,
  LegalEntityType,
  OwnershipSignal,
  PitchMath,
  QualificationRow,
} from "./types";

const DEFAULT_MAIN_MODEL = "gpt-4o";
const DEFAULT_HOOK_MODEL = "gpt-4o-mini";

interface BrandRow {
  id: string;
  name: string;
  user_id: string;
  trailing_12_months: number | null;
  confirmed_ttm_revenue_dollars: number | null;
  est_monthly_revenue: number | null;
  resolved_owner_domain: string | null;
  keepa_brand_controlled_pct: number | null;
}

interface SellerSnap {
  seller_id: string | null;
  seller_name: string | null;
  share_pct: number | null;
}

interface AsinSnap {
  asin: string;
  title: string | null;
}

export interface RunQualificationOpts {
  force?: boolean;
}

export interface RunQualificationResult {
  ok: boolean;
  qualification_id: string | null;
  state: "complete" | "error" | "skipped";
  verdict?: IcpVerdict;
  error?: string;
}

export async function runQualification(
  brandId: string,
  opts: RunQualificationOpts = {},
): Promise<RunQualificationResult> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return {
      ok: false,
      qualification_id: null,
      state: "error",
      error: "missing SUPABASE_SERVICE_ROLE_KEY",
    };
  }

  // 1. Load the brand + reseller snapshot.
  const { data: brand } = await admin
    .from("brands")
    .select(
      "id, name, user_id, trailing_12_months, confirmed_ttm_revenue_dollars, est_monthly_revenue, resolved_owner_domain, keepa_brand_controlled_pct, qualification_state",
    )
    .eq("id", brandId)
    .maybeSingle<
      BrandRow & { qualification_state: string }
    >();
  if (!brand) {
    return {
      ok: false,
      qualification_id: null,
      state: "error",
      error: "brand not found",
    };
  }
  if (brand.qualification_state === "complete" && !opts.force) {
    const { data: existing } = await admin
      .from("brand_qualifications")
      .select("id, icp_verdict")
      .eq("brand_id", brandId)
      .maybeSingle<{ id: string; icp_verdict: IcpVerdict }>();
    if (existing) {
      return {
        ok: true,
        qualification_id: existing.id,
        state: "complete",
        verdict: existing.icp_verdict,
      };
    }
  }

  // Mark running.
  await admin
    .from("brands")
    .update({
      qualification_state: "running",
      updated_at: new Date().toISOString(),
    })
    .eq("id", brandId);

  // 2. Pull seller list + ASIN titles.
  const [sellerRes, asinRes] = await Promise.all([
    admin
      .from("brand_sellers")
      .select("seller_id, seller_name, share_pct")
      .eq("brand_id", brandId)
      .order("share_pct", { ascending: false, nullsFirst: false })
      .limit(10),
    admin
      .from("brand_asins")
      .select("asin, title")
      .eq("brand_id", brandId)
      .limit(10),
  ]);
  const sellers: SellerSnap[] = (sellerRes.data ?? []) as SellerSnap[];
  const asins: AsinSnap[] = (asinRes.data ?? []) as AsinSnap[];

  const sellerNames: string[] = sellers
    .map((s) => s.seller_name ?? null)
    .filter((n): n is string => !!n && n.trim().length > 0);
  const sellerListText = sellers
    .map((s, i) => {
      const share = s.share_pct != null ? ` (${(s.share_pct * 100).toFixed(1)}% buy-box)` : "";
      return `${i + 1}. ${s.seller_name ?? "(unknown)"}${share}`;
    })
    .join("\n") || "(no sellers found)";
  const asinTitles =
    asins
      .map((a, i) => `${i + 1}. ${a.title ?? a.asin}`)
      .join("\n") || "(no ASIN titles)";
  const ttm =
    brand.confirmed_ttm_revenue_dollars ??
    brand.trailing_12_months ??
    (brand.est_monthly_revenue != null ? brand.est_monthly_revenue * 12 : null);
  const ttmText = ttm != null ? `$${Math.round(ttm).toLocaleString("en-US")}` : "unknown";
  const domainText = brand.resolved_owner_domain ?? "(unknown)";

  // 3. Prompt 1 — disambiguation.
  const dis = disambiguationPrompt({
    brand_name: brand.name,
    domain_or_none: domainText,
    seller_list: sellerListText,
    asin_titles: asinTitles,
    ttm_usd: ttmText,
  });
  let candidate_entities: CandidateEntity[] = [];
  let selected_entity: CandidateEntity | null = null;
  let selection_reasoning: string | null = null;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCost = 0;
  let model = DEFAULT_MAIN_MODEL;
  let llmError: string | null = null;

  try {
    const r = await callJsonLLM({
      model: DEFAULT_MAIN_MODEL,
      system: dis.system,
      user: dis.user,
    });
    totalTokensIn += r.tokens_in;
    totalTokensOut += r.tokens_out;
    totalCost += estimateCost(DEFAULT_MAIN_MODEL, r.tokens_in, r.tokens_out);
    const parsed = r.parsed as {
      candidate_entities?: CandidateEntity[];
      selected_entity?: CandidateEntity;
      selection_reasoning?: string;
    };
    candidate_entities = Array.isArray(parsed?.candidate_entities)
      ? parsed.candidate_entities
      : [];
    selected_entity = parsed?.selected_entity ?? candidate_entities[0] ?? null;
    selection_reasoning = parsed?.selection_reasoning ?? null;
    model = DEFAULT_MAIN_MODEL;
  } catch (e) {
    llmError = e instanceof Error ? e.message : String(e);
  }

  // 4. USPTO lookup using selected_entity.name (or fall through to
  //    brand.name if disambiguation failed). Ownership-chain
  //    verification beyond USPTO relies on the LLM's web search.
  const lookupName = selected_entity?.name ?? brand.name;
  const uspto = await searchTrademark(lookupName).catch(() => null);
  const usptoSummary = uspto
    ? summarizeUspto(uspto)
    : "USPTO: not called";

  // 5. Prompt 2 — ICP screen.
  const webEvidence: string[] = [];
  if (selection_reasoning) webEvidence.push(`- ${selection_reasoning}`);
  for (const c of candidate_entities.slice(0, 3)) {
    if (c.evidence_summary) {
      webEvidence.push(
        `- [${c.name}] ${c.evidence_summary}${c.evidence_url ? ` (${c.evidence_url})` : ""}`,
      );
    }
  }
  const icp = icpPrompt({
    selected_entity_json: JSON.stringify(selected_entity ?? {}, null, 2),
    uspto_summary: usptoSummary,
    seller_list: sellerListText,
    web_evidence_bullets:
      webEvidence.join("\n") || "(no additional web evidence collected)",
  });
  let icp_verdict: IcpVerdict = "needs_review";
  let icp_reasoning = "";
  let disqualification_pattern: string | null = null;
  let ownership_signal: OwnershipSignal = "unknown";
  let legal_entity_type: LegalEntityType = "unknown";
  let legal_entity_country: string | null = null;
  try {
    const r = await callJsonLLM({
      model: DEFAULT_MAIN_MODEL,
      system: icp.system,
      user: icp.user,
    });
    totalTokensIn += r.tokens_in;
    totalTokensOut += r.tokens_out;
    totalCost += estimateCost(DEFAULT_MAIN_MODEL, r.tokens_in, r.tokens_out);
    const parsed = r.parsed as {
      icp_verdict?: IcpVerdict;
      icp_reasoning?: string;
      disqualification_pattern?: string | null;
      ownership_signal?: OwnershipSignal;
      legal_entity_type?: LegalEntityType;
      legal_entity_country?: string;
    };
    icp_verdict = parsed?.icp_verdict ?? "needs_review";
    icp_reasoning = String(parsed?.icp_reasoning ?? "").trim();
    disqualification_pattern =
      typeof parsed?.disqualification_pattern === "string" &&
      parsed.disqualification_pattern.length > 0 &&
      parsed.disqualification_pattern !== "null"
        ? parsed.disqualification_pattern
        : null;
    ownership_signal = parsed?.ownership_signal ?? "unknown";
    legal_entity_type = parsed?.legal_entity_type ?? "unknown";
    legal_entity_country = parsed?.legal_entity_country ?? null;
  } catch (e) {
    if (!llmError) llmError = e instanceof Error ? e.message : String(e);
    icp_verdict = "needs_review";
    icp_reasoning = `LLM error during ICP screen: ${e instanceof Error ? e.message : String(e)}`;
  }

  // 6. Prompt 3 — hook ranking. Only meaningful when not hard-disqualified
  //    (we still run it to surface override hooks for needs_review cases).
  let candidate_hooks: CandidateHook[] = [];
  if (icp_verdict !== "disqualified") {
    const hookSystem = hookPrompt({
      brand_name: brand.name,
      selected_entity_json: JSON.stringify(selected_entity ?? {}, null, 2),
      uspto_summary: usptoSummary,
      sellers_with_share_pct: sellerListText,
      public_statements: webEvidence.join("\n") || "(none collected)",
      seller_geos: "(not collected)",
      icp_verdict_and_reasoning: `${icp_verdict} — ${icp_reasoning}`,
    });
    try {
      const r = await callJsonLLM({
        model: DEFAULT_HOOK_MODEL,
        system: hookSystem.system,
        user: hookSystem.user,
      });
      totalTokensIn += r.tokens_in;
      totalTokensOut += r.tokens_out;
      totalCost += estimateCost(DEFAULT_HOOK_MODEL, r.tokens_in, r.tokens_out);
      const parsed = r.parsed as { candidate_hooks?: CandidateHook[] };
      candidate_hooks = Array.isArray(parsed?.candidate_hooks)
        ? parsed.candidate_hooks.slice(0, 5)
        : [];
    } catch {
      candidate_hooks = [];
    }
  }

  // 7. Phase 50 — long-form analyst narrative + brand-associated seller
  //    pre-classification + false-positive flags + channel pattern +
  //    pitch math. Runs AFTER ICP + hooks so the model sees every prior
  //    decision. Failures here are non-fatal: the row still saves with
  //    legacy short reasoning.
  let narrative_markdown: string | null = null;
  let brand_associated_sellers: BrandAssociatedSeller[] | null = null;
  let false_positive_flags: FalsePositiveFlag[] | null = null;
  let channel_pattern: ChannelPattern | null = null;
  let pitch_math: PitchMath | null = null;
  try {
    const hooksSummary =
      candidate_hooks.length === 0
        ? "(no hooks)"
        : candidate_hooks
            .map(
              (h, i) =>
                `${i + 1}. [${h.hook_code}] ${h.hook_text}${h.evidence ? ` — ${h.evidence}` : ""}`,
            )
            .join("\n");
    const brandControlledShare =
      brand.keepa_brand_controlled_pct != null
        ? String(brand.keepa_brand_controlled_pct)
        : "unknown";
    const ttmNumber = ttm != null ? String(Math.round(ttm)) : "unknown";
    const narr = narrativePrompt({
      brand_name: brand.name,
      selected_entity_json: JSON.stringify(selected_entity ?? {}, null, 2),
      uspto_summary: usptoSummary,
      seller_list: sellerListText,
      asin_titles: asinTitles,
      ttm_usd: ttmText,
      ttm_revenue_usd_number: ttmNumber,
      brand_controlled_share_pct: brandControlledShare,
      web_evidence_bullets:
        webEvidence.join("\n") || "(no additional web evidence collected)",
      icp_verdict,
      icp_reasoning,
      disqualification_pattern: disqualification_pattern ?? "none",
      hooks_summary: hooksSummary,
    });
    const r = await callJsonLLM({
      model: DEFAULT_MAIN_MODEL,
      system: narr.system,
      user: narr.user,
      maxTokens: 3000,
    });
    totalTokensIn += r.tokens_in;
    totalTokensOut += r.tokens_out;
    totalCost += estimateCost(DEFAULT_MAIN_MODEL, r.tokens_in, r.tokens_out);
    const parsed = r.parsed as {
      narrative_markdown?: string;
      brand_associated_sellers?: BrandAssociatedSeller[];
      false_positive_flags?: FalsePositiveFlag[];
      channel_pattern?: string | null;
      pitch_math?: PitchMath | null;
    };
    if (typeof parsed?.narrative_markdown === "string") {
      const md = parsed.narrative_markdown.trim();
      narrative_markdown = md.length > 0 ? md : null;
    }
    if (Array.isArray(parsed?.brand_associated_sellers)) {
      brand_associated_sellers = parsed.brand_associated_sellers
        .filter(
          (s): s is BrandAssociatedSeller =>
            !!s &&
            typeof s.seller_name === "string" &&
            typeof s.association_type === "string" &&
            ["brand_owned", "parent_owned", "affiliate", "licensed_distributor"].includes(
              s.association_type,
            ),
        )
        .slice(0, 20);
    }
    if (Array.isArray(parsed?.false_positive_flags)) {
      false_positive_flags = parsed.false_positive_flags
        .filter(
          (f): f is FalsePositiveFlag =>
            !!f && typeof f.flag === "string" && typeof f.explanation === "string",
        )
        .slice(0, 5);
    }
    if (
      typeof parsed?.channel_pattern === "string" &&
      parsed.channel_pattern !== "null" &&
      parsed.channel_pattern.length > 0
    ) {
      channel_pattern = parsed.channel_pattern;
    }
    if (
      icp_verdict === "qualified" &&
      parsed?.pitch_math &&
      typeof parsed.pitch_math === "object"
    ) {
      pitch_math = parsed.pitch_math;
    }
  } catch (e) {
    // Non-fatal — leave narrative null, legacy short reasoning still renders.
    if (!llmError) llmError = e instanceof Error ? e.message : String(e);
  }

  // 8. Persist (upsert by brand_id).
  const nowIso = new Date().toISOString();
  const row = {
    brand_id: brandId,
    brand_name_input: brand.name,
    top_seller_names: sellerNames,
    asin_count: asins.length,
    ttm_revenue_estimate_usd: ttm,
    candidate_entities,
    selected_entity,
    selection_reasoning,
    legal_entity_name: selected_entity?.name ?? null,
    legal_entity_type:
      legal_entity_type !== "unknown"
        ? legal_entity_type
        : selected_entity?.type &&
            ["individual", "corporation", "llc", "subsidiary", "partnership"].includes(
              String(selected_entity.type),
            )
          ? selected_entity.type
          : "unknown",
    legal_entity_country:
      legal_entity_country ?? selected_entity?.country ?? null,
    trademark_owner: uspto?.owner ?? null,
    trademark_attorney: uspto?.attorney ?? null,
    trademark_serial: uspto?.serial ?? null,
    trademark_status: uspto?.status ?? null,
    ownership_signal,
    icp_verdict,
    icp_reasoning,
    disqualification_pattern,
    candidate_hooks,
    // Phase 50 — narrative bundle. All nullable so legacy + transient
    // failures still upsert successfully.
    narrative_markdown,
    brand_associated_sellers,
    false_positive_flags,
    channel_pattern,
    pitch_math,
    llm_model: model,
    llm_tokens_in: totalTokensIn,
    llm_tokens_out: totalTokensOut,
    llm_cost_usd: Number(totalCost.toFixed(4)),
    uspto_called: !!uspto?.called,
    total_cost_usd: Number(totalCost.toFixed(4)),
    state: "complete" as const,
    error_message: llmError,
    updated_at: nowIso,
  };

  const { data: upserted, error: upsertErr } = await admin
    .from("brand_qualifications")
    .upsert(row, { onConflict: "brand_id" })
    .select("id")
    .single();
  if (upsertErr) {
    await admin
      .from("brands")
      .update({
        qualification_state: "error",
        updated_at: nowIso,
      })
      .eq("id", brandId);
    return {
      ok: false,
      qualification_id: null,
      state: "error",
      error: upsertErr.message,
    };
  }

  await admin
    .from("brands")
    .update({
      qualification_state: "complete",
      qualification_id: upserted.id,
      updated_at: nowIso,
    })
    .eq("id", brandId);

  return {
    ok: true,
    qualification_id: upserted.id,
    state: "complete",
    verdict: icp_verdict,
  };
}

/**
 * Read the persisted qualification (if any) for a brand. Used by the
 * `/qualification` GET route + the brand page's QualificationReview.
 */
export async function getQualification(
  brandId: string,
): Promise<QualificationRow | null> {
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data } = await admin
    .from("brand_qualifications")
    .select("*")
    .eq("brand_id", brandId)
    .maybeSingle();
  return (data as QualificationRow | null) ?? null;
}

interface JsonLLMResult {
  parsed: unknown;
  tokens_in: number;
  tokens_out: number;
}

async function callJsonLLM(args: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<JsonLLMResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const resp = await client.chat.completions.create({
    model: args.model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    max_tokens: args.maxTokens,
    messages: [
      { role: "system", content: args.system },
      { role: "user", content: args.user },
    ],
  });
  const text = resp.choices?.[0]?.message?.content ?? "{}";
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  const usage = resp.usage as
    | { prompt_tokens?: number; completion_tokens?: number }
    | undefined;
  return {
    parsed,
    tokens_in: usage?.prompt_tokens ?? 0,
    tokens_out: usage?.completion_tokens ?? 0,
  };
}

/**
 * Conservative public-rate estimate. Numbers are ballpark for cost
 * accounting only — do not rely on these for billing.
 */
function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  // Per-1k-token rates (rough).
  const rates: Record<string, { in: number; out: number }> = {
    "gpt-4o": { in: 0.005, out: 0.015 },
    "gpt-4o-mini": { in: 0.00015, out: 0.0006 },
  };
  const r = rates[model] ?? { in: 0.001, out: 0.003 };
  return (tokensIn / 1000) * r.in + (tokensOut / 1000) * r.out;
}
