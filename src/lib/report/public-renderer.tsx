/**
 * Phase 6.7 — Branded public report page renderer.
 *
 * Renders the same 8-section narrative arc as the PDF (`renderAuditPdf`)
 * as an HTML/CSS page that lives at `/r/[token]`. Read-only, no auth, no
 * mutations. The report's `narrative_json` plus the live brand row +
 * enrichment bundle drive the content.
 */

import Link from "next/link";
import type { BrandEnrichmentBundle } from "@/lib/enrichment";
import type { NarrativeOutput } from "./narrative";

export interface PublicReportRow {
  id: string;
  token: string;
  generated_at: string | null;
  created_at: string;
  status: string;
  pdf_storage_path: string | null;
  narrative_json: NarrativeOutput | null;
}

export interface PublicReportBrand {
  id: string;
  name: string;
  category: string | null;
  est_monthly_revenue: number | null;
  trailing_12_months: number | null;
  avg_sellers: number | null;
  avg_fba_sellers: number | null;
  dominant_seller_name: string | null;
  dominant_seller_country: string | null;
  dominant_seller_sales_pct: number | null;
  has_storefront: boolean | null;
  total_products: number | null;
  current_profit: number | null;
  additional_profit: number | null;
  new_profit: number | null;
  rcg_fees: number | null;
  seven_x_multiple_value: number | null;
}

export interface PublicReportProps {
  report: PublicReportRow;
  brand: PublicReportBrand;
  bundle: BrandEnrichmentBundle | null;
  pdfUrl: string | null;
}

export function PublicReportView({ report, brand, bundle, pdfUrl }: PublicReportProps) {
  const narrative = report.narrative_json;
  const generatedAt = report.generated_at ?? report.created_at;

  return (
    <div className="pubrep">
      <PublicReportStyles />

      <StickyHeader brandName={brand.name} generatedAt={generatedAt} pdfUrl={pdfUrl} />

      <main className="pubrep-main">
        <ExecutiveSummary brand={brand} bundle={bundle} narrative={narrative} />
        <ChannelHealth brand={brand} bundle={bundle} narrative={narrative} />
        <MarketDemand bundle={bundle} narrative={narrative} />
        <TheGap narrative={narrative} />
        <OpportunityQuadrant brand={brand} bundle={bundle} />
        <ValueAddQuantification brand={brand} narrative={narrative} />
        <Methodology bundle={bundle} generatedAt={generatedAt} />
        <FinalCta brand={brand} pdfUrl={pdfUrl} />
      </main>

      <footer className="pubrep-footer">
        <div className="pubrep-container">
          <div>© {new Date().getFullYear()} Rolle Consulting Group · Confidential audit prepared for {brand.name}</div>
        </div>
      </footer>
    </div>
  );
}

// ---------------- Sticky Header ----------------

