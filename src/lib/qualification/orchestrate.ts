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
import { computeSegment, type Segment } from "./segments";
import { computePitchMath } from "./pitch-math";
import { sanitizeNarrativeMarkdown } from "./narrative-sanitizer";
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

// Phase 56 — bump main model to gpt-4.1 (used elsewhere for higher-stakes
// owner-resolver web search). The qualification narrative drives report
// routing; the cost premium over gpt-4o is worth it.
const DEFAULT_MAIN_MODEL = "gpt-4.1";
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

  // 2. Pull seller list + ASIN titles. Phase 56: also fetch the
  // per-seller `classification` column so we can compute the
  // deterministic segment without re-classifying.
  const [sellerRes, asinRes, classRes] = await Promise.all([
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
    admin
      .from("brand_sellers")
      .select("seller_id, share_pct, classification")
      .eq("brand_id", brandId),
  ]);
  const sellers: SellerSnap[] = (sellerRes.data ?? []) as SellerSnap[];
  const asins: AsinSnap[] = (asinRes.data ?? []) as AsinSnap[];
  const allClassified = (classRes.data ?? []) as Array<{
    seller_id: string | null;
    share_pct: number | null;
    classification: string | null;
  }>;

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

  // 2b. Phase 56 — deterministic segment computation. Aggregates share by
  // classification bucket; defaults unclassified sellers to 'reseller'
  // (Edge D). Anti-Amazon stance + enterprise/PE/public flags are filled
  // in after ICP runs and may flip the segment — we recompute then.
  const shares = aggregateShares(allClassified);
  const segmentNoFlags = computeSegment({
    brand_owned_pct: shares.brand_owned * 100,
    authorized_pct: shares.authorized * 100,
    unauthorized_pct: shares.unauthorized * 100,
    amazon_pct: shares.amazon * 100,
    ttm_revenue_usd: ttm ?? 0,
    has_trademark: true, // pessimistic default until USPTO + ICP run
    is_anti_amazon: false,
    is_enterprise_pe_public: false,
  });

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
  const brandControlledShareIcp =
    brand.keepa_brand_controlled_pct != null
      ? String(brand.keepa_brand_controlled_pct)
      : "unknown";
  const icp = icpPrompt({
    brand_name: brand.name,
    selected_entity_json: JSON.stringify(selected_entity ?? {}, null, 2),
    uspto_summary: usptoSummary,
    seller_list: sellerListText,
    brand_controlled_share_pct: brandControlledShareIcp,
    web_evidence_bullets:
      webEvidence.join("\n") || "(no additional web evidence collected)",
    computed_segment: segmentNoFlags.segment,
    computed_segment_reason: segmentNoFlags.reason,
    computed_qualified: String(segmentNoFlags.qualified),
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

  // 5b. Phase 56 — recompute the final segment now that the ICP screen
  // has filled in the LLM-determined flags (anti-Amazon stance,
  // enterprise/PE/public status, trademark ownership inferred from
  // USPTO data). This is the segment we persist + drive routing on.
  const isAntiAmazon =
    disqualification_pattern === "anti_amazon" ||
    (icp_verdict === "disqualified" && disqualification_pattern === "no_amazon_presence");
  const isEnterprise =
    disqualification_pattern === "public_company" ||
    disqualification_pattern === "enterprise" ||
    disqualification_pattern === "subsidiary_of_giant" ||
    ownership_signal === "public" ||
    ownership_signal === "pe_owned";
  const hasTrademark =
    !!uspto?.owner &&
    selected_entity?.name != null &&
    // crude string overlap — if the USPTO owner doesn't reference the
    // brand or selected entity at all, treat as a trademark split signal.
    (uspto.owner.toLowerCase().includes(brand.name.toLowerCase().split(" ")[0] ?? "") ||
      uspto.owner.toLowerCase().includes(selected_entity.name.toLowerCase().split(" ")[0] ?? ""));
  const finalSegment = computeSegment({
    brand_owned_pct: shares.brand_owned * 100,
    authorized_pct: shares.authorized * 100,
    unauthorized_pct: shares.unauthorized * 100,
    amazon_pct: shares.amazon * 100,
    ttm_revenue_usd: ttm ?? 0,
    has_trademark: hasTrademark || !uspto, // give benefit of doubt when USPTO not called
    is_anti_amazon: isAntiAmazon,
    is_enterprise_pe_public: isEnterprise,
  });

  // Edge F per Phase 56 spec — deterministic segment wins. If the
  // segment says qualified but ICP said disqualified for a soft reason
  // (or vice versa), reconcile to the segment's verdict.
  if (finalSegment.qualified && icp_verdict === "disqualified") {
    console.warn(
      "[qualification] segment qualified but ICP disqualified — segment wins (Edge F)",
      brandId,
      { ICP_verdict: icp_verdict, segment: finalSegment.segment },
    );
    icp_verdict = "qualified";
    disqualification_pattern = null;
  } else if (!finalSegment.qualified && icp_verdict === "qualified") {
    console.warn(
      "[qualification] segment disqualified but ICP qualified — segment wins (Edge F)",
      brandId,
      { ICP_verdict: icp_verdict, segment: finalSegment.segment },
    );
    icp_verdict = "disqualified";
    // Map segment back to disqualification_pattern where it fits the enum.
    const segmentToPattern: Partial<Record<Segment, string>> = {
      anti_amazon_stance: "anti_amazon",
      enterprise_pe_public: "enterprise",
      trademark_split: "other",
      below_revenue_floor: "other",
      amazon_vendor_central: "other",
      brand_self_managed: "brand_self_managed",
    };
    disqualification_pattern =
      segmentToPattern[finalSegment.segment] ?? disqualification_pattern;
  }

  // 6. Prompt 3 — hook ranking. Phase 51: only generate when verdict is
  //    'qualified'. needs_review and disqualified cases get no hooks —
  //    they are not actionable outreach targets. Manual override on a
  //    needs_review brand will regenerate hooks via the override flow.
  let candidate_hooks: CandidateHook[] = [];
  if (icp_verdict === "qualified") {
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
  // Phase 56 — LLM-emitted channel_pattern is kept only as a hint for
  // logging. The persisted channel_pattern is overwritten by the
  // deterministic finalSegment.segment in the row below.
  let channel_pattern_hint: ChannelPattern | null = null;
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
      computed_segment: finalSegment.segment,
      computed_segment_reason: finalSegment.reason,
      computed_qualified: String(finalSegment.qualified),
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
    // Phase 57 — `pitch_math` is no longer accepted from the LLM. The
    // narrative prompt forbids it; we compute the canonical pitch_math
    // server-side below using `computeLegionEconomics` /
    // `computeBenchmarkEconomics`. Any pitch_math the LLM still emits is
    // silently discarded.
    const parsed = r.parsed as {
      narrative_markdown?: string;
      brand_associated_sellers?: BrandAssociatedSeller[];
      false_positive_flags?: FalsePositiveFlag[];
      channel_pattern?: string | null;
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
      channel_pattern_hint = parsed.channel_pattern;
      if (channel_pattern_hint !== finalSegment.segment) {
        console.info(
          "[qualification] LLM channel_pattern hint differs from deterministic segment (segment wins)",
          brandId,
          {
            llm_hint: channel_pattern_hint,
            deterministic_segment: finalSegment.segment,
          },
        );
      }
    }
  } catch (e) {
    // Non-fatal — leave narrative null, legacy short reasoning still renders.
    if (!llmError) llmError = e instanceof Error ? e.message : String(e);
  }

  // Phase 57 — sanitize the narrative for partial-reclaim hedging. If
  // any forbidden phrase landed (the LLM is supposed to refuse, but the
  // sanitizer is the backstop) we substitute the sentence with a pointer
  // to the Pitch Math card and log the removed text into error_message.
  let sanitizer_removals: string[] = [];
  if (narrative_markdown) {
    const sanitized = sanitizeNarrativeMarkdown(narrative_markdown);
    if (sanitized.removed.length > 0) {
      narrative_markdown = sanitized.cleaned;
      sanitizer_removals = sanitized.removed;
      console.warn(
        "[qualification] narrative_markdown tripped reclaim sanitizer",
        brandId,
        { removed: sanitized.removed },
      );
    }
  }

  // Phase 57 — server-compute pitch_math from the canonical economics
  // functions. For tight-mode (Segment 2) brands the share is the
  // authorized slice; for every other qualified segment the share is the
  // unauthorized reseller slice (which is what RCG removes in Phase 1).
  if (icp_verdict === "qualified" && finalSegment.qualified) {
    const isTight = finalSegment.segment === "authorized_network_healthy";
    const resellerControlledShare = isTight ? shares.authorized : shares.unauthorized;
    pitch_math = computePitchMath({
      ttm_revenue_usd: ttm,
      reseller_controlled_share: resellerControlledShare,
      segment: finalSegment.segment,
    });
  }

  // 7b. Phase 51 — verdict reconciliation belt-and-suspenders.
  //
  //  If the narrative recommendation explicitly says "skip", "not a fit",
  //  "don't reach out", or "disqualified" but the ICP verdict came back
  //  'qualified' or 'needs_review', we have a two-LLM disagreement. The
  //  prompt fix in Phase 51 should drive these to zero, but if one
  //  slips through we downgrade to 'needs_review' (NEVER silently to
  //  'disqualified' — needs_review is the correct middle ground) and
  //  attach a reconciliation note for the UI.
  let icp_reconciliation_note: string | null = null;
  if (
    narrative_markdown &&
    (icp_verdict === "qualified" || icp_verdict === "needs_review")
  ) {
    const conflict = detectNarrativeDisqualification(narrative_markdown);
    if (conflict) {
      icp_reconciliation_note =
        `Narrative recommendation says "${conflict}" but ICP screen returned ${icp_verdict}. ` +
        `Verdict downgraded to needs_review pending human review. ` +
        `If the narrative is correct, the brand is likely brand-self-managed ` +
        `or otherwise out of ICP — do not silently overwrite to disqualified.`;
      console.warn(
        "[qualification] verdict/narrative mismatch",
        brandId,
        { prior: icp_verdict, narrative_signal: conflict },
      );
      icp_verdict = "needs_review";
      // If we downgraded after generating hooks, drop them — hooks only
      // apply to qualified brands.
      candidate_hooks = [];
    }
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
    icp_reconciliation_note,
    disqualification_pattern,
    candidate_hooks,
    // Phase 50 — narrative bundle. All nullable so legacy + transient
    // failures still upsert successfully.
    narrative_markdown,
    brand_associated_sellers,
    false_positive_flags,
    // Phase 56 — Edge F: deterministic segment is source of truth.
    // We force channel_pattern to the segment slug so the renderer's
    // routing logic reads consistent values whether or not the LLM
    // also emitted a channel_pattern.
    channel_pattern: finalSegment.segment,
    segment: finalSegment.segment,
    pitch_math,
    llm_model: model,
    llm_tokens_in: totalTokensIn,
    llm_tokens_out: totalTokensOut,
    llm_cost_usd: Number(totalCost.toFixed(4)),
    uspto_called: !!uspto?.called,
    total_cost_usd: Number(totalCost.toFixed(4)),
    state: "complete" as const,
    error_message:
      sanitizer_removals.length > 0
        ? `${llmError ? llmError + " | " : ""}reclaim_sanitizer_removed: ${JSON.stringify(sanitizer_removals).slice(0, 800)}`
        : llmError,
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
 * Phase 51 — scan the narrative markdown for a disqualifying signal in
 * the Recommendation section. Returns the matched phrase, or null when
 * the narrative is consistent with a positive verdict.
 *
 * We only inspect the tail of the document (the Recommendation usually
 * lives in the last ~600 characters) so we do not false-positive on
 * mid-memo phrasing like "this would normally be a skip, but...".
 */
function detectNarrativeDisqualification(markdown: string): string | null {
  const tail = markdown.slice(-1200).toLowerCase();
  const recIdx = tail.lastIndexOf("recommendation");
  const window = recIdx >= 0 ? tail.slice(recIdx) : tail;
  const signals = [
    "skip this one",
    "skip this",
    "don't reach out",
    "do not reach out",
    "not a fit",
    "out of icp",
    "disqualified",
    "don't generate the report",
    "do not generate the report",
  ];
  for (const s of signals) {
    if (window.includes(s)) return s;
  }
  return null;
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
    "gpt-4.1": { in: 0.002, out: 0.008 },
  };
  const r = rates[model] ?? { in: 0.001, out: 0.003 };
  return (tokensIn / 1000) * r.in + (tokensOut / 1000) * r.out;
}

/**
 * Phase 56 — aggregate buy-box shares by classification bucket.
 * Defaults `unclassified` / unknown rows to `reseller` (Edge D).
 * Returns shares as fractions (0..1) that sum to ≤ 1; the segmentation
 * function multiplies by 100 for its percent-based thresholds.
 */
function aggregateShares(
  rows: Array<{
    seller_id: string | null;
    share_pct: number | null;
    classification: string | null;
  }>,
): {
  brand_owned: number;
  authorized: number;
  amazon: number;
  unauthorized: number;
} {
  let brand_owned = 0;
  let authorized = 0;
  let amazon = 0;
  let unauthorized = 0;
  for (const r of rows) {
    const share = typeof r.share_pct === "number" ? r.share_pct : 0;
    if (!Number.isFinite(share) || share <= 0) continue;
    // Force Amazon retail to the 'amazon' bucket regardless of stored
    // classification — defense in depth even with the trigger in place.
    if (r.seller_id === "ATVPDKIKX0DER") {
      amazon += share;
      continue;
    }
    switch (r.classification) {
      case "brand_owned":
        brand_owned += share;
        break;
      case "authorized":
        authorized += share;
        break;
      case "amazon":
        amazon += share;
        break;
      case "reseller":
      default:
        unauthorized += share;
        break;
    }
  }
  // share_pct may be 0..1 or 0..100 depending on age of the row; normalize.
  const sum = brand_owned + authorized + amazon + unauthorized;
  if (sum > 1.5) {
    // Treat as 0..100, normalize to 0..1.
    return {
      brand_owned: brand_owned / 100,
      authorized: authorized / 100,
      amazon: amazon / 100,
      unauthorized: unauthorized / 100,
    };
  }
  return { brand_owned, authorized, amazon, unauthorized };
}
