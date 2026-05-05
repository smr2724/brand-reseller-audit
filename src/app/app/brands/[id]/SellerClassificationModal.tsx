"use client";
/**
 * Phase 39 — Required seller-classification modal that opens when the
 * user clicks "Generate Report" on the brand page.
 *
 * The user classifies every seller into one of four buckets:
 *  - brand_owned: the brand themselves (1P)
 *  - authorized:  official distributor / partner reseller
 *  - amazon:      Amazon retail itself (gates not_a_fit)
 *  - reseller:    unauthorized 3P reseller (default; recoverable)
 *
 * Only the reseller share counts toward recoverable revenue.
 * brand_owned + authorized + amazon are all excluded.
 *
 * On confirm: PATCH /api/brands/[id]/sellers/classifications, then POST
 * /api/reports/generate with the snapshot. The parent component handles
 * the post-confirm "report generating" state.
 */
import { useEffect, useMemo, useState } from "react";
import { formatNumber } from "@/lib/utils";

const AMAZON_SELLER_ID = "ATVPDKIKX0DER";

export type ClassificationBucket =
  | "brand_owned"
  | "authorized"
  | "amazon"
  | "reseller";

interface SellerRow {
  id: string;
  seller_name: string | null;
  seller_id: string | null;
  seller_country: string | null;
  share_pct: number | null;
  asins_won: number | null;
  is_fba: boolean | null;
  is_brand_controlled: boolean | null;
  classification_reason: string | null;
  classification: string | null;
  classified_at: string | null;
}

export interface ClassificationSnapshotEntry {
  seller_id: string | null;
  seller_name: string | null;
  share_pct: number | null;
  asins_won: number | null;
  is_fba: boolean | null;
  classification: ClassificationBucket;
}

const BUCKET_LABELS: Record<ClassificationBucket, string> = {
  brand_owned: "Brand-owned",
  authorized: "Authorized",
  amazon: "Amazon",
  reseller: "Reseller",
};

function defaultBucketFor(row: SellerRow): ClassificationBucket {
  // Amazon retail seller_id always wins — locked classification.
  if (row.seller_id === AMAZON_SELLER_ID) return "amazon";
  const name = (row.seller_name ?? "").toLowerCase().trim();
  if (name === "amazon.com" || name === "amazon") return "amazon";
  // Preserve a previously persisted non-default classification so the
  // user sees the prior decisions as the starting point and only has
  // to re-confirm.
  const existing = (row.classification ?? "").toLowerCase();
  if (
    existing === "brand_owned" ||
    existing === "authorized" ||
    existing === "amazon" ||
    existing === "reseller"
  ) {
    return existing as ClassificationBucket;
  }
  // Fall back to the legacy is_brand_controlled boolean only when no
  // 4-bucket classification exists yet (unmigrated row).
  if (row.is_brand_controlled === true) return "brand_owned";
  return "reseller";
}

function isAmazonLocked(row: SellerRow): boolean {
  if (row.seller_id === AMAZON_SELLER_ID) return true;
  const name = (row.seller_name ?? "").toLowerCase().trim();
  return name === "amazon.com" || name === "amazon";
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}

export interface SellerClassificationModalProps {
  brandId: string;
  brandName: string;
  trailing12mo: number | null;
  /** Called with the snapshot the parent should POST to
   *  /api/reports/generate. Modal does NOT call /generate itself —
   *  the parent owns the reports state machine. */
  onConfirm: (snapshot: ClassificationSnapshotEntry[]) => Promise<void> | void;
  onCancel: () => void;
  isSubmitting?: boolean;
}

