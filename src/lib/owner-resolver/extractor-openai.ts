/**
 * Phase 34 / 34.1 — Owner-name extractor (OpenAI Responses API, gpt-5-mini).
 *
 * Reads ALL evidence (USPTO TSDR registered owner of record + per-query
 * full assistant answer text + citation URL list) and asks a reasoning
 * model to extract the canonical OWNING company entities.
 *
 * Phase 34.1 changes:
 *   - The prompt now spells out an explicit SIGNAL HIERARCHY so the model
 *     stops returning generic brand-page registrants (e.g. "Terra Pure
 *     Labs (USA)") when a higher-tier "produced by Diversified Hospitality
 *     Solutions" attestation is right there in the answer text.
 *   - Evidence is structured into three named sections (USPTO TSDR /
 *     PER-QUERY ANSWERS / CITED URLS) rather than a flat list of (title,
 *     snippet, url) tuples. The full per-query prose is included verbatim
 *     up to a per-query truncation cap so attestations survive.
 *   - Industry disambiguation is mandated against `brand.category`.
 *
 * Output is parsed against a strict JSON shape; anything below
 * MIN_CONFIDENCE is dropped, and the top 3 (by confidence) are returned.
 */
import type { RawOwnerCandidate } from "./types";
import type { PerQueryAnswer } from "./web-search-types";
import { rateLimit } from "./rate-limit";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5-mini";
const MIN_CONFIDENCE = 0.3;
// Phase 34.2 — soft cap kept high so the transparency checkpoint can show
// every plausible candidate (the old 3-cap was a Phase-34 decision; with
// the user-in-the-loop we want all >= MIN_CONFIDENCE).
const MAX_CANDIDATES = 10;
const PER_QUERY_TEXT_CHAR_LIMIT = 3000;
const TOTAL_PROMPT_CHAR_LIMIT = 50_000;

export interface ExtractedCandidate {
  canonical_company_name: string;
  domain: string | null;
  confidence: number;
  reasoning: string;
  evidence_urls: string[];
}

export interface ExtractorInputHit {
  source: string; // "uspto" | "web_search"
  title: string | null;
  snippet: string | null;
  url: string | null;
}

/**
 * Phase 34.1 — Authoritative USPTO TSDR record, passed separately so the
 * prompt can frame it as the highest-tier signal.
 */
export interface ExtractorUsptoEvidence {
  owner_name: string;
  entity_type: string | null;
  address: string | null;
  registration_number: string | null;
  serial_number: string | null;
  mark_text: string | null;
  goods_services: string | null;
  evidence_url: string | null;
}

export interface ExtractorOptions {
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  model?: string;
}

export interface ExtractorResult {
  candidates: ExtractedCandidate[];
  raw: unknown;
  error: string | null;
}

const SYSTEM_PROMPT = `You are an expert at identifying the legal entity that owns a consumer brand.
Given a brand name, its category, and a structured set of evidence, extract
the OWNING company entity (the legal entity that owns the brand or holds
its registered trademark).

SIGNAL HIERARCHY (highest to lowest authority for "who owns this brand"):
1. USPTO TSDR registered owner of record (if provided in evidence). This is
   the legal source of truth on US trademark ownership; treat it as
   authoritative unless the brand explicitly operates under a different
   parent entity that licenses the mark.
2. Trademark filings on third-party sites (Justia, IndiaFilings, TM View,
   etc.) that explicitly list "Trademark of {Company}".
3. "Manufactured by", "Produced by", "Distributed by", "A brand of"
   attestations in product documentation, SDS sheets, brand sections of
   distributor pages, or about-us pages.
4. Domain ownership of the canonical product website (e.g.,
   diversifiedhospitality.com hosting product PDFs and SDS sheets for the
   brand).
5. Generic brand landing pages — these are LOW signal because the same
   wordmark may have multiple unrelated registrants in different
   industries. A page titled "{Brand} - Home" tells you almost nothing
   about who owns the entity.

DISAMBIGUATION RULES:
- For brands operating in multiple industries (e.g., a "Terra Pure"
  supplement brand AND a "Terra Pure" hospitality brand), match the
  candidate's industry to the input brand's category. Drop unrelated
  industries entirely — do NOT include them as low-confidence options.
- A company hosting an "About Us" page mentioning the brand is NOT
  necessarily the owner. The owner statement must be explicit ("trademark
  of...", "produced by...", "manufactured by...", "a brand of...") OR the
  candidate must hold the USPTO registration.
- Prefer specific legal entity names ("Diversified Hospitality Solutions,
  Ltd.") over generic brand variants ("Terra Pure Labs", "TerraPure EU").
- Use the Inc./LLC/Ltd./Corp./S.A./GmbH suffix when the evidence shows it.
- Reject obvious resellers, distributors, marketplaces, and law firms
  (unless the law firm filed the trademark on behalf of an explicitly
  named owner — in which case use the owner, not the firm).
- Page titles like "About Us", "Home", "Inicio", "Safety Data Sheet",
  "Contact" are NOT company names. Read the per-query answer text and the
  domain to find the underlying owner.
- Reject duplicates (same legal entity with minor name variations — pick
  one canonical form).

CONFIDENCE RUBRIC (apply strictly):
- >= 0.8: USPTO TSDR registered owner of record OR explicit
  trademark-of-{Company} statement on a third-party trademark site.
- 0.6 - 0.8: Clear "produced by" / "manufactured by" / "a brand of"
  attestation in cited prose, with the named entity matching the brand's
  category.
- 0.3 - 0.6: Domain hosting the product line / SDS sheets, but no explicit
  ownership phrase. Still plausibly the owner.
- < 0.3: Drop. Do not return.

OUTPUT REQUIREMENTS:
- 1–3 candidates, sorted by confidence DESC.
- Domain is your best guess of the canonical website for that entity (omit
  if unsure — set to null rather than guessing).
- evidence_urls must be 1–5 URLs drawn from the evidence that support the
  extraction.
- reasoning must cite the specific sentence or phrase that drove the
  ranking (e.g., "Per-query answer for '\"Terra Pure\" company who makes':
  'produced by Diversified Hospitality Solutions, based in San Diego'").
- If no evidence clearly identifies the owner, return an empty candidates
  array — do NOT pad with low-confidence guesses.`;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          canonical_company_name: { type: "string" },
          domain: { type: ["string", "null"] },
          confidence: { type: "number" },
          reasoning: { type: "string" },
          evidence_urls: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: [
          "canonical_company_name",
          "domain",
          "confidence",
          "reasoning",
          "evidence_urls",
        ],
      },
    },
  },
  required: ["candidates"],
} as const;

