"use client";
/**
 * Phase 47 — Section A on /app/brands/[id]: the Qualification Review.
 *
 * Top of page, above the seller-classification table. Shows the verdict
 * pill, an identity card, the candidate-hooks list with copy buttons,
 * and a re-run button. When verdict is `disqualified`, a sticky banner
 * exposes "Override and proceed" → opens OverrideModal.
 *
 * Live state: polls `/api/brands/[id]/qualification` while
 * qualification_state='running' so the user sees the verdict land
 * without a manual refresh.
 */
import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import OverrideModal from "./OverrideModal";

type Verdict = "qualified" | "disqualified" | "needs_review";

interface Hook {
  hook_code: string;
  hook_text: string;
  evidence: string;
  confidence: number;
}

interface SelectedEntity {
  name?: string;
  type?: string;
  country?: string;
  evidence_url?: string;
  evidence_summary?: string;
  confidence?: number;
}

// Phase 50 — upgraded narrative output.
type AssociationType =
  | "brand_owned"
  | "parent_owned"
  | "affiliate"
  | "licensed_distributor";

interface BrandAssociatedSeller {
  seller_name: string;
  association_type: AssociationType;
  evidence: string;
}

interface FalsePositiveFlag {
  flag: string;
  explanation: string;
}

// Phase 57 — Pitch Math is now computed server-side from canonical
// economics functions. The LLM no longer touches this field; the shape
// here is the new canonical projection (100% recapture).
interface PitchMath {
  ttm_revenue_usd: number;
  reseller_controlled_share: number;
  reseller_controlled_revenue_usd: number;
  recoverable_revenue_usd: number;
  current_profit_margin: number;
  post_capture_profit_margin: number;
  current_annual_profit_usd: number;
  post_capture_annual_profit_usd: number;
  delta_profit_usd: number;
  exit_lift_usd: number;
  source: "computeLegionEconomics" | "computeBenchmarkEconomics";
}

interface QualificationRow {
  id: string;
  brand_id: string;
  selected_entity: SelectedEntity | null;
  legal_entity_name: string | null;
  legal_entity_type: string | null;
  legal_entity_country: string | null;
  ownership_signal: string | null;
  trademark_serial: string | null;
  trademark_status: string | null;
  icp_verdict: Verdict;
  icp_reasoning: string;
  icp_reconciliation_note: string | null;
  disqualification_pattern: string | null;
  candidate_hooks: Hook[] | null;
  // Phase 50 — narrative bundle (nullable on legacy rows).
  narrative_markdown: string | null;
  brand_associated_sellers: BrandAssociatedSeller[] | null;
  false_positive_flags: FalsePositiveFlag[] | null;
  channel_pattern: string | null;
  pitch_math: PitchMath | null;
  manual_override: boolean;
  manual_override_reason: string | null;
  manual_override_at: string | null;
  state: string;
  error_message: string | null;
}

interface ApiResp {
  qualification_state: string;
  // Phase 67 — Postgres-level error message captured by the orchestrator
  // when an upsert or unexpected throw blocked the qualification run.
  // Surfaced verbatim in the error panel so failures like CHECK violations
  // are no longer hidden behind the generic "Run failed." string.
  qualification_error: string | null;
  qualification: QualificationRow | null;
}