export default function SellerClassificationModal({
  brandId,
  brandName,
  trailing12mo,
  onConfirm,
  onCancel,
  isSubmitting,
}: SellerClassificationModalProps) {
  const [rows, setRows] = useState<SellerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, ClassificationBucket>>({});

  useEffect(() => {
    let alive = true;
    setError(null);
    setRows(null);
    fetch(`/api/brands/${brandId}/sellers`, { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok) {
          setError(data?.error ?? `HTTP ${r.status}`);
          return;
        }
        const incoming: SellerRow[] = Array.isArray(data?.sellers) ? data.sellers : [];
        setRows(incoming);
        const initial: Record<string, ClassificationBucket> = {};
        for (const s of incoming) initial[s.id] = defaultBucketFor(s);
        setPicks(initial);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [brandId]);

  const totals = useMemo(() => {
    let brandOwned = 0;
    let authorized = 0;
    let amazon = 0;
    let reseller = 0;
    let totalShare = 0;
    for (const r of rows ?? []) {
      const share = typeof r.share_pct === "number" ? r.share_pct : 0;
      if (share <= 0) continue;
      totalShare += share;
      const bucket = picks[r.id] ?? "reseller";
      if (bucket === "brand_owned") brandOwned += share;
      else if (bucket === "authorized") authorized += share;
      else if (bucket === "amazon") amazon += share;
      else reseller += share;
    }
    const norm = (n: number) => (totalShare > 0 ? n / totalShare : 0);
    const resellerPct = norm(reseller);
    const recoverable =
      trailing12mo != null && Number.isFinite(trailing12mo)
        ? trailing12mo * resellerPct
        : null;
    return {
      brand_owned_pct: norm(brandOwned),
      authorized_pct: norm(authorized),
      amazon_pct: norm(amazon),
      reseller_pct: resellerPct,
      non_reseller_pct: norm(brandOwned + authorized + amazon),
      recoverable,
    };
  }, [rows, picks, trailing12mo]);

  const showWarning = totals.non_reseller_pct >= 0.5;

  function setPick(rowId: string, bucket: ClassificationBucket) {
    setPicks((prev) => ({ ...prev, [rowId]: bucket }));
  }

  async function confirm() {
    if (!rows) return;
    const snapshot: ClassificationSnapshotEntry[] = rows.map((r) => ({
      seller_id: r.seller_id ?? null,
      seller_name: r.seller_name ?? null,
      share_pct: typeof r.share_pct === "number" ? r.share_pct : null,
      asins_won: typeof r.asins_won === "number" ? r.asins_won : null,
      is_fba: typeof r.is_fba === "boolean" ? r.is_fba : null,
      classification: picks[r.id] ?? "reseller",
    }));
    await onConfirm(snapshot);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.65)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) onCancel();
      }}
    >
      <div
        className="card w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col"
        style={{ background: "var(--bg)", border: "1px solid var(--border-soft)" }}
      >
        <div className="px-5 py-4 border-b border-[var(--border-soft)] flex items-baseline justify-between">
          <div>
            <div className="text-sm uppercase tracking-wide text-[var(--text-muted)]">
              Classify sellers before generating report
            </div>
            <div className="text-base font-semibold mt-1">{brandName}</div>
          </div>
          <button
            className="btn btn-ghost text-xs"
            onClick={onCancel}
            disabled={!!isSubmitting}
          >
            Cancel
          </button>
        </div>

        <div className="px-5 py-3 border-b border-[var(--border-soft)] text-xs text-[var(--text-muted)]">
          Only <strong>Reseller</strong> share counts toward recoverable revenue.
          Brand-owned + Authorized + Amazon are all excluded. Defaults reflect
          the heuristic; verify each row before confirming.
        </div>

        {error && (
          <div className="px-5 py-3 text-sm" style={{ color: "#f87171" }}>
            Failed to load sellers: {error}
          </div>
        )}

        {showWarning && (
          <div
            className="mx-5 my-3 p-3 rounded border text-sm"
            style={{
              background: "#2a2410",
              borderColor: "#4a3e1e",
              color: "#facc15",
            }}
          >
            Brand-owned + Authorized + Amazon sellers control{" "}
            <strong>{fmtPct(totals.non_reseller_pct)}</strong> of sales (≥50%).
            There may be limited recoverable revenue for this brand. The report
            will reflect this.
          </div>
        )}

        <div className="flex-1 overflow-auto px-5 py-3">
          {rows == null && !error ? (
            <div className="text-sm text-[var(--text-muted)]">Loading sellers…</div>
          ) : rows && rows.length === 0 ? (
            <div className="text-sm text-[var(--text-muted)]">
              No sellers found for this brand. Run a Keepa scan first, then
              regenerate.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <tr>
                  <th className="text-left py-2 pr-3">Seller</th>
                  <th className="text-right py-2 pr-3">Share</th>
                  <th className="text-right py-2 pr-3">ASINs</th>
                  <th className="text-center py-2 pr-3">FBA</th>
                  <th className="text-center py-2 pr-3">Country</th>
                  <th className="text-left py-2 pr-3">Classification</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((r) => {
                  const locked = isAmazonLocked(r);
                  const bucket = picks[r.id] ?? "reseller";
                  return (
                    <tr key={r.id} className="border-t border-[var(--border-soft)]">
                      <td className="py-2 pr-3">
                        <div className="font-medium">
                          {r.seller_name ?? "—"}
                        </div>
                        {r.classification_reason && (
                          <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                            {r.classification_reason}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {fmtPct(r.share_pct)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatNumber(r.asins_won)}
                      </td>
                      <td className="py-2 pr-3 text-center">
                        {r.is_fba === true ? "✓" : r.is_fba === false ? "—" : ""}
                      </td>
                      <td className="py-2 pr-3 text-center">
                        {r.seller_country ?? ""}
                      </td>
                      <td className="py-2 pr-3">
                        <select
                          className="bg-[var(--bg)] border border-[var(--border-soft)] rounded px-2 py-1 text-sm"
                          value={bucket}
                          disabled={locked || !!isSubmitting}
                          onChange={(e) =>
                            setPick(r.id, e.target.value as ClassificationBucket)
                          }
                        >
                          <option value="brand_owned">Brand-owned</option>
                          <option value="authorized">Authorized</option>
                          <option value="amazon">Amazon</option>
                          <option value="reseller">Reseller</option>
                        </select>
                        {locked && (
                          <span className="ml-2 text-[11px] text-[var(--text-muted)]">
                            locked
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div
          className="px-5 py-3 border-t border-[var(--border-soft)] text-xs"
          style={{ background: "var(--bg-soft, transparent)" }}
        >
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span>
              <span className="text-[var(--text-muted)]">Brand-owned:</span>{" "}
              <strong>{fmtPct(totals.brand_owned_pct)}</strong>
            </span>
            <span>
              <span className="text-[var(--text-muted)]">Authorized:</span>{" "}
              <strong>{fmtPct(totals.authorized_pct)}</strong>
            </span>
            <span>
              <span className="text-[var(--text-muted)]">Amazon:</span>{" "}
              <strong>{fmtPct(totals.amazon_pct)}</strong>
            </span>
            <span>
              <span className="text-[var(--text-muted)]">Reseller:</span>{" "}
              <strong>{fmtPct(totals.reseller_pct)}</strong>
            </span>
            <span>
              <span className="text-[var(--text-muted)]">
                Recoverable revenue (resellers only):
              </span>{" "}
              <strong>{fmtMoney(totals.recoverable)}</strong>
              {trailing12mo == null && (
                <span className="ml-1 text-[var(--text-muted)]">
                  (TTM not measured)
                </span>
              )}
            </span>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-[var(--border-soft)] flex items-center justify-end gap-2">
          <button
            className="btn btn-ghost"
            onClick={onCancel}
            disabled={!!isSubmitting}
          >
            Cancel
          </button>
          <button
            className="btn"
            onClick={confirm}
            disabled={!rows || rows.length === 0 || !!isSubmitting}
          >
            {isSubmitting ? "Generating…" : "Confirm & Generate Report"}
          </button>
        </div>
      </div>
    </div>
  );
}
