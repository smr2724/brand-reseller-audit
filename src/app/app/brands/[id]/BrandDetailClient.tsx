"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatNumber, formatMoney } from "@/lib/utils";

interface Brand {
  id: string;
  name: string;
  category: string | null;
  status: string;
  brand_score: number | null;
  est_monthly_revenue: number | null;
  trailing_12_months: number | null;
  avg_sellers: number | null;
  avg_fba_sellers: number | null;
  dominant_seller_sales_pct: number | null;
  dominant_seller_country: string | null;
  dominant_seller_name: string | null;
  has_storefront: boolean | null;
  total_products: number | null;
  monthly_growth_pct: number | null;
  trailing_12_growth_pct: number | null;
  manual_notes: string | null;
  outreach_activity: string | null;
  current_profit: number | null;
  resellers_margin: number | null;
  recouped_shipping: number | null;
  labor_cost: number | null;
  additional_profit: number | null;
  rcg_fees: number | null;
  new_profit: number | null;
  seven_x_multiple_value: number | null;
  disqualifier_tags: string[];
}

const STATUSES = ["new", "qualified", "disqualified", "contacted", "client"];

export default function BrandDetailClient({ brand }: { brand: Brand }) {
  const router = useRouter();
  const [status, setStatus] = useState(brand.status);
  const [notes, setNotes] = useState(brand.manual_notes ?? "");
  const [tags, setTags] = useState<string[]>(brand.disqualifier_tags ?? []);
  const [newTag, setNewTag] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function patch(payload: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await fetch(`/api/brands/${brand.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) setMsg(`Save failed: ${data.error ?? "unknown"}`);
      else setMsg("Saved");
      router.refresh();
    } catch (e) {
      setMsg(`Save error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(null), 4000);
    }
  }

  async function deleteBrand() {
    if (!confirm(`Delete ${brand.name}? This cannot be undone.`)) return;
    const res = await fetch(`/api/brands/${brand.id}`, { method: "DELETE" });
    if (res.ok) router.push("/app/brands");
  }

  function addTag() {
    const t = newTag.trim().toLowerCase().replace(/\s+/g, "_");
    if (!t) return;
    if (tags.includes(t)) { setNewTag(""); return; }
    const next = [...tags, t];
    setTags(next);
    setNewTag("");
    patch({ disqualifier_tags: next });
  }

  function removeTag(tag: string) {
    const next = tags.filter((t) => t !== tag);
    setTags(next);
    patch({ disqualifier_tags: next });
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">{brand.name}</h1>
          <div className="text-sm text-[var(--text-muted)] mt-1">{brand.category ?? "—"}</div>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="select w-auto"
            value={status}
            onChange={(e) => { setStatus(e.target.value); patch({ status: e.target.value }); }}
          >
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button className="btn btn-danger" onClick={deleteBrand} disabled={saving}>Delete</button>
        </div>
      </div>

      {msg && <div className="card-soft p-2 text-sm mb-4">{msg}</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="SmartScout signals">
          <Field label="Brand Score" v={formatNumber(brand.brand_score, { decimals: 2 })} />
          <Field label="Est Monthly Revenue" v={formatMoney(brand.est_monthly_revenue)} />
          <Field label="Trailing 12 Months" v={formatMoney(brand.trailing_12_months)} />
          <Field label="Avg Sellers" v={formatNumber(brand.avg_sellers, { decimals: 1 })} />
          <Field label="Avg FBA Sellers" v={formatNumber(brand.avg_fba_sellers, { decimals: 1 })} />
          <Field label="Dominant Seller %" v={formatNumber(brand.dominant_seller_sales_pct, { decimals: 2 })} />
          <Field label="Dominant Seller" v={brand.dominant_seller_name ?? "—"} />
          <Field label="Country" v={brand.dominant_seller_country ?? "—"} />
          <Field label="Has Storefront" v={brand.has_storefront == null ? "—" : brand.has_storefront ? "Yes" : "No"} />
          <Field label="Total Products" v={formatNumber(brand.total_products)} />
          <Field label="Monthly Growth" v={formatNumber(brand.monthly_growth_pct, { decimals: 2 })} />
          <Field label="12-Month Growth" v={formatNumber(brand.trailing_12_growth_pct, { decimals: 2 })} />
        </Card>

        <Card title="Financial model">
          <Field label="Current Profit" v={formatMoney(brand.current_profit)} />
          <Field label="Reseller's Margin" v={formatMoney(brand.resellers_margin)} />
          <Field label="Recouped Shipping" v={formatMoney(brand.recouped_shipping)} />
          <Field label="Labor Cost" v={formatMoney(brand.labor_cost)} />
          <Field label="Additional Profit" v={formatMoney(brand.additional_profit)} />
          <Field label="RCG Fees" v={formatMoney(brand.rcg_fees)} />
          <Field label="New Profit" v={formatMoney(brand.new_profit)} />
          <Field label="7× Multiple Value" v={formatMoney(brand.seven_x_multiple_value)} />
          <div className="text-[11px] text-[var(--text-muted)] mt-2">Read-only for now — editing comes later.</div>
        </Card>

        <Card title="Notes">
          <textarea
            className="input min-h-[140px] font-normal"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => {
              if ((notes ?? "") !== (brand.manual_notes ?? "")) patch({ manual_notes: notes });
            }}
            placeholder="Manual analysis notes…"
          />
          {brand.outreach_activity && (
            <div className="mt-3">
              <div className="text-xs text-[var(--text-muted)] mb-1">Outreach Activity</div>
              <div className="text-sm">{brand.outreach_activity}</div>
            </div>
          )}
        </Card>

        <Card title="Disqualifier tags">
          <div className="flex flex-wrap gap-1 mb-3">
            {tags.length === 0 && <span className="text-sm text-[var(--text-muted)]">No tags</span>}
            {tags.map((t) => (
              <span
                key={t}
                className="px-2 py-1 rounded text-xs bg-[#2a1415] text-[#f87171] border border-[#4a1e21] flex items-center gap-1"
              >
                {t}
                <button className="text-[#f87171] hover:text-white" onClick={() => removeTag(t)}>×</button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              className="input"
              placeholder="add_tag"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
            />
            <button className="btn" onClick={addTag} disabled={!newTag.trim()}>Add</button>
          </div>
        </Card>

        <Card title="Contacts">
          <div className="text-sm text-[var(--text-muted)]">Coming in Phase 6.</div>
        </Card>

        <Card title="Outreach">
          <div className="text-sm text-[var(--text-muted)]">Coming in Phase 6.</div>
        </Card>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-3">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, v }: { label: string; v: string }) {
  return (
    <div className="flex justify-between py-1.5 border-b border-[var(--border-soft)] last:border-0 text-sm">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="font-medium">{v}</span>
    </div>
  );
}
