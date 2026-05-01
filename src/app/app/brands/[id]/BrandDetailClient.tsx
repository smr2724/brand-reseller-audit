"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatNumber, formatMoney, formatDateTime } from "@/lib/utils";
import BrandContactsCard from "./BrandContactsCard";
import BrandOutreachCard from "./BrandOutreachCard";

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
  keepa_last_enriched_at?: string | null;
  keepa_asin_count?: number | null;
  keepa_unique_seller_count?: number | null;
  keepa_brand_controlled_pct?: number | null;
  keepa_top_seller?: string | null;
  keepa_top_seller_share_pct?: number | null;
  keepa_avg_offers?: number | null;
  validation_score?: number | null;
  enrichment_error?: string | null;
  dataforseo_last_enriched_at?: string | null;
  dataforseo_branded_volume?: number | null;
  dataforseo_branded_trend_pct?: number | null;
  dataforseo_competitor_count?: number | null;
  dataforseo_top_keyword?: string | null;
}

interface DfsKeywordRow {
  keyword: string;
  search_volume: number | null;
}
interface DfsCompetitorRow {
  brand: string;
  share_of_serp: number;
}
interface DfsMetricsRow {
  branded_search_volume: number | null;
  branded_trend_pct: number | null;
  top_keywords: DfsKeywordRow[] | null;
  competitor_brands: DfsCompetitorRow[] | null;
  organic_traffic_value: number | null;
  captured_at: string | null;
}

interface BrandAsin {
  id: string;
  asin: string;
  title: string | null;
  buy_box_seller: string | null;
  buy_box_price: number | null;
  offers_count: number | null;
  fba_offers_count: number | null;
  is_brand_controlled: boolean | null;
  last_checked_at: string | null;
}

const STATUSES = ["new", "qualified", "disqualified", "contacted", "client"];

export default function BrandDetailClient({
  brand,
  asins,
  dfsMetrics,
}: {
  brand: Brand;
  asins: BrandAsin[];
  dfsMetrics: DfsMetricsRow | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(brand.status);
  const [notes, setNotes] = useState(brand.manual_notes ?? "");
  const [tags, setTags] = useState<string[]>(brand.disqualifier_tags ?? []);
  const [newTag, setNewTag] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichErr, setEnrichErr] = useState<string | null>(null);
  const [dfsRunning, setDfsRunning] = useState(false);
  const [dfsErr, setDfsErr] = useState<string | null>(null);
  const [primaryContact, setPrimaryContact] = useState<{ id: string; full_name: string; first_name: string | null; title: string | null } | null>(null);

  async function runEnrichment() {
    setEnriching(true);
    setEnrichErr(null);
    try {
      const res = await fetch(`/api/enrichment/brands/${brand.id}/keepa`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setEnrichErr(data.error ?? `HTTP ${res.status}`);
      } else {
        router.refresh();
      }
    } catch (e) {
      setEnrichErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEnriching(false);
    }
  }

  async function runDfsEnrichment() {
    setDfsRunning(true);
    setDfsErr(null);
    try {
      const res = await fetch(`/api/enrichment/brands/${brand.id}/dataforseo`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setDfsErr(data.error ?? `HTTP ${res.status}`);
      } else {
        router.refresh();
      }
    } catch (e) {
      setDfsErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDfsRunning(false);
    }
  }

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

      </div>

      <div className="mt-4 grid grid-cols-1 gap-4">
        <BrandContactsCard brandId={brand.id} onPrimaryContact={setPrimaryContact} />
        <BrandOutreachCard brandId={brand.id} primaryContact={primaryContact} />
      </div>

      <div className="mt-6">
        <EnrichmentSection
          brand={brand}
          asins={asins}
          dfsMetrics={dfsMetrics}
          enriching={enriching}
          enrichErr={enrichErr}
          onEnrich={runEnrichment}
          dfsRunning={dfsRunning}
          dfsErr={dfsErr}
          onDfsEnrich={runDfsEnrichment}
        />
      </div>

      <div className="mt-6">
        <ReportsSection brandId={brand.id} brandName={brand.name} />
      </div>
    </div>
  );
}

