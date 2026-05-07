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
import { useEffect, useState } from "react";
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
  disqualification_pattern: string | null;
  candidate_hooks: Hook[] | null;
  manual_override: boolean;
  manual_override_reason: string | null;
  manual_override_at: string | null;
  state: string;
  error_message: string | null;
}

interface ApiResp {
  qualification_state: string;
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
            Running qualification… (LLM + USPTO + OpenCorporates)
          </div>
        </div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="card p-4 mb-4 border-red-700">
        <div className="text-sm font-medium text-red-300">Qualification error</div>
        <div className="text-xs text-[var(--text-muted)]">
          {row?.error_message ?? "Run failed."}
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
          {row.icp_reasoning && (
            <div className="text-sm mt-2 max-w-3xl">{row.icp_reasoning}</div>
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