/**
 * Build the user prompt with three named evidence sections. Truncates to
 * stay under TOTAL_PROMPT_CHAR_LIMIT.
 */
export function buildUserPrompt(
  brandName: string,
  category: string | null,
  uspto: ReadonlyArray<ExtractorUsptoEvidence>,
  perQueryAnswers: ReadonlyArray<PerQueryAnswer>,
  hits: ReadonlyArray<ExtractorInputHit>,
): string {
  const lines: string[] = [];
  lines.push(`Brand name: ${brandName}`);
  if (category) lines.push(`Category: ${category}`);
  lines.push("");

  // 1. USPTO TSDR — authoritative registered owners.
  lines.push("=== USPTO TSDR REGISTERED OWNERS (highest authority) ===");
  if (uspto.length === 0) {
    lines.push(
      "(none — no LIVE US trademark registration matched this brand exactly)",
    );
  } else {
    for (let i = 0; i < uspto.length; i += 1) {
      const u = uspto[i]!;
      lines.push(
        `[USPTO ${i + 1}] REGISTERED TRADEMARK OWNER (USPTO TSDR): ${u.owner_name}` +
          (u.entity_type ? `, entity_type=${u.entity_type}` : "") +
          (u.address ? `, address=${u.address}` : "") +
          (u.registration_number ? `, registration=${u.registration_number}` : "") +
          (u.serial_number ? `, serial=${u.serial_number}` : "") +
          (u.mark_text ? `, mark="${u.mark_text}"` : "") +
          (u.goods_services
            ? `, goods/services=${u.goods_services.slice(0, 240)}`
            : "") +
          (u.evidence_url ? `\n    ${u.evidence_url}` : ""),
      );
    }
  }
  lines.push("");

  // 2. Per-query full answer text. This is where attestations like
  // "produced by ..." live and where the prior extractor was getting too
  // little signal.
  lines.push("=== PER-QUERY FULL ANSWER TEXT (prose evidence) ===");
  if (perQueryAnswers.length === 0) {
    lines.push("(none)");
  } else {
    for (let i = 0; i < perQueryAnswers.length; i += 1) {
      const a = perQueryAnswers[i]!;
      const text = (a.full_text ?? "").slice(0, PER_QUERY_TEXT_CHAR_LIMIT);
      lines.push(`QUERY ${i + 1}: ${a.query}`);
      lines.push("FULL ANSWER TEXT:");
      lines.push(text.length > 0 ? text : "(no answer text returned)");
      if (a.citation_urls.length > 0) {
        lines.push("Citations:");
        for (const c of a.citation_urls.slice(0, 12)) {
          lines.push(`  - ${c.title ?? "(untitled)"} — ${c.url}`);
        }
      }
      lines.push("");
    }
  }

  // 3. Flat citation list — useful when the model wants to glance at all
  // unique URLs at once.
  lines.push("=== ALL CITED URLS (flat, deduped) ===");
  const seen = new Set<string>();
  let urlCount = 0;
  for (const a of perQueryAnswers) {
    for (const c of a.citation_urls) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      urlCount += 1;
      lines.push(`  - ${c.title ?? "(untitled)"} — ${c.url}`);
      if (urlCount >= 60) break;
    }
    if (urlCount >= 60) break;
  }
  for (const h of hits) {
    if (!h.url || seen.has(h.url)) continue;
    seen.add(h.url);
    urlCount += 1;
    lines.push(`  - ${h.title ?? "(untitled)"} — ${h.url}`);
    if (urlCount >= 60) break;
  }
  if (urlCount === 0) lines.push("(none)");

  lines.push("");
  lines.push(
    "Apply the SIGNAL HIERARCHY and CONFIDENCE RUBRIC strictly. Return strict " +
      "JSON matching the schema. If no evidence clearly identifies the " +
      "owner, return an empty candidates array.",
  );

  let body = lines.join("\n");
  if (body.length > TOTAL_PROMPT_CHAR_LIMIT) {
    body = `${body.slice(0, TOTAL_PROMPT_CHAR_LIMIT - 200)}\n…[truncated to fit context budget]…`;
  }
  return body;
}