function StickyHeader({
  brandName,
  generatedAt,
  pdfUrl,
}: {
  brandName: string;
  generatedAt: string | null;
  pdfUrl: string | null;
}) {
  return (
    <header className="pubrep-hdr">
      <div className="pubrep-container pubrep-hdr-row">
        <Link href="/" className="pubrep-brand">
          {/* Use existing logo asset; falls back gracefully */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/rmg-logo-white.png" alt="Rolle Consulting Group" className="pubrep-logo" />
        </Link>
        <div className="pubrep-hdr-mid">
          <div className="pubrep-hdr-title">{brandName}</div>
          <div className="pubrep-hdr-sub">
            Channel Ownership Audit · {formatShortDate(generatedAt)}
          </div>
        </div>
        <div className="pubrep-hdr-actions">
          {pdfUrl && (
            <a className="pubrep-btn pubrep-btn-primary" href={pdfUrl} target="_blank" rel="noreferrer">
              Download PDF
            </a>
          )}
        </div>
      </div>
    </header>
  );
}

// ---------------- Section 1 — Executive Summary ----------------

function ExecutiveSummary({
  brand,
  bundle,
  narrative,
}: {
  brand: PublicReportBrand;
  bundle: BrandEnrichmentBundle | null;
  narrative: NarrativeOutput | null;
}) {
  const sellerCount = bundle?.keepa?.unique_seller_count ?? null;
  const brandControlled = bundle?.keepa?.brand_controlled_pct ?? null;
  const topSeller = bundle?.keepa?.top_seller ?? brand.dominant_seller_name ?? null;
  const topShare =
    bundle?.keepa?.top_seller_share_pct ??
    (brand.dominant_seller_sales_pct != null ? Number(brand.dominant_seller_sales_pct) / 100 : null);
  const brandedVolume = bundle?.dataforseo?.branded_search_volume ?? null;

  const lede = firstSentence(narrative?.reseller_reality_md) ||
    `An operator-grade audit of ${brand.name}'s Amazon channel — who owns the buy box, where demand is going, and the path to reclaim it.`;

  return (
    <section className="pubrep-section pubrep-hero">
      <div className="pubrep-container">
        <div className="pubrep-eyebrow">Executive Summary</div>
        <h1 className="pubrep-h1">
          {brand.name}<span className="pubrep-h1-em"> — Channel Ownership Audit</span>
        </h1>
        <p className="pubrep-lede">{lede}</p>

        <div className="pubrep-kpis">
          {sellerCount != null && (
            <Kpi label="Sellers competing" value={String(sellerCount)} sub="on your listings (Keepa)" />
          )}
          {brandControlled != null && (
            <Kpi
              label="Brand-controlled"
              value={`${Math.round(Math.max(0, Math.min(1, Number(brandControlled))) * 100)}%`}
              sub="of buy boxes (Keepa)"
            />
          )}
          {topSeller && topShare != null && (
            <Kpi
              label="Top seller share"
              value={`${Math.round(Math.max(0, Math.min(1, Number(topShare))) * 100)}%`}
              sub={`${topSeller} (Keepa)`}
            />
          )}
          {brandedVolume != null && brandedVolume > 0 && (
            <Kpi
              label="Branded searches"
              value={formatVolume(brandedVolume)}
              sub="per month (DataForSEO)"
            />
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------- Section 2 — Channel Health (Keepa) ----------------

function ChannelHealth({
  brand,
  bundle,
  narrative,
}: {
  brand: PublicReportBrand;
  bundle: BrandEnrichmentBundle | null;
  narrative: NarrativeOutput | null;
}) {
  const keepa = bundle?.keepa ?? null;
  return (
    <section className="pubrep-section pubrep-section-alt">
      <div className="pubrep-container">
        <SectionHead
          eyebrow="Channel Health"
          title="Who owns your buy box"
          source="Keepa · channel control"
        />

        {keepa ? (
          <div className="pubrep-stats-row">
            {keepa.asin_count != null && (
              <StatBlock label="ASINs analyzed" value={String(keepa.asin_count)} />
            )}
            {keepa.unique_seller_count != null && (
              <StatBlock label="Unique sellers" value={String(keepa.unique_seller_count)} />
            )}
            {keepa.avg_offers != null && (
              <StatBlock label="Avg offers / ASIN" value={Number(keepa.avg_offers).toFixed(1)} />
            )}
            {keepa.brand_controlled_pct != null && (
              <StatBlock
                label="Brand-controlled"
                value={`${Math.round(Math.max(0, Math.min(1, Number(keepa.brand_controlled_pct))) * 100)}%`}
              />
            )}
          </div>
        ) : (
          <p className="pubrep-muted">Keepa snapshot not available for this audit.</p>
        )}

        {keepa?.sellers && keepa.sellers.length > 0 && (
          <div className="pubrep-sellers">
            <div className="pubrep-sellers-title">Top sellers on your listings</div>
            <ul className="pubrep-sellers-list">
              {keepa.sellers.slice(0, 5).map((s, i) => (
                <li key={`${s.seller_name}-${i}`}>
                  <span className="pubrep-seller-rank">{i + 1}.</span>
                  <span className="pubrep-seller-name">{s.seller_name}</span>
                  <span className="pubrep-seller-share">
                    {s.share_pct != null ? `${Math.round(Number(s.share_pct) * 100)}% share` : "—"}
                  </span>
                  {s.asins_won != null && (
                    <span className="pubrep-seller-asins">{s.asins_won} ASINs won</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Markdown md={narrative?.reseller_reality_md} />

        {narrative?.footprint_callouts_md && narrative.footprint_callouts_md.length > 0 && (
          <ul className="pubrep-callouts">
            {narrative.footprint_callouts_md.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        )}

        {/* Subtle SmartScout supporting facts (don't crowd the section) */}
        <div className="pubrep-subfacts">
          {brand.est_monthly_revenue != null && (
            <Fact label="Est. monthly revenue" value={money(brand.est_monthly_revenue)} hint="SmartScout" />
          )}
          {brand.dominant_seller_country && (
            <Fact label="Dominant seller country" value={brand.dominant_seller_country} hint="SmartScout" />
          )}
          {brand.has_storefront != null && (
            <Fact label="Brand storefront" value={brand.has_storefront ? "Yes" : "No"} hint="SmartScout" />
          )}
          {brand.total_products != null && (
            <Fact label="Products on Amazon" value={String(brand.total_products)} hint="SmartScout" />
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------- Section 3 — Market Demand (DataForSEO) ----------------

function MarketDemand({
  bundle,
  narrative,
}: {
  bundle: BrandEnrichmentBundle | null;
  narrative: NarrativeOutput | null;
}) {
  const dfs = bundle?.dataforseo ?? null;
  return (
    <section className="pubrep-section">
      <div className="pubrep-container">
        <SectionHead
          eyebrow="Market Demand"
          title="What customers are searching for"
          source="DataForSEO · branded demand"
        />

        {dfs && (
          <div className="pubrep-stats-row">
            {dfs.branded_search_volume != null && (
              <StatBlock
                label="Branded searches / mo"
                value={formatVolume(dfs.branded_search_volume)}
              />
            )}
            {dfs.branded_trend_pct != null && (
              <StatBlock
                label="Trend"
                value={`${dfs.branded_trend_pct > 0 ? "+" : ""}${Number(dfs.branded_trend_pct).toFixed(1)}%`}
              />
            )}
            {dfs.organic_traffic_value != null && (
              <StatBlock label="Organic traffic value" value={money(dfs.organic_traffic_value)} />
            )}
          </div>
        )}

        <Markdown md={narrative?.market_demand_md} />

        {dfs?.top_keywords && dfs.top_keywords.length > 0 && (
          <div className="pubrep-kwblock">
            <div className="pubrep-kwblock-title">Top branded keywords</div>
            <ul className="pubrep-kwlist">
              {dfs.top_keywords.slice(0, 8).map((k, i) => (
                <li key={`${k.keyword}-${i}`}>
                  <span className="pubrep-kw">{k.keyword}</span>
                  <span className="pubrep-kw-vol">
                    {k.search_volume != null ? `${formatVolume(k.search_volume)}/mo` : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {dfs?.competitor_brands && dfs.competitor_brands.length > 0 && (
          <div className="pubrep-kwblock">
            <div className="pubrep-kwblock-title">Top SERP competitors</div>
            <ul className="pubrep-kwlist">
              {dfs.competitor_brands.slice(0, 6).map((c, i) => (
                <li key={`${c.brand}-${i}`}>
                  <span className="pubrep-kw">{c.brand}</span>
                  <span className="pubrep-kw-vol">
                    {c.share_of_serp != null ? `${Math.round(Number(c.share_of_serp) * 100)}% SERP` : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------- Section 4 — The Gap ----------------

function TheGap({ narrative }: { narrative: NarrativeOutput | null }) {
  return (
    <section className="pubrep-section pubrep-section-alt">
      <div className="pubrep-container">
        <SectionHead
          eyebrow="The Gap"
          title="Demand the brand created. Captured by someone else."
          source="Keepa × DataForSEO"
        />
        <Markdown md={narrative?.the_gap_md} />
      </div>
    </section>
  );
}

// ---------------- Section 5 — Opportunity Quadrant (visual) ----------------

function OpportunityQuadrant({
  brand,
  bundle,
}: {
  brand: PublicReportBrand;
  bundle: BrandEnrichmentBundle | null;
}) {
  const demand = bundle?.dataforseo?.branded_search_volume ?? null;
  const channelControl = bundle?.keepa?.brand_controlled_pct ?? null;

  // Quadrant: x = demand (low/high), y = channel control (low/high).
  // The audited brand is plotted; the four quadrants are labeled to make
  // the point.
  const xPct = demand != null ? Math.min(100, Math.max(0, Math.log10(Math.max(1, demand)) * 18)) : 25;
  const yPct =
    channelControl != null ? (1 - Math.max(0, Math.min(1, Number(channelControl)))) * 100 : 75;

  return (
    <section className="pubrep-section">
      <div className="pubrep-container">
        <SectionHead
          eyebrow="Opportunity Quadrant"
          title="Where this brand sits"
          source="Demand × control"
        />

        <div className="pubrep-quadrant">
          <div className="pubrep-quad-axis-y">High channel control ↑</div>
          <div className="pubrep-quad-axis-x">→ High demand</div>

          <div className="pubrep-quad-grid">
            <div className="pubrep-quad-cell pubrep-quad-tl">
              <div className="pubrep-quad-cell-label">Low demand · Brand-controlled</div>
              <div className="pubrep-quad-cell-sub">Quiet but tidy</div>
            </div>
            <div className="pubrep-quad-cell pubrep-quad-tr">
              <div className="pubrep-quad-cell-label">High demand · Brand-controlled</div>
              <div className="pubrep-quad-cell-sub">Where you want to be</div>
            </div>
            <div className="pubrep-quad-cell pubrep-quad-bl">
              <div className="pubrep-quad-cell-label">Low demand · Reseller-controlled</div>
              <div className="pubrep-quad-cell-sub">Low priority</div>
            </div>
            <div className="pubrep-quad-cell pubrep-quad-br">
              <div className="pubrep-quad-cell-label">High demand · Reseller-controlled</div>
              <div className="pubrep-quad-cell-sub">Profit leakage zone</div>
            </div>

            <div
              className="pubrep-quad-pin"
              style={{ left: `${xPct}%`, top: `${yPct}%` }}
              aria-label={`${brand.name} on the demand × control quadrant`}
            >
              <span className="pubrep-quad-pin-dot" />
              <span className="pubrep-quad-pin-label">{brand.name}</span>
            </div>
          </div>
        </div>

        <p className="pubrep-muted pubrep-quad-note">
          Plotting demand (DataForSEO branded search volume) against channel control
          (Keepa brand-controlled buy-box share). Most reseller-saturated brands sit
          in the bottom-right — high demand the brand earned, captured by other
          storefronts.
        </p>
      </div>
    </section>
  );
}

// ---------------- Section 6 — Value Add Quantification ----------------

function ValueAddQuantification({
  brand,
  narrative,
}: {
  brand: PublicReportBrand;
  narrative: NarrativeOutput | null;
}) {
  const hasFinancials =
    brand.current_profit != null || brand.additional_profit != null || brand.new_profit != null;

  return (
    <section className="pubrep-section pubrep-section-alt">
      <div className="pubrep-container">
        <SectionHead
          eyebrow="Value Add Quantification"
          title="What reclaiming the channel could be worth"
          source="Illustrative model"
        />

        <Markdown md={narrative?.opportunity_narrative_md} />

        {hasFinancials && (
          <div className="pubrep-finrow">
            {brand.current_profit != null && (
              <StatBlock
                label="Current per-unit profit"
                value={money(brand.current_profit)}
                hint="Wholesale-to-reseller path"
              />
            )}
            {brand.additional_profit != null && (
              <StatBlock
                label="Illustrative additional profit"
                value={money(brand.additional_profit)}
                hint="Direct-to-Amazon path · before fees"
                accent
              />
            )}
            {brand.new_profit != null && (
              <StatBlock
                label="Illustrative new per-unit profit"
                value={money(brand.new_profit)}
                hint="Net of RCG fee"
                accent
              />
            )}
            {brand.seven_x_multiple_value != null && (
              <StatBlock
                label="7× enterprise-value lift"
                value={money(brand.seven_x_multiple_value)}
                hint="Illustrative multiple on incremental EBITDA"
              />
            )}
          </div>
        )}

        <Markdown md={narrative?.value_add_md} />
      </div>
    </section>
  );
}

// ---------------- Section 7 — Methodology ----------------

function Methodology({
  bundle,
  generatedAt,
}: {
  bundle: BrandEnrichmentBundle | null;
  generatedAt: string | null;
}) {
  const keepaAt = bundle?.freshness?.keepa ?? bundle?.keepa?.last_enriched_at ?? null;
  const dfsAt = bundle?.freshness?.dataforseo ?? bundle?.dataforseo?.captured_at ?? null;

  return (
    <section className="pubrep-section">
      <div className="pubrep-container">
        <SectionHead eyebrow="Methodology & Sources" title="How this audit was built" />

        <ul className="pubrep-method">
          <li>
            <strong>Keepa</strong> — channel-control snapshot. Buy-box wins, seller share, and
            offer counts pulled from a sample of brand ASINs.
            {keepaAt && <span className="pubrep-method-when"> Snapshot: {formatShortDate(keepaAt)}.</span>}
          </li>
          <li>
            <strong>DataForSEO</strong> — branded demand snapshot. Search volume, trend, top
            keywords, and SERP competitor share for the brand's branded keyword set.
            {dfsAt && <span className="pubrep-method-when"> Snapshot: {formatShortDate(dfsAt)}.</span>}
          </li>
          <li>
            <strong>SmartScout</strong> — Amazon footprint signals (revenue estimates,
            dominant seller, storefront presence) sourced from the brand record.
          </li>
          <li className="pubrep-method-meta">Audit generated {formatShortDate(generatedAt)}.</li>
        </ul>
      </div>
    </section>
  );
}

// ---------------- Section 8 — Final CTA ----------------

function FinalCta({ brand, pdfUrl }: { brand: PublicReportBrand; pdfUrl: string | null }) {
  return (
    <section className="pubrep-section pubrep-cta">
      <div className="pubrep-container">
        <h2 className="pubrep-h2">Want to discuss what this looks like for {brand.name}?</h2>
        <p className="pubrep-lede">
          Reply to the email this audit came in on, or reach out directly to talk through what
          reclaiming the channel could look like.
        </p>
        <p className="pubrep-cta-contact">
          <a href="mailto:steve@rollemanagementgroup.com">steve@rollemanagementgroup.com</a>
          <br />
          Steve Rolle, Founder · Rolle Consulting Group
        </p>
        <div className="pubrep-cta-actions">
          {/* TODO: replace with real Calendly link once it's wired up */}
          <a
            className="pubrep-btn pubrep-btn-primary"
            href="https://calendly.com/steve-rollemanagementgroup/intro"
            target="_blank"
            rel="noreferrer"
          >
            Schedule a call
          </a>
          {pdfUrl && (
            <a className="pubrep-btn" href={pdfUrl} target="_blank" rel="noreferrer">
              Download the PDF
            </a>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------- Building blocks ----------------

function SectionHead({
  eyebrow,
  title,
  source,
}: {
  eyebrow: string;
  title: string;
  source?: string;
}) {
  return (
    <div className="pubrep-section-head">
      <div className="pubrep-eyebrow">{eyebrow}</div>
      <h2 className="pubrep-h2">{title}</h2>
      {source && <div className="pubrep-source">{source}</div>}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="pubrep-kpi">
      <div className="pubrep-kpi-num">{value}</div>
      <div className="pubrep-kpi-lbl">{label}</div>
      {sub && <div className="pubrep-kpi-sub">{sub}</div>}
    </div>
  );
}

function StatBlock({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className={`pubrep-stat ${accent ? "pubrep-stat-accent" : ""}`}>
      <div className="pubrep-stat-num">{value}</div>
      <div className="pubrep-stat-lbl">{label}</div>
      {hint && <div className="pubrep-stat-hint">{hint}</div>}
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="pubrep-fact">
      <div className="pubrep-fact-lbl">{label}</div>
      <div className="pubrep-fact-val">{value}</div>
      {hint && <div className="pubrep-fact-hint">{hint}</div>}
    </div>
  );
}

function Markdown({ md }: { md: string | null | undefined }) {
  if (!md || !md.trim()) return null;
  // Lightweight: split paragraphs by blank lines, render <p>. No external lib.
  const paragraphs = md.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return (
    <div className="pubrep-prose">
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}

// ---------------- Helpers ----------------

function firstSentence(md: string | null | undefined): string {
  if (!md) return "";
  const s = md.replace(/\s+/g, " ").trim();
  const m = s.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : s).slice(0, 320);
}

function money(n: number | null | undefined): string {
  if (n == null || isNaN(Number(n))) return "—";
  return `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function formatVolume(n: number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

function formatShortDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "—";
  }
}

// ---------------- Styles ----------------

function PublicReportStyles() {
  return (
    <style>{`
      .pubrep {
        --bg: #0b0b0d;
        --bg-alt: #111114;
        --text: #f2f2f3;
        --text-muted: #9b9ba3;
        --gold: #c9a96a;
        --gold-soft: #d8b878;
        --border: rgba(255,255,255,0.08);
        --border-soft: rgba(255,255,255,0.05);
        background: var(--bg);
        color: var(--text);
        min-height: 100vh;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        line-height: 1.6;
      }
      .pubrep-container { max-width: 1080px; margin: 0 auto; padding: 0 24px; }

      .pubrep-eyebrow {
        text-transform: uppercase; letter-spacing: 0.14em;
        font-size: 11px; color: var(--gold); font-weight: 600;
      }
      .pubrep-source {
        margin-top: 6px; font-size: 12px; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.06em;
      }

      .pubrep-h1, .pubrep-h2 { color: var(--text); margin: 0; font-family: 'Fraunces', 'Inter', serif; font-weight: 600; letter-spacing: -0.02em; }
      .pubrep-h1 { font-size: 44px; line-height: 1.1; margin-top: 18px; }
      .pubrep-h1-em { color: var(--gold-soft); font-weight: 400; }
      .pubrep-h2 { font-size: 28px; line-height: 1.2; margin-top: 8px; margin-bottom: 6px; }

      .pubrep-lede { font-size: 18px; color: var(--text-muted); max-width: 720px; }
      .pubrep-muted { color: var(--text-muted); }

      /* Sticky header */
      .pubrep-hdr {
        position: sticky; top: 0; z-index: 10;
        background: rgba(11,11,13,0.85);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border-bottom: 1px solid var(--border-soft);
      }
      .pubrep-hdr-row {
        display: flex; align-items: center; gap: 16px; padding: 14px 24px;
        flex-wrap: wrap;
      }
      .pubrep-brand { display: inline-flex; align-items: center; }
      .pubrep-logo { height: 28px; width: auto; }
      .pubrep-hdr-mid { flex: 1; min-width: 0; }
      .pubrep-hdr-title { font-weight: 600; color: var(--text); font-size: 14px; line-height: 1.2; }
      .pubrep-hdr-sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
      .pubrep-hdr-actions { display: flex; gap: 8px; }

      .pubrep-btn {
        display: inline-block; padding: 9px 16px; border-radius: 8px;
        background: rgba(255,255,255,0.05);
        color: var(--text); border: 1px solid var(--border);
        font-size: 13px; font-weight: 500; text-decoration: none;
        transition: all 0.15s;
      }
      .pubrep-btn:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.15); }
      .pubrep-btn-primary {
        background: var(--gold); color: #1a1408; border-color: var(--gold);
        font-weight: 600;
      }
      .pubrep-btn-primary:hover { background: var(--gold-soft); border-color: var(--gold-soft); }

      /* Sections */
      .pubrep-section { padding: 56px 0; border-top: 1px solid var(--border-soft); }
      .pubrep-section:first-of-type { border-top: none; }
      .pubrep-section-alt { background: var(--bg-alt); }
      .pubrep-section-head { max-width: 760px; margin-bottom: 28px; }

      .pubrep-hero { padding: 72px 0 56px; }

      .pubrep-kpis {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 14px; margin-top: 36px;
      }
      .pubrep-kpi {
        padding: 18px; border: 1px solid var(--border);
        background: rgba(255,255,255,0.02); border-radius: 12px;
      }
      .pubrep-kpi-num {
        font-size: 32px; font-weight: 700; letter-spacing: -0.01em;
        color: var(--gold); font-variant-numeric: tabular-nums;
      }
      .pubrep-kpi-lbl { font-size: 13px; color: var(--text); margin-top: 4px; }
      .pubrep-kpi-sub { font-size: 11px; color: var(--text-muted); margin-top: 2px; }

      /* Stats row */
      .pubrep-stats-row, .pubrep-finrow {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px; margin-bottom: 24px;
      }
      .pubrep-stat {
        padding: 16px; border: 1px solid var(--border-soft);
        background: rgba(255,255,255,0.02); border-radius: 10px;
      }
      .pubrep-stat-accent { border-color: rgba(201,169,106,0.4); background: rgba(201,169,106,0.06); }
      .pubrep-stat-num {
        font-size: 24px; font-weight: 700; color: var(--gold);
        letter-spacing: -0.01em; font-variant-numeric: tabular-nums;
      }
      .pubrep-stat-lbl { font-size: 12px; color: var(--text); margin-top: 4px; }
      .pubrep-stat-hint { font-size: 11px; color: var(--text-muted); margin-top: 2px; }

      /* Sellers list */
      .pubrep-sellers {
        margin-top: 12px; padding: 18px;
        border: 1px solid var(--border); background: rgba(255,255,255,0.015);
        border-radius: 10px;
      }
      .pubrep-sellers-title {
        font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
        color: var(--text-muted); margin-bottom: 10px;
      }
      .pubrep-sellers-list { list-style: none; padding: 0; margin: 0; }
      .pubrep-sellers-list li {
        display: flex; align-items: baseline; gap: 12px;
        padding: 8px 0; border-bottom: 1px solid var(--border-soft);
        font-size: 14px; flex-wrap: wrap;
      }
      .pubrep-sellers-list li:last-child { border-bottom: none; }
      .pubrep-seller-rank { color: var(--gold); font-weight: 600; min-width: 22px; }
      .pubrep-seller-name { flex: 1; min-width: 160px; color: var(--text); }
      .pubrep-seller-share { color: var(--gold-soft); font-variant-numeric: tabular-nums; font-size: 13px; }
      .pubrep-seller-asins { color: var(--text-muted); font-size: 12px; }

      .pubrep-callouts {
        margin: 20px 0 0; padding: 0; list-style: none;
        display: grid; gap: 8px;
      }
      .pubrep-callouts li {
        padding: 10px 14px; border-left: 2px solid var(--gold);
        background: rgba(201,169,106,0.06); color: var(--text); font-size: 14px;
        border-radius: 0 6px 6px 0;
      }

      .pubrep-subfacts {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px; margin-top: 24px;
      }
      .pubrep-fact {
        padding: 12px 14px; border: 1px solid var(--border-soft);
        border-radius: 8px; background: rgba(255,255,255,0.015);
      }
      .pubrep-fact-lbl {
        font-size: 11px; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.08em;
      }
      .pubrep-fact-val { font-size: 14px; color: var(--text); margin-top: 2px; }
      .pubrep-fact-hint { font-size: 11px; color: var(--text-muted); margin-top: 2px; font-style: italic; }

      /* Keyword block */
      .pubrep-kwblock { margin-top: 20px; }
      .pubrep-kwblock-title {
        font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
        color: var(--text-muted); margin-bottom: 8px;
      }
      .pubrep-kwlist { list-style: none; padding: 0; margin: 0; }
      .pubrep-kwlist li {
        display: flex; justify-content: space-between; gap: 12px;
        padding: 8px 0; border-bottom: 1px solid var(--border-soft);
        font-size: 14px;
      }
      .pubrep-kwlist li:last-child { border-bottom: none; }
      .pubrep-kw { color: var(--text); }
      .pubrep-kw-vol { color: var(--gold-soft); font-variant-numeric: tabular-nums; font-size: 13px; }

      /* Quadrant */
      .pubrep-quadrant {
        position: relative; margin-top: 24px;
        padding: 28px 24px 24px 60px;
      }
      .pubrep-quad-axis-y {
        position: absolute; left: 0; top: 50%;
        transform: translateY(-50%) rotate(-90deg); transform-origin: left center;
        font-size: 11px; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.08em; white-space: nowrap;
      }
      .pubrep-quad-axis-x {
        text-align: right; font-size: 11px; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.08em; margin-top: 8px;
      }
      .pubrep-quad-grid {
        position: relative;
        display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;
        height: 320px; border: 1px solid var(--border);
        border-radius: 8px; overflow: hidden;
      }
      .pubrep-quad-cell {
        padding: 14px; border-right: 1px solid var(--border-soft);
        border-bottom: 1px solid var(--border-soft);
        background: rgba(255,255,255,0.015);
      }
      .pubrep-quad-cell:nth-child(2n) { border-right: none; }
      .pubrep-quad-cell:nth-child(n+3) { border-bottom: none; }
      .pubrep-quad-cell-label { font-size: 12px; color: var(--text); font-weight: 600; }
      .pubrep-quad-cell-sub { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
      .pubrep-quad-tr { background: rgba(74,222,128,0.07); }
      .pubrep-quad-br { background: rgba(248,113,113,0.07); }
      .pubrep-quad-pin {
        position: absolute; transform: translate(-50%, -50%);
        display: flex; align-items: center; gap: 6px;
        z-index: 2;
      }
      .pubrep-quad-pin-dot {
        width: 12px; height: 12px; border-radius: 50%;
        background: var(--gold); box-shadow: 0 0 0 4px rgba(201,169,106,0.25);
      }
      .pubrep-quad-pin-label {
        font-size: 12px; color: var(--text); font-weight: 600;
        background: rgba(11,11,13,0.85); padding: 2px 6px; border-radius: 4px;
        border: 1px solid var(--border-soft);
      }
      .pubrep-quad-note { margin-top: 14px; font-size: 12px; }

      /* Methodology */
      .pubrep-method { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
      .pubrep-method li {
        padding: 14px 16px; border: 1px solid var(--border-soft);
        background: rgba(255,255,255,0.015); border-radius: 10px; font-size: 14px;
      }
      .pubrep-method strong { color: var(--gold); }
      .pubrep-method-when { color: var(--text-muted); font-size: 13px; margin-left: 4px; }
      .pubrep-method-meta { color: var(--text-muted); font-size: 13px; }

      /* Prose (markdown paragraphs) */
      .pubrep-prose p {
        font-size: 16px; line-height: 1.7; color: var(--text); margin: 0 0 14px;
      }
      .pubrep-prose p:last-child { margin-bottom: 0; }

      /* CTA */
      .pubrep-cta { padding: 80px 0; text-align: center; }
      .pubrep-cta h2 { margin-bottom: 12px; }
      .pubrep-cta .pubrep-lede { margin: 0 auto 16px; }
      .pubrep-cta-contact { font-size: 16px; color: var(--text); margin: 16px auto 24px; line-height: 1.7; }
      .pubrep-cta-contact a { color: var(--gold); text-decoration: none; }
      .pubrep-cta-contact a:hover { text-decoration: underline; }
      .pubrep-cta-actions { display: inline-flex; gap: 12px; flex-wrap: wrap; justify-content: center; }

      .pubrep-footer {
        padding: 28px 0; border-top: 1px solid var(--border-soft);
        color: var(--text-muted); font-size: 12px; text-align: center;
      }

      /* Mobile */
      @media (max-width: 640px) {
        .pubrep-h1 { font-size: 32px; }
        .pubrep-h2 { font-size: 22px; }
        .pubrep-section { padding: 44px 0; }
        .pubrep-hero { padding: 56px 0 40px; }
        .pubrep-quad-grid { height: 260px; }
        .pubrep-hdr-row { padding: 10px 16px; gap: 10px; }
        .pubrep-hdr-mid { width: 100%; order: 3; }
      }

      /* Print: clean, paginated, no dark backgrounds. */
      @media print {
        .pubrep {
          background: #fff !important; color: #111 !important;
        }
        .pubrep-hdr, .pubrep-hdr-actions, .pubrep-cta-actions { display: none !important; }
        .pubrep-section { padding: 24px 0; border-top: 1px solid #ddd; page-break-inside: avoid; }
        .pubrep-section-alt { background: #fff !important; }
        .pubrep-eyebrow, .pubrep-stat-num, .pubrep-kpi-num, .pubrep-source,
        .pubrep-method strong, .pubrep-h1-em, .pubrep-cta-contact a, .pubrep-seller-rank,
        .pubrep-kw-vol, .pubrep-seller-share { color: #8a6d2e !important; }
        .pubrep-h1, .pubrep-h2, .pubrep-prose p, .pubrep-kpi-lbl, .pubrep-stat-lbl,
        .pubrep-fact-val, .pubrep-callouts li, .pubrep-method li, .pubrep-kw,
        .pubrep-seller-name { color: #111 !important; }
        .pubrep-lede, .pubrep-muted, .pubrep-kpi-sub, .pubrep-stat-hint,
        .pubrep-fact-lbl, .pubrep-fact-hint, .pubrep-method-when, .pubrep-method-meta {
          color: #555 !important;
        }
        .pubrep-kpi, .pubrep-stat, .pubrep-fact, .pubrep-method li, .pubrep-sellers,
        .pubrep-callouts li, .pubrep-quad-cell {
          background: #fafafa !important; border-color: #ddd !important;
        }
        .pubrep-stat-accent { background: #fdf6e6 !important; }
      }
    `}</style>
  );
}
