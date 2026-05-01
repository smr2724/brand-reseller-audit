"use client";
import { useState } from "react";
import { formatNumber, formatMoney } from "@/lib/utils";
import { ExternalLink } from "lucide-react";

export default function ProductsTable({ products }: { products: any[] }) {
  const [open, setOpen] = useState<any | null>(null);

  return (
    <>
      <div className="overflow-x-auto -mx-3 md:mx-0">
        <table className="data-table min-w-[700px]">
          <thead>
            <tr>
              <th>#</th>
              <th>Product</th>
              <th>Brand</th>
              <th className="numeric">Price</th>
              <th className="numeric">Rating</th>
              <th className="numeric">Reviews</th>
              <th>Weakness</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {products.slice(0, 20).map(p => (
              <tr key={p.id ?? p.asin} onClick={() => setOpen(p)} style={{ cursor: "pointer" }}>
                <td className="numeric">{p.position ?? "—"}{p.is_sponsored ? <span className="ml-1 text-[10px] text-[var(--text-muted)]">(SP)</span> : null}</td>
                <td>
                  <div className="font-medium line-clamp-1 max-w-[360px]" title={p.title}>{p.title ?? "—"}</div>
                  <div className="text-[11px] text-[var(--text-muted)] mt-0.5">ASIN {p.asin ?? "—"}</div>
                </td>
                <td className="text-xs text-[var(--text-muted)]">{p.brand ?? "—"}</td>
                <td className="numeric">{formatMoney(p.price)}</td>
                <td className="numeric">{p.rating != null ? Number(p.rating).toFixed(2) : "—"}</td>
                <td className="numeric">{formatNumber(p.review_count)}</td>
                <td className="text-xs text-[var(--orange)]">{p.weakness_notes}</td>
                <td>
                  {p.product_url && (
                    <a href={p.product_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="text-[var(--text-muted)] hover:text-[var(--text)]">
                      <ExternalLink size={14} />
                    </a>
                  )}
                </td>
              </tr>
            ))}
            {!products.length && <tr><td colSpan={8} className="text-center py-5 text-[var(--text-muted)]">No products in SERP.</td></tr>}
          </tbody>
        </table>
      </div>

      {open && (
        <div className="fixed inset-0 z-40 flex items-end md:items-center justify-center p-0 md:p-5 bg-black/60" onClick={() => setOpen(null)}>
          <div className="card w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-4 md:p-5 border-b border-[var(--border-soft)] flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold">{open.title}</div>
                <div className="text-xs text-[var(--text-muted)] mt-1">ASIN {open.asin} · Brand {open.brand ?? "—"}</div>
              </div>
              <button onClick={() => setOpen(null)} className="btn btn-ghost">✕</button>
            </div>
            <div className="p-4 md:p-5 space-y-3 text-sm">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Stat label="Price" value={formatMoney(open.price)} />
                <Stat label="Rating" value={open.rating != null ? Number(open.rating).toFixed(2) : "—"} />
                <Stat label="Reviews" value={formatNumber(open.review_count)} />
                <Stat label="BSR" value={formatNumber(open.bsr)} />
              </div>
              <div><span className="label">Listing quality</span> {open.listing_quality_score ?? "—"} / 5</div>
              <div><span className="label">Weakness notes</span> {open.weakness_notes ?? "—"}</div>
              {open.category && <div><span className="label">Keepa category</span> <span className="text-xs">{open.category}</span></div>}
              {open.product_url && (
                <a className="btn mt-2" href={open.product_url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open on Amazon</a>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: any }) {
  return (
    <div className="card-soft p-2.5">
      <div className="text-[11px] text-[var(--text-muted)] uppercase tracking-wide">{label}</div>
      <div className="font-semibold mt-0.5">{value}</div>
    </div>
  );
}