function EnrichmentSection({
  brand,
  asins,
  dfsMetrics,
  enriching,
  enrichErr,
  onEnrich,
  dfsRunning,
  dfsErr,
  onDfsEnrich,
}: {
  brand: Brand;
  asins: BrandAsin[];
  dfsMetrics: DfsMetricsRow | null;
  enriching: boolean;
  enrichErr: string | null;
  onEnrich: () => void;
  dfsRunning: boolean;
  dfsErr: string | null;
  onDfsEnrich: () => void;
}) {
  const score = brand.validation_score;
  const scoreColor = score == null ? "#666" : score >= 70 ? "#22c55e" : score >= 40 ? "#eab308" : "#ef4444";
  const lastKeepa = brand.keepa_last_enriched_at ? new Date(brand.keepa_last_enriched_at).toLocaleString() : null;
  const lastDfs = brand.dataforseo_last_enriched_at ? new Date(brand.dataforseo_last_enriched_at).toLocaleString() : null;

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Enrichment</div>
          <div className="text-sm text-[var(--text-muted)] mt-1">
            Channel control (Keepa) + Market demand (DataForSEO)
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-ghost text-xs" onClick={onEnrich} disabled={enriching}>
            {enriching ? "Keepa…" : lastKeepa ? "Re-enrich Keepa" : "Run Keepa"}
          </button>
          <button className="btn btn-ghost text-xs" onClick={onDfsEnrich} disabled={dfsRunning}>
            {dfsRunning ? "DataForSEO…" : lastDfs ? "Re-enrich DataForSEO" : "Run DataForSEO"}
          </button>
        </div>
      </div>

      <div className="mb-5">
        <div className="flex items-baseline justify-between mb-2">
          <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Combined validation score</div>
          <div className="text-3xl font-semibold" style={{ color: scoreColor }}>
            {score == null ? "—" : Math.round(score)}
          </div>
        </div>
        <div className="h-2 rounded bg-[var(--bg-3)] overflow-hidden">
          <div className="h-full transition-all" style={{ width: `${score ?? 0}%`, background: scoreColor }} />
        </div>
        <div className="text-[11px] text-[var(--text-muted)] mt-1">
          Keepa channel control (45 pts) + DataForSEO demand (35 pts) + competitive pressure (20 pts).
        </div>
      </div>

      {(brand.enrichment_error || enrichErr) && (
        <div className="mb-4 p-3 rounded border" style={{ background: "#2a1415", borderColor: "#4a1e21", color: "#f87171" }}>
          <div className="text-sm font-medium">Keepa enrichment error</div>
          <div className="text-xs mt-1">{enrichErr ?? brand.enrichment_error}</div>
        </div>
      )}
      {dfsErr && (
        <div className="mb-4 p-3 rounded border" style={{ background: "#2a1415", borderColor: "#4a1e21", color: "#f87171" }}>
          <div className="text-sm font-medium">DataForSEO enrichment error</div>
          <div className="text-xs mt-1">{dfsErr}</div>
        </div>
      )}

      <div className="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">Channel Health (Keepa)</div>
      <div className="text-xs text-[var(--text-muted)] mb-3">{lastKeepa ? `Last enriched ${lastKeepa}` : "Not yet enriched"}</div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        <Tile label="ASINs found" value={brand.keepa_asin_count ?? "—"} />
        <Tile label="Unique sellers" value={brand.keepa_unique_seller_count ?? "—"} />
        <Tile
          label="Brand controlled"
          value={brand.keepa_brand_controlled_pct == null ? "—" : `${Math.round(brand.keepa_brand_controlled_pct * 100)}%`}
        />
        <Tile
          label="Top seller"
          value={brand.keepa_top_seller ?? "—"}
          sub={brand.keepa_top_seller_share_pct != null ? `${Math.round(brand.keepa_top_seller_share_pct * 100)}%` : undefined}
        />
        <Tile
          label="Avg offers"
          value={brand.keepa_avg_offers != null ? brand.keepa_avg_offers.toFixed(1) : "—"}
        />
      </div>

      <div className="mt-4">
        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">ASINs</div>
        {asins.length === 0 ? (
          <div className="text-sm text-[var(--text-muted)]">No ASIN data yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border-soft)]">
                  <th className="py-2 pr-3">ASIN</th>
                  <th className="py-2 pr-3">Title</th>
                  <th className="py-2 pr-3">Buy box</th>
                  <th className="py-2 pr-3">Price</th>
                  <th className="py-2 pr-3">Offers</th>
                </tr>
              </thead>
              <tbody>
                {asins.map((a) => (
                  <tr key={a.id} className="border-b border-[var(--border-soft)]">
                    <td className="py-2 pr-3 font-mono text-xs">
                      <a
                        href={`https://www.amazon.com/dp/${a.asin}`}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        {a.asin}
                      </a>
                    </td>
                    <td className="py-2 pr-3 max-w-[360px] truncate" title={a.title ?? ""}>{a.title ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <span style={{ color: a.is_brand_controlled ? "#22c55e" : "#f87171" }}>
                        {a.is_brand_controlled ? "✓" : "✗"}
                      </span>{" "}
                      {a.buy_box_seller ?? "—"}
                    </td>
                    <td className="py-2 pr-3">{a.buy_box_price != null ? `$${a.buy_box_price.toFixed(2)}` : "—"}</td>
                    <td className="py-2 pr-3">{a.offers_count ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-8 pt-6 border-t border-[var(--border-soft)]">
        <div className="mb-2 text-xs uppercase tracking-wide text-[var(--text-muted)]">Market Demand (DataForSEO)</div>
        <div className="text-xs text-[var(--text-muted)] mb-3">{lastDfs ? `Last enriched ${lastDfs}` : "Not yet enriched"}</div>

        {!dfsMetrics && !lastDfs ? (
          <div className="text-sm text-[var(--text-muted)]">
            Run DataForSEO enrichment to capture branded search volume, top keywords, and competitor SERP footprint.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
              <Tile
                label="Branded volume / mo"
                value={
                  brand.dataforseo_branded_volume == null
                    ? dfsMetrics?.branded_search_volume == null
                      ? "—"
                      : formatVolumeShort(dfsMetrics.branded_search_volume)
                    : formatVolumeShort(brand.dataforseo_branded_volume)
                }
              />
              <Tile
                label="Trend"
                value={
                  brand.dataforseo_branded_trend_pct == null
                    ? "—"
                    : `${brand.dataforseo_branded_trend_pct > 0 ? "+" : ""}${brand.dataforseo_branded_trend_pct.toFixed(1)}%`
                }
              />
              <Tile
                label="Top keyword"
                value={brand.dataforseo_top_keyword ?? dfsMetrics?.top_keywords?.[0]?.keyword ?? "—"}
              />
              <Tile
                label="Competitors tracked"
                value={brand.dataforseo_competitor_count ?? dfsMetrics?.competitor_brands?.length ?? "—"}
              />
            </div>

            {(dfsMetrics?.top_keywords?.length ?? 0) > 0 && (
              <div className="mb-5">
                <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">Top branded keywords</div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border-soft)]">
                      <th className="py-2 pr-3">Keyword</th>
                      <th className="py-2 pr-3 text-right">Volume / mo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(dfsMetrics?.top_keywords ?? []).slice(0, 8).map((kw, i) => (
                      <tr key={i} className="border-b border-[var(--border-soft)]">
                        <td className="py-2 pr-3">{kw.keyword}</td>
                        <td className="py-2 pr-3 text-right">{formatVolumeShort(kw.search_volume)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {(dfsMetrics?.competitor_brands?.length ?? 0) > 0 && (
              <div className="mb-3">
                <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-2">Competitor brands on branded SERP</div>
                <div className="flex flex-wrap gap-2">
                  {(dfsMetrics?.competitor_brands ?? []).slice(0, 10).map((c, i) => (
                    <span
                      key={i}
                      className="px-2 py-1 rounded text-xs border border-[var(--border-soft)] bg-[var(--bg-2)]"
                    >
                      {c.brand} · {Math.round((c.share_of_serp ?? 0) * 100)}%
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function formatVolumeShort(n: number | null | undefined): string {
  if (n == null || !isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

function Tile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-lg p-3 border border-[var(--border-soft)] bg-[var(--bg-2)]">
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className="text-base font-medium mt-1 truncate" title={String(value)}>{value}</div>
      {sub && <div className="text-[11px] text-[var(--text-muted)] mt-1">{sub}</div>}
    </div>
  );
}

interface BrandReportRow {
  id: string;
  status: string;
  generated_at: string | null;
  created_at: string;
  error_message: string | null;
}

function ReportsSection({ brandId, brandName }: { brandId: string; brandName: string }) {
  const [reports, setReports] = useState<BrandReportRow[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch(`/api/reports?brand_id=${brandId}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setReports(data.reports ?? []);
    } catch {}
  }

  useEffect(() => {
    load();
    // Poll while anything is generating
    const t = setInterval(() => {
      if ((reports ?? []).some((r) => r.status === "generating")) load();
    }, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId, reports?.length]);

  async function generate() {
    setGenerating(true);
    setMsg(null);
    try {
      const res = await fetch("/api/reports/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_id: brandId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(`Failed: ${data.error ?? "unknown"}`);
      } else {
        setMsg("Generation started.");
        await load();
      }
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGenerating(false);
    }
  }

  const list = reports ?? [];
  const hasAny = list.length > 0;

  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Reports</div>
        {hasAny && (
          <button className="btn btn-ghost text-xs" onClick={generate} disabled={generating}>
            {generating ? "Starting…" : "Regenerate"}
          </button>
        )}
      </div>

      {!hasAny ? (
        <div className="flex flex-col items-start gap-3">
          <div className="text-sm text-[var(--text-muted)]">
            No reports yet for {brandName}. Generate a Channel Ownership Audit — a brand-specific PDF
            in the webinar narrative arc, ready to email.
          </div>
          <button className="btn" onClick={generate} disabled={generating}>
            {generating ? "Starting…" : "Generate Channel Ownership Audit"}
          </button>
          {msg && <div className="text-xs text-[var(--text-muted)]">{msg}</div>}
        </div>
      ) : (
        <div>
          <ul className="divide-y divide-[var(--border-soft)]">
            {list.map((r) => (
              <li key={r.id} className="py-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    <Link href={`/app/reports/${r.id}`} className="hover:text-[var(--accent)]">
                      Channel Ownership Audit
                    </Link>
                  </div>
                  <div className="text-xs text-[var(--text-muted)]">
                    {formatDateTime(r.generated_at ?? r.created_at)}
                  </div>
                  {r.status === "failed" && r.error_message && (
                    <div className="text-xs text-[#f87171] mt-1">{r.error_message}</div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <ReportStatusBadge status={r.status} />
                  {r.status === "completed" && (
                    <a className="btn btn-ghost text-xs" href={`/api/reports/${r.id}/download`}>
                      Download
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {msg && <div className="text-xs text-[var(--text-muted)] mt-2">{msg}</div>}
        </div>
      )}
    </div>
  );
}

function ReportStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    generating: "bg-[#2a2410] text-[#facc15] border-[#4a3e1e]",
    completed: "bg-[#102a14] text-[#4ade80] border-[#1e4a28]",
    failed: "bg-[#2a1415] text-[#f87171] border-[#4a1e21]",
  };
  const cls = styles[status] ?? "bg-[var(--bg-3)] text-[var(--text-muted)] border-[var(--border)]";
  return <span className={`px-2 py-1 rounded text-[10px] border ${cls}`}>{status}</span>;
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