/**
 * Build extractor input from RawOwnerCandidate arrays — convenience for the
 * orchestrator which already has the merged candidate list. Kept for
 * backwards compatibility; the orchestrator now also passes USPTO TSDR
 * evidence + per-query answers separately.
 */
export function buildExtractorHitsFromCandidates(
  candidates: ReadonlyArray<RawOwnerCandidate>,
): ExtractorInputHit[] {
  const hits: ExtractorInputHit[] = [];
  for (const c of candidates) {
    hits.push({
      source: c.candidate_source,
      title: c.candidate_company_name || null,
      snippet: c.evidence_text,
      url: c.evidence_url,
    });
  }
  return hits;
}

/**
 * Phase 34.1 — Convert the orchestrator's USPTO RawOwnerCandidate list into
 * the structured ExtractorUsptoEvidence rows the prompt builder expects.
 */
export function buildUsptoEvidence(
  usptoCandidates: ReadonlyArray<RawOwnerCandidate>,
): ExtractorUsptoEvidence[] {
  const out: ExtractorUsptoEvidence[] = [];
  const seen = new Set<string>();
  for (const c of usptoCandidates) {
    if (c.candidate_source !== "uspto") continue;
    const ownerName = c.candidate_company_name?.trim();
    if (!ownerName) continue;
    const dedupeKey = `${ownerName.toLowerCase()}|${c.trademark_serial_number ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const payload =
      c.raw_payload && typeof c.raw_payload === "object"
        ? (c.raw_payload as Record<string, unknown>)
        : {};
    const trademarks = Array.isArray(payload.trademarks)
      ? (payload.trademarks as unknown[])
      : [];
    const tm = (trademarks[0] && typeof trademarks[0] === "object"
      ? trademarks[0]
      : payload) as Record<string, unknown>;

    const parties = tm.parties && typeof tm.parties === "object"
      ? (tm.parties as Record<string, unknown>)
      : {};
    const ownersArr = Array.isArray(parties.owners) ? (parties.owners as unknown[]) : [];
    const ownerObj =
      (ownersArr[0] && typeof ownersArr[0] === "object")
        ? (ownersArr[0] as Record<string, unknown>)
        : {};
    const entityType =
      typeof ownerObj.legalEntityType === "string"
        ? (ownerObj.legalEntityType as string)
        : typeof ownerObj.entityType === "string"
          ? (ownerObj.entityType as string)
          : null;
    const registrationNumber =
      typeof tm.registrationNumber === "string"
        ? (tm.registrationNumber as string)
        : typeof tm.registration_number === "string"
          ? (tm.registration_number as string)
          : null;
    const markText =
      typeof tm.markVerbalElement === "string"
        ? (tm.markVerbalElement as string)
        : typeof tm.mark_text === "string"
          ? (tm.mark_text as string)
          : null;

    out.push({
      owner_name: ownerName,
      entity_type: entityType,
      address: c.trademark_owner_address ?? null,
      registration_number: registrationNumber,
      serial_number: c.trademark_serial_number,
      mark_text: markText,
      goods_services: c.goods_services_text,
      evidence_url: c.evidence_url,
    });
  }
  return out;
}

/**
 * Phase 34 entry point. Phase 34.1 added the `usptoEvidence` and
 * `perQueryAnswers` parameters; both default to empty for backwards
 * compatibility with callers that haven't been updated yet.
 */
export async function extractOwnerCandidates(
  brandName: string,
  category: string | null,
  hits: ExtractorInputHit[],
  opts: ExtractorOptions = {},
  usptoEvidence: ReadonlyArray<ExtractorUsptoEvidence> = [],
  perQueryAnswers: ReadonlyArray<PerQueryAnswer> = [],
): Promise<ExtractorResult> {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? null;
  if (!apiKey) {
    return {
      candidates: [],
      raw: null,
      error: "missing OPENAI_API_KEY",
    };
  }
  if (
    hits.length === 0 &&
    usptoEvidence.length === 0 &&
    perQueryAnswers.length === 0
  ) {
    return { candidates: [], raw: null, error: null };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model ?? DEFAULT_MODEL;

  return rateLimit(
    {
      key: "openai-extractor",
      maxConcurrent: 2,
      minIntervalMs: 200,
      maxWaitMs: 60_000,
    },
    () =>
      extractImpl(
        brandName,
        category,
        hits,
        apiKey,
        fetchImpl,
        model,
        usptoEvidence,
        perQueryAnswers,
      ),
  );
}

async function extractImpl(
  brandName: string,
  category: string | null,
  hits: ExtractorInputHit[],
  apiKey: string,
  fetchImpl: typeof fetch,
  model: string,
  usptoEvidence: ReadonlyArray<ExtractorUsptoEvidence>,
  perQueryAnswers: ReadonlyArray<PerQueryAnswer>,
): Promise<ExtractorResult> {
  try {
    const userText = buildUserPrompt(
      brandName,
      category,
      usptoEvidence,
      perQueryAnswers,
      hits,
    );
    const body = {
      model,
      reasoning: { effort: "medium" },
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: SYSTEM_PROMPT }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: userText }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "owner_candidates",
          strict: true,
          schema: RESPONSE_SCHEMA,
        },
      },
    };

    const res = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    } as RequestInit);

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        // ignore
      }
      return {
        candidates: [],
        raw: null,
        error: `extractor ${res.status}${detail ? `: ${detail}` : ""}`,
      };
    }

    const json = (await res.json()) as unknown;
    const candidates = parseExtractorResponse(json);
    return { candidates, raw: json, error: null };
  } catch (e) {
    return {
      candidates: [],
      raw: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Walk the Responses API output to find the JSON payload, parse it, and
 * apply the confidence floor + top-K cap. Tolerant of variations in where
 * the JSON lands (output_text on a message, or output_parsed at root).
 */
export function parseExtractorResponse(json: unknown): ExtractedCandidate[] {
  const text = extractJsonText(json);
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const arr = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(arr)) return [];

  const out: ExtractedCandidate[] = [];
  const seenNames = new Set<string>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name =
      typeof o.canonical_company_name === "string"
        ? o.canonical_company_name.trim()
        : "";
    if (!name) continue;
    const conf = typeof o.confidence === "number" ? o.confidence : 0;
    if (conf < MIN_CONFIDENCE) continue;
    const key = name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);

    const domainRaw = typeof o.domain === "string" ? o.domain.trim() : "";
    const domain = domainRaw.length > 0 ? normalizeDomain(domainRaw) : null;
    const reasoning =
      typeof o.reasoning === "string" ? o.reasoning.trim() : "";
    const evidenceRaw = Array.isArray(o.evidence_urls)
      ? (o.evidence_urls as unknown[])
      : [];
    const evidence: string[] = [];
    for (const u of evidenceRaw) {
      if (typeof u === "string" && u.trim().length > 0) evidence.push(u.trim());
      if (evidence.length >= 5) break;
    }
    out.push({
      canonical_company_name: name,
      domain,
      confidence: Math.min(1, Math.max(0, conf)),
      reasoning,
      evidence_urls: evidence,
    });
  }
  out.sort((a, b) => b.confidence - a.confidence);
  return out.slice(0, MAX_CANDIDATES);
}

function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  try {
    if (/^https?:\/\//.test(s)) {
      s = new URL(s).hostname;
    }
  } catch {
    // not a URL — treat as host
  }
  s = s.replace(/^www\./, "").replace(/^m\./, "");
  if (!s || s.includes(" ")) return null;
  if (!s.includes(".")) return null;
  return s;
}

/**
 * Pull the JSON text from a Responses API payload. Modern responses put it
 * on `output[].content[].text` for message items; we also accept a top-level
 * `output_text` string (as the SDK sometimes synthesizes) for robustness.
 */
function extractJsonText(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;

  if (typeof root.output_text === "string" && root.output_text.length > 0) {
    return root.output_text;
  }

  const output = Array.isArray(root.output) ? (root.output as unknown[]) : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const type = typeof obj.type === "string" ? obj.type : "";
    if (type !== "message") continue;
    const content = Array.isArray(obj.content) ? (obj.content as unknown[]) : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      const text = typeof b.text === "string" ? (b.text as string) : null;
      if (text && text.trim().length > 0) return text;
    }
  }
  return null;
}