export default function QualificationReview({
  brandId,
  initialState,
}: {
  brandId: string;
  initialState: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<string>(initialState);
  const [row, setRow] = useState<QualificationRow | null>(null);
  const [qualificationError, setQualificationError] = useState<string | null>(
    null,
  );
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showOverride, setShowOverride] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  async function fetchRow() {
    try {
      const res = await fetch(`/api/brands/${brandId}/qualification`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as ApiResp;
      setState(data.qualification_state ?? "pending");
      setRow(data.qualification ?? null);
      setQualificationError(data.qualification_error ?? null);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    fetchRow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId]);

  // Poll while running.
  useEffect(() => {
    if (state !== "running") return;
    const id = setInterval(fetchRow, 4000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, brandId]);

  async function runQualify(force: boolean) {
    setRunning(true);
    setErr(null);
    try {
      const res = await fetch(`/api/brands/${brandId}/qualify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data?.error ?? `HTTP ${res.status}`);
      } else {
        await fetchRow();
        router.refresh();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  // Pre-run state — pending/no row yet.
  if (state === "pending" && !row) {
    return (
      <div className="card p-4 mb-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">Brand Qualification</div>
            <div className="text-xs text-[var(--text-muted)]">
              Run the LLM disambiguation + ICP screen + hook ranking before classification.
            </div>
          </div>
          <button
            className="btn"
            onClick={() => runQualify(false)}
            disabled={running}
          >
            {running ? "Running…" : "Run qualification"}
          </button>
        </div>
        {err && <div className="text-sm text-red-400 mt-2">{err}</div>}
      </div>
    );
  }

  if (state === "running") {
    return (
      <div className="card p-4 mb-4">
        <div className="flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
          <div className="text-sm font-medium">
            Running qualification… (LLM + USPTO)
          </div>
        </div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="card p-4 mb-4 border-red-700">
        <div className="text-sm font-medium text-red-300">Qualification error</div>
        <div className="text-xs text-[var(--text-muted)] whitespace-pre-wrap break-words">
          {/* Phase 67 — prefer the Postgres message captured on
              brands.qualification_error; fall back to the row-level
              error_message, then the generic "Run failed." sentinel. */}
          {qualificationError ?? row?.error_message ?? "Run failed."}
        </div>
        <button
          className="btn btn-ghost text-xs mt-2"
          onClick={() => runQualify(true)}
          disabled={running}
        >
          {running ? "Retrying…" : "Retry"}
        </button>
      </div>
    );
  }

  if (!row) return null;

  const verdict = row.icp_verdict;
  const verdictLabel =
    verdict === "qualified"
      ? "QUALIFIED"
      : verdict === "needs_review"
        ? "NEEDS REVIEW"
        : "DISQUALIFIED";
  const pillBg =
    verdict === "qualified"
      ? "bg-green-600/30 border-green-600/60 text-green-200"
      : verdict === "needs_review"
        ? "bg-amber-600/30 border-amber-600/60 text-amber-200"
        : "bg-red-700/30 border-red-700/60 text-red-200";

  const hooks = Array.isArray(row.candidate_hooks) ? row.candidate_hooks : [];
  const showOverrideBanner =
    (verdict === "disqualified" && !row.manual_override) || row.manual_override;

  function copy(key: string, text: string) {
    if (navigator?.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
      });
    }
  }

  return (
    <div className="card p-4 mb-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
            Brand Qualification
          </div>
          <div className="mt-2 flex items-center gap-3">
            <span
              className={`inline-block px-3 py-1 rounded-full text-xs font-semibold border ${pillBg}`}
            >
              {verdictLabel}
            </span>
            {row.disqualification_pattern && (
              <span className="text-xs text-[var(--text-muted)]">
                pattern: {row.disqualification_pattern}
              </span>
            )}
          </div>
          {row.narrative_markdown ? (
            <div className="mt-3 max-w-3xl">
              <NarrativeMarkdown source={row.narrative_markdown} />
            </div>
          ) : (
            row.icp_reasoning && (
              <>
                <div className="text-sm mt-2 max-w-3xl">{row.icp_reasoning}</div>
                <div className="text-xs text-[var(--text-muted)] mt-2 italic">
                  Legacy qualification — re-qualify for upgraded analysis.
                </div>
              </>
            )
          )}
        </div>
        <div className="shrink-0 flex flex-col gap-1 items-end">
          <button
            className="btn btn-ghost text-xs"
            onClick={() => runQualify(true)}
            disabled={running}
            title="Re-run disambiguation + ICP + hooks"
          >
            {running ? "Re-qualifying…" : "Re-qualify"}
          </button>
          {err && <div className="text-xs text-red-400">{err}</div>}
        </div>
      </div>

      {row.icp_reconciliation_note && (
        <div className="mb-3 p-3 rounded border border-amber-700 bg-amber-900/20 text-sm text-amber-200">
          <strong>Verdict reconciliation:</strong> {row.icp_reconciliation_note}
        </div>
      )}

      {showOverrideBanner && (
        <div
          className={`mb-3 p-3 rounded border text-sm ${
            row.manual_override
              ? "border-amber-700 bg-amber-900/30 text-amber-200"
              : "border-red-700 bg-red-900/30 text-red-200"
          }`}
        >
          {row.manual_override ? (
            <>
              <strong>Override active:</strong>{" "}
              {row.manual_override_reason || "(no reason recorded)"} — verdict was{" "}
              {verdictLabel}.
            </>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div>
                <strong>Not a fit:</strong>{" "}
                {row.disqualification_pattern ?? "see reasoning above"}. You can
                still generate a report below.
              </div>
              <button
                className="btn btn-ghost text-xs"
                onClick={() => setShowOverride(true)}
              >
                Override and proceed
              </button>
            </div>
          )}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-3 mb-3">
        <div className="rounded border border-[var(--border-soft)] p-3">
          <div className="text-xs uppercase text-[var(--text-muted)] mb-1">
            Identity
          </div>
          <div className="text-sm">
            <div>
              <strong>{row.legal_entity_name ?? row.selected_entity?.name ?? "—"}</strong>
            </div>
            <div className="text-xs text-[var(--text-muted)]">
              {row.legal_entity_type ?? "unknown"} ·{" "}
              {row.legal_entity_country ?? "??"} · ownership:{" "}
              {row.ownership_signal ?? "unknown"}
            </div>
            {row.trademark_serial && (
              <div className="text-xs mt-1">
                Trademark{" "}
                <a
                  className="underline"
                  href={`https://tsdr.uspto.gov/#caseNumber=${encodeURIComponent(row.trademark_serial)}&caseType=DEFAULT&searchType=statusSearch`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {row.trademark_serial}
                </a>
                {row.trademark_status ? ` · ${row.trademark_status}` : ""}
              </div>
            )}
            {row.selected_entity?.evidence_url && (
              <div className="text-xs mt-1">
                <a
                  className="underline"
                  href={row.selected_entity.evidence_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Top evidence
                </a>
              </div>
            )}
          </div>
        </div>

        <div className="rounded border border-[var(--border-soft)] p-3">
          <div className="text-xs uppercase text-[var(--text-muted)] mb-1">
            Hooks ({hooks.length})
          </div>
          {hooks.length === 0 ? (
            <div className="text-xs text-[var(--text-muted)]">
              No hooks generated.
            </div>
          ) : (
            <ul className="space-y-2">
              {hooks.map((h, i) => {
                const key = `${h.hook_code}-${i}`;
                const conf = Math.round(Math.max(0, Math.min(1, h.confidence)) * 100);
                return (
                  <li key={key} className="text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-xs uppercase text-[var(--text-muted)]">
                          {h.hook_code} · {conf}%
                        </div>
                        <div>{h.hook_text}</div>
                        {h.evidence && (
                          <div className="text-xs text-[var(--text-muted)] mt-0.5">
                            {h.evidence}
                          </div>
                        )}
                      </div>
                      <button
                        className="btn btn-ghost text-xs"
                        onClick={() =>
                          copy(key, `${h.hook_text}\n\n${h.evidence}`)
                        }
                      >
                        {copiedKey === key ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <BrandAssociatedSellersCard sellers={row.brand_associated_sellers} />
      <FalsePositiveFlagsCard flags={row.false_positive_flags} />
      {verdict === "qualified" && row.pitch_math && (
        <PitchMathCard math={row.pitch_math} />
      )}

      {showOverride && (
        <OverrideModal
          brandId={brandId}
          onClose={() => setShowOverride(false)}
          onApplied={async () => {
            setShowOverride(false);
            await fetchRow();
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

// ---- Phase 50 — narrative + side-cards ---------------------------------

/**
 * Minimal markdown renderer. Avoids pulling in `react-markdown` for this
 * one feature. Handles the subset of markdown the LLM is instructed to
 * emit: ## headings, **bold**, `inline code`, numbered lists, paragraph
 * breaks. Anything fancier degrades to plain text — safe by default.
 */
function NarrativeMarkdown({ source }: { source: string }) {
  const blocks = parseMarkdownBlocks(source);
  return (
    <div className="text-sm leading-relaxed space-y-3 text-[var(--text)]">
      {blocks.map((b, i) => {
        if (b.type === "h2") {
          return (
            <h3
              key={i}
              className="text-base font-semibold mt-4 mb-1 text-[var(--text)]"
            >
              {renderInline(b.text)}
            </h3>
          );
        }
        if (b.type === "h3") {
          return (
            <h4
              key={i}
              className="text-sm font-semibold mt-3 mb-1 text-[var(--text)]"
            >
              {renderInline(b.text)}
            </h4>
          );
        }
        if (b.type === "ol") {
          return (
            <ol key={i} className="list-decimal pl-6 space-y-1">
              {b.items.map((it, j) => (
                <li key={j}>{renderInline(it)}</li>
              ))}
            </ol>
          );
        }
        if (b.type === "ul") {
          return (
            <ul key={i} className="list-disc pl-6 space-y-1">
              {b.items.map((it, j) => (
                <li key={j}>{renderInline(it)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            {renderInline(b.text)}
          </p>
        );
      })}
    </div>
  );
}

type MdBlock =
  | { type: "h2"; text: string }
  | { type: "h3"; text: string }
  | { type: "p"; text: string }
  | { type: "ol"; items: string[] }
  | { type: "ul"; items: string[] };

function parseMarkdownBlocks(source: string): MdBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (line.startsWith("### ")) {
      blocks.push({ type: "h3", text: line.slice(4).trim() });
      i += 1;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ type: "h2", text: line.slice(3).trim() });
      i += 1;
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push({ type: "h2", text: line.slice(2).trim() });
      i += 1;
      continue;
    }
    const olMatch = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (olMatch) {
      const items: string[] = [olMatch[1]];
      i += 1;
      while (i < lines.length) {
        const m = /^\s*\d+\.\s+(.*)$/.exec(lines[i]);
        if (m) {
          items.push(m[1]);
          i += 1;
          continue;
        }
        // Continuation line (indented or non-empty without list marker) folds in.
        if (
          lines[i].trim() &&
          (lines[i].startsWith("   ") || lines[i].startsWith("\t"))
        ) {
          items[items.length - 1] += " " + lines[i].trim();
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: "ol", items });
      continue;
    }
    const ulMatch = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ulMatch) {
      const items: string[] = [ulMatch[1]];
      i += 1;
      while (i < lines.length) {
        const m = /^\s*[-*]\s+(.*)$/.exec(lines[i]);
        if (m) {
          items.push(m[1]);
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    // Paragraph: consume until blank line.
    const para: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: "p", text: para.join("\n") });
  }
  return blocks;
}

function isBlockStart(line: string): boolean {
  if (line.startsWith("# ") || line.startsWith("## ") || line.startsWith("### ")) {
    return true;
  }
  if (/^\s*\d+\.\s+/.test(line)) return true;
  if (/^\s*[-*]\s+/.test(line)) return true;
  return false;
}

function renderInline(text: string): React.ReactNode {
  // Order matters: code spans first (so ** inside backticks is preserved),
  // then bold, then italic.
  const parts: Array<{ kind: "text" | "code" | "bold" | "italic"; value: string }> = [
    { kind: "text", value: text },
  ];
  // Pass 1: split out `code`.
  const afterCode: typeof parts = [];
  for (const p of parts) {
    if (p.kind !== "text") {
      afterCode.push(p);
      continue;
    }
    const re = /`([^`]+)`/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p.value))) {
      if (m.index > last) {
        afterCode.push({ kind: "text", value: p.value.slice(last, m.index) });
      }
      afterCode.push({ kind: "code", value: m[1] });
      last = m.index + m[0].length;
    }
    if (last < p.value.length) {
      afterCode.push({ kind: "text", value: p.value.slice(last) });
    }
  }
  // Pass 2: split out **bold**.
  const afterBold: typeof parts = [];
  for (const p of afterCode) {
    if (p.kind !== "text") {
      afterBold.push(p);
      continue;
    }
    const re = /\*\*([^*]+)\*\*/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p.value))) {
      if (m.index > last) {
        afterBold.push({ kind: "text", value: p.value.slice(last, m.index) });
      }
      afterBold.push({ kind: "bold", value: m[1] });
      last = m.index + m[0].length;
    }
    if (last < p.value.length) {
      afterBold.push({ kind: "text", value: p.value.slice(last) });
    }
  }
  return afterBold.map((p, i) => {
    if (p.kind === "code") {
      return (
        <code
          key={i}
          className="px-1 py-0.5 rounded bg-[var(--surface-2,rgba(255,255,255,0.06))] text-[0.85em]"
        >
          {p.value}
        </code>
      );
    }
    if (p.kind === "bold") {
      return (
        <strong key={i} className="font-semibold">
          {p.value}
        </strong>
      );
    }
    return <span key={i}>{p.value}</span>;
  });
}

function BrandAssociatedSellersCard({
  sellers,
}: {
  sellers: BrandAssociatedSeller[] | null;
}) {
  // Show an empty-state explanation only when the field is a present-but-empty
  // array (i.e. Phase 50 did run and found nothing). Null = legacy row, hide.
  if (!Array.isArray(sellers)) return null;
  return (
    <div className="rounded border border-[var(--border-soft)] p-3 mb-3">
      <div className="text-xs uppercase text-[var(--text-muted)] mb-2">
        Brand-associated sellers
      </div>
      {sellers.length === 0 ? (
        <div className="text-xs text-[var(--text-muted)]">
          No brand-associated sellers detected — all Amazon sellers appear to be
          third-party resellers.
        </div>
      ) : (
        <ul className="space-y-2">
          {sellers.map((s, i) => (
            <li key={i} className="text-sm">
              <div className="flex items-center gap-2 flex-wrap">
                <strong>{s.seller_name}</strong>
                <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-blue-700/20 border-blue-600/50 text-blue-200 uppercase tracking-wide">
                  {s.association_type.replace(/_/g, "-")}
                </span>
              </div>
              {s.evidence && (
                <div className="text-xs text-[var(--text-muted)] mt-0.5">
                  {s.evidence}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FalsePositiveFlagsCard({
  flags,
}: {
  flags: FalsePositiveFlag[] | null;
}) {
  if (!Array.isArray(flags) || flags.length === 0) return null;
  return (
    <div className="rounded border border-amber-700/60 bg-amber-900/20 p-3 mb-3">
      <div className="text-xs uppercase text-amber-300 mb-2">
        False positive flags
      </div>
      <ul className="space-y-2">
        {flags.map((f, i) => (
          <li key={i} className="text-sm text-amber-100">
            <div className="font-semibold">{f.flag}</div>
            <div className="text-xs text-amber-200/80 mt-0.5">{f.explanation}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Phase 57 — Pitch Math card, 100% recapture framing. The card mirrors
 * the canonical server-computed `pitch_math` object. Tight-mode brands
 * (Segment 2 → `computeBenchmarkEconomics`) get a soft framing line so
 * the reader knows the math reflects "if the authorized network were
 * transitioned and the brand controlled 100% of sales."
 */
function PitchMathCard({ math }: { math: PitchMath }) {
  const fmtUsd = (v: number) =>
    !Number.isFinite(v) ? "—" : `$${Math.round(v).toLocaleString("en-US")}`;
  const fmtPctFromFrac = (v: number) =>
    !Number.isFinite(v) ? "—" : `${Math.round(v * 100)}%`;
  const fmtMarginPct = (v: number) =>
    !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`;
  const isTight = math.source === "computeBenchmarkEconomics";
  const recapShareLabel = isTight
    ? "Currently controlled by authorized resellers"
    : "Currently controlled by resellers";
  const currentProfitLabel = isTight
    ? "Current profit (authorized-network state)"
    : "Current profit (reseller-controlled)";
  const postProfitLabel = isTight
    ? "Post-transition profit (brand-controlled)"
    : "Post-Phase-1 profit (brand-controlled)";

  return (
    <div className="rounded border border-green-700/60 bg-green-900/15 p-4 mb-3">
      <div className="text-xs uppercase text-green-300 mb-3">Pitch math</div>

      <div className="space-y-1 text-sm">
        <Row label="TTM Amazon revenue" value={fmtUsd(math.ttm_revenue_usd)} />
        <Row
          label={recapShareLabel}
          value={fmtPctFromFrac(math.reseller_controlled_share)}
        />
      </div>

      <div className="my-3 border-t border-green-700/40" />

      <div className="space-y-1 text-sm">
        <Row label="RCG Phase 1 recapture" value="100%" />
        <Row label="Recoverable revenue" value={fmtUsd(math.recoverable_revenue_usd)} />
      </div>

      <div className="my-3 border-t border-green-700/40" />

      <div className="space-y-1 text-sm">
        <Row
          label={currentProfitLabel}
          value={fmtUsd(math.current_annual_profit_usd)}
          sub={`($${Math.round(math.ttm_revenue_usd).toLocaleString("en-US")} × ${fmtMarginPct(math.current_profit_margin)})`}
        />
        <Row
          label={postProfitLabel}
          value={fmtUsd(math.post_capture_annual_profit_usd)}
          sub={`($${Math.round(math.ttm_revenue_usd).toLocaleString("en-US")} × ${fmtMarginPct(math.post_capture_profit_margin)})`}
        />
      </div>

      <div className="my-3 border-t border-green-700/40" />

      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-green-300/80 uppercase">
            Δ profit (the &quot;doubled&quot; number)
          </div>
          <div className="text-2xl font-semibold text-green-100">
            {fmtUsd(math.delta_profit_usd)}
            <span className="text-xs font-normal text-green-200/70">/year</span>
          </div>
        </div>
        <div>
          <div className="text-xs text-green-300/80 uppercase">
            Exit lift @ 7× EBITDA
          </div>
          <div className="text-2xl font-semibold text-green-100">
            {fmtUsd(math.exit_lift_usd)}
          </div>
        </div>
      </div>

      {isTight && (
        <div className="mt-3 text-xs text-green-200/70 italic">
          Math reflects the brand controlling 100% of sales after authorized
          resellers transition. Phase 2 still requires direct brand control of
          the channel.
        </div>
      )}

      <div className="mt-3 text-[10px] text-[var(--text-muted)] tracking-wide uppercase">
        Source: {math.source} (canonical)
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="text-[var(--text-muted)]">
        {label}
        {sub && (
          <span className="ml-2 text-xs text-[var(--text-muted)] opacity-70">
            {sub}
          </span>
        )}
      </div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  );
}
