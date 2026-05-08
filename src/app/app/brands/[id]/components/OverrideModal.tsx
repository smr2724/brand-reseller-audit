"use client";
/**
 * Phase 47 — Manual override modal for the qualification banner.
 *
 * Warn-and-allow policy: this does NOT change `icp_verdict`; it sets
 * `manual_override=true` so the user can proceed despite the verdict.
 * The disqualification banner stays visible with the override-active
 * variant.
 */
import { useState } from "react";

const MIN_LEN = 10;

export default function OverrideModal({
  brandId,
  onClose,
  onApplied,
}: {
  brandId: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (reason.trim().length < MIN_LEN) {
      setErr(`Reason must be at least ${MIN_LEN} characters.`);
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/brands/${brandId}/qualification/override`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: reason.trim() }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data?.error ?? `HTTP ${res.status}`);
        return;
      }
      onApplied();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-lg rounded-lg border border-[var(--border-soft)] bg-[var(--bg-surface)] p-5">
        <div className="text-base font-semibold mb-2">Override disqualification</div>
        <div className="text-sm text-[var(--text-muted)] mb-3">
          Provide a short reason for proceeding despite the disqualification verdict.
          The banner will remain visible with the override-active variant.
        </div>
        <textarea
          className="w-full rounded border border-[var(--border-soft)] bg-[var(--bg)] p-2 text-sm"
          rows={4}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Steve confirmed via call that the parent's distribution policy doesn't apply to this division."
        />
        {err && <div className="mt-2 text-sm text-red-400">{err}</div>}
        <div className="mt-4 flex gap-2 justify-end">
          <button
            className="btn btn-ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            className="btn"
            onClick={submit}
            disabled={submitting || reason.trim().length < MIN_LEN}
          >
            {submitting ? "Saving…" : "Apply override"}
          </button>
        </div>
      </div>
    </div>
  );
}
