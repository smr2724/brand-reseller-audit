/**
 * Phase 8 — Public web renderer for v2 audit reports.
 *
 * Consumes a `NarrativeV2` (loaded from reports.narrative_json when
 * version === 2) plus the live brand row + enrichment bundle and
 * renders the 9-section layout. CSS-in-JSX with the RCG dark/cream
 * palette, mobile-responsive, print-friendly.
 *
 * v1 reports continue to render via the existing PublicReportView.
 */
/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import type { BrandEnrichmentBundle } from "@/lib/enrichment";
import type {
  CompetitorRow,
  CxAuditAsinScore,
  MathLine,
  NarrativeV2,
  ResellerRow,
} from "./types";

export interface PublicReportV2Brand {
  id: string;
  name: string;
  category: string | null;
  est_monthly_revenue: number | null;
}

export interface PublicReportV2Props {
  narrative: NarrativeV2;
  brand: PublicReportV2Brand;
  bundle: BrandEnrichmentBundle | null;
  pdfUrl: string | null;
}

export function PublicReportV2({ narrative, brand, bundle, pdfUrl }: PublicReportV2Props) {
  return (
    <div className="rv2">
      <V2Styles />
      <Header brand={brand} pdfUrl={pdfUrl} narrative={narrative} />
      <SideNav />

      <main className="rv2-main">
        <SectionCover narrative={narrative} brand={brand} />
        <SectionResellerReality narrative={narrative} bundle={bundle} />
        <SectionResellerDossier narrative={narrative} />
        <SectionCxAudit narrative={narrative} />
        <SectionCompetitorBenchmark narrative={narrative} />
        <SectionMath narrative={narrative} />
        <SectionPlan narrative={narrative} />
        <SectionWhyRcg narrative={narrative} />
        <SectionCta narrative={narrative} pdfUrl={pdfUrl} />
      </main>

      <footer className="rv2-footer">
        © {new Date().getFullYear()} Rolle Consulting Group · Confidential audit prepared for {brand.name}
      </footer>
    </div>
  );
}

// ====================================================================
// Header (sticky)
// ====================================================================

function Header({
  brand,
  pdfUrl,
  narrative,
}: {
  brand: PublicReportV2Brand;
  pdfUrl: string | null;
  narrative: NarrativeV2;
}) {
  return (
    <header className="rv2-hdr">
      <div className="rv2-hdr-row">
        <Link href="/" className="rv2-hdr-brand">
          <img src="/rmg-logo-white.png" alt="Rolle Consulting Group" className="rv2-hdr-logo" />
        </Link>
        <div className="rv2-hdr-mid">
          <div className="rv2-hdr-title">{brand.name}</div>
          <div className="rv2-hdr-sub">
            Channel Ownership Audit · {formatShortDate(narrative.generated_at)}
          </div>
        </div>
        <div className="rv2-hdr-actions">
          {pdfUrl && (
            <a className="rv2-btn rv2-btn-primary" href={pdfUrl} target="_blank" rel="noreferrer">
              Download PDF
            </a>
          )}
        </div>
      </div>
    </header>
  );
}

// ====================================================================
// Side nav (anchors)
// ====================================================================

function SideNav() {
  const items: [string, string][] = [
    ["s-cover", "Headline"],
    ["s-reseller-reality", "Reseller reality"],
    ["s-dossier", "Reseller dossier"],
    ["s-cx", "CX audit"],
    ["s-bench", "Benchmark"],
    ["s-math", "The math"],
    ["s-plan", "90-day plan"],
    ["s-why", "Why RCG"],
    ["s-cta", "Next step"],
  ];
  return (
    <nav className="rv2-sidenav" aria-label="Sections">
      <ul>
        {items.map(([id, label]) => (
          <li key={id}>
            <a href={`#${id}`}>{label}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ====================================================================
// Section 1 — Cover & Headline
// ====================================================================

function SectionCover({ narrative, brand }: { narrative: NarrativeV2; brand: PublicReportV2Brand }) {
  const c = narrative.cover;
  const initials = brand.name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <section id="s-cover" className="rv2-section rv2-section-cover">
      <div className="rv2-eyebrow">Channel Ownership Audit</div>
      <div className="rv2-cover-row">
        <div className="rv2-cover-logo">
          {c.brand_logo_url ? (
            <img src={c.brand_logo_url} alt={`${brand.name} logo`} className="rv2-cover-logo-img" />
          ) : (
            <div className="rv2-cover-initials">{initials || "—"}</div>
          )}
        </div>
        <div className="rv2-cover-meta">
          <div className="rv2-cover-meta-line">Prepared for {brand.name}</div>
          <div className="rv2-cover-meta-line rv2-muted">
            {formatLongDate(narrative.generated_at)} · By Rolle Consulting Group
          </div>
        </div>
      </div>
      <h1 className="rv2-h1">{repairCoverHeadline(c.headline, brand.name)}</h1>

      {c.kpis.length > 0 && (
        <div className="rv2-kpi-grid">
          {c.kpis.map((k, i) => (
            <div key={i} className="rv2-kpi">
              <div className="rv2-kpi-num">{k.value}</div>
              <div className="rv2-kpi-lbl">{k.label}</div>
              {k.sub && (
                <div className="rv2-kpi-sub">
                  {k.sub.replace(/\bA[A-Z0-9]{12,13}\b/g, (id) => `Unknown 3P seller (ID: ${id})`)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ====================================================================
// Section 2 — Reseller Reality (charts)
// ====================================================================

function SectionResellerReality({
  narrative,
  bundle,
}: {
  narrative: NarrativeV2;
  bundle: BrandEnrichmentBundle | null;
}) {
  const r = narrative.reseller_reality;
  const sellers = r.top_sellers;
  const maxShare = sellers.reduce((m, s) => Math.max(m, s.share_pct ?? 0), 0) || 1;

  return (
    <section id="s-reseller-reality" className="rv2-section rv2-section-alt">
      <SectionHead eyebrow="Reseller Reality" title="Who actually sells your brand on Amazon" source="Keepa · 90-day window" />

      {sellers.length > 0 ? (
        <>
          <div className="rv2-bars">
            {sellers.map((s, i) => (
              <ResellerBar key={`${s.seller_name}-${i}`} row={s} maxShare={maxShare} />
            ))}
          </div>
          <p className="rv2-prose">{r.one_liner}</p>

          <div className="rv2-checklist">
            <div className="rv2-checklist-title">Did you authorize these sellers?</div>
            <ul>
              {sellers.slice(0, 5).map((s, i) => (
                <li key={`auth-${i}`}>
                  <span className="rv2-q">?</span>
                  <span>{friendlySellerName(s.seller_name)}</span>
                </li>
              ))}
            </ul>
            <div className="rv2-checklist-note">
              Mark each as authorized or not in the kickoff session — that drives the termination list.
            </div>
          </div>

          {bundle?.keepa?.brand_controlled_pct != null && (
            <BuyBoxPanel pct={bundle.keepa.brand_controlled_pct} />
          )}
        </>
      ) : (
        <p className="rv2-muted">{r.note ?? "Reseller landscape — not measured this run."}</p>
      )}
    </section>
  );
}

function ResellerBar({ row, maxShare }: { row: ResellerRow; maxShare: number }) {
  const pct = row.share_pct ?? 0;
  const widthPct = Math.max(2, Math.round((pct / maxShare) * 100));
  const name = friendlySellerName(row.seller_name);
  return (
    <div className="rv2-bar-row">
      <div className="rv2-bar-rank">{row.rank}.</div>
      <div className="rv2-bar-name" title={name}>
        {name}
      </div>
      <div className="rv2-bar-track">
        <div className="rv2-bar-fill" style={{ width: `${widthPct}%` }} aria-hidden />
      </div>
      <div className="rv2-bar-val">
        {row.share_pct != null ? `${Math.round(row.share_pct * 100)}%` : "—"}
      </div>
      <div className="rv2-bar-asins">
        {row.asins_won != null ? `${row.asins_won} ASINs` : ""}
      </div>
    </div>
  );
}

function BuyBoxPanel({ pct }: { pct: number }) {
  const brandPct = Math.max(0, Math.min(1, pct));
  const resellerPct = 1 - brandPct;
  return (
    <div className="rv2-bbpanel">
      <div className="rv2-bbpanel-title">Buy-box ownership over the last 90 days</div>
      <div className="rv2-bbpanel-bar">
        <div className="rv2-bbpanel-brand" style={{ width: `${Math.round(brandPct * 100)}%` }}>
          <span>{Math.round(brandPct * 100)}% brand-controlled</span>
        </div>
        <div className="rv2-bbpanel-reseller" style={{ width: `${Math.round(resellerPct * 100)}%` }}>
          <span>{Math.round(resellerPct * 100)}% resellers</span>
        </div>
      </div>
      <div className="rv2-bbpanel-note">Source: Keepa · share of buy-box wins on the audited ASINs.</div>
    </div>
  );
}

// ====================================================================
// Section 3 — Reseller Dossier
// ====================================================================

function SectionResellerDossier({ narrative }: { narrative: NarrativeV2 }) {
  const d = narrative.reseller_dossier;
  const friendly = d ? friendlySellerName(d.seller_name) : null;
  return (
    <section id="s-dossier" className="rv2-section">
      <SectionHead
        eyebrow="Reseller Dossier"
        title={d ? `Inside ${friendly}` : "Top sellers snapshot"}
        source="Keepa · seller profile"
      />
      {d ? (
        <>
          <div className="rv2-dossier-grid">
            <Fact label="Seller name" value={friendly ?? d.seller_name} />
            <Fact label="Marketplace ID" value={d.seller_id ?? "— not measured"} />
            <Fact label="Country" value={d.country ?? "— not measured"} />
            <Fact
              label="Buy-box share"
              value={d.share_pct != null ? `${Math.round(d.share_pct * 100)}%` : "— not measured"}
            />
            <Fact
              label="ASINs won"
              value={d.asins_won != null ? String(d.asins_won) : "— not measured"}
            />
            <Fact label="Fulfilment" value={d.fulfilment_mix} />
          </div>

          {d.top_asins.length > 0 && (
            <div className="rv2-dossier-asins">
              <div className="rv2-dossier-subtitle">Top ASINs they win</div>
              <ul>
                {d.top_asins.map((a) => (
                  <li key={a.asin}>
                    <span className="rv2-asin">{a.asin}</span>
                    <span className="rv2-asin-title">
                      {a.title ?? "— not measured"}
                    </span>
                    <span className="rv2-asin-price">
                      {a.buy_box_price != null ? `$${Number(a.buy_box_price).toFixed(2)}` : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rv2-prose rv2-prose-callout">{paragraphs(d.risk_profile)}</div>
        </>
      ) : (
        <p className="rv2-muted">
          The dominant reseller share is below 20% — see the &ldquo;Top sellers&rdquo; chart in
          the Reseller Reality section for the full distribution.
        </p>
      )}
    </section>
  );
}

// ====================================================================
// Section 4 — CX Audit
// ====================================================================

function SectionCxAudit({ narrative }: { narrative: NarrativeV2 }) {
  const cx = narrative.cx_audit;
  const trend = cx.branded_trend_pct;
  return (
    <section id="s-cx" className="rv2-section rv2-section-alt">
      <SectionHead
        eyebrow="Customer Experience Audit"
        title="What customers see — and where it breaks"
        source="DataForSEO + Keepa listing signals"
      />

      <div className="rv2-stats-row">
        <Stat
          label="Branded searches/mo"
          value={cx.branded_search_volume != null ? formatVolume(cx.branded_search_volume) : "— not measured"}
        />
        <Stat
          label="YoY trend"
          value={trend != null ? `${trend > 0 ? "+" : ""}${trend.toFixed(1)}%` : "— not measured"}
        />
        <Stat label="Top ASINs scored" value={String(cx.asin_scores.length)} />
      </div>

      {cx.top_keywords.length > 0 && (
        <div className="rv2-block">
          <div className="rv2-block-title">Top non-branded keywords</div>
          <ul className="rv2-kwlist">
            {cx.top_keywords.map((k, i) => (
              <li key={`${k.keyword}-${i}`}>
                <span className="rv2-kw">{k.keyword}</span>
                <span className="rv2-kw-vol">
                  {k.search_volume != null ? `${formatVolume(k.search_volume)}/mo` : "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {cx.asin_scores.length > 0 && (
        <div className="rv2-asin-scores">
          {cx.asin_scores.map((a) => (
            <AsinScoreCard key={a.asin} score={a} />
          ))}
        </div>
      )}

      <div className="rv2-callouts">
        <div className="rv2-block-title">What's broken right now</div>
        <ul>
          {cx.whats_broken.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function AsinScoreCard({ score }: { score: CxAuditAsinScore }) {
  const pct = score.score ?? 0;
  return (
    <div className="rv2-asincard">
      <div className="rv2-asincard-top">
        <span className="rv2-asin">{score.asin}</span>
        <span className="rv2-asincard-score">{score.score != null ? `${score.score}/100` : "—"}</span>
      </div>
      {score.title && <div className="rv2-asincard-title">{score.title}</div>}
      <div className="rv2-asincard-bar">
        <div
          className="rv2-asincard-bar-fill"
          style={{ width: `${pct}%` }}
          aria-hidden
        />
      </div>
      <div className="rv2-asincard-note">
        Heuristic listing-health score. Full crawl (bullets, images, A+, video, reviews) runs in week one.
      </div>
    </div>
  );
}

// ====================================================================
// Section 5 — Competitor Benchmark
// ====================================================================

function SectionCompetitorBenchmark({ narrative }: { narrative: NarrativeV2 }) {
  const b = narrative.competitor_benchmark;
  return (
    <section id="s-bench" className="rv2-section">
      <SectionHead eyebrow="Competitive Benchmark" title="How you stack up on the same SERP" source="DataForSEO + Keepa" />

      <div className="rv2-table-wrap">
        <table className="rv2-table">
          <thead>
            <tr>
              <th>Brand</th>
              <th># Sellers</th>
              <th>Brand-controlled</th>
              <th>Branded vol/mo</th>
              <th>SERP rank</th>
              <th>Listing health</th>
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, i) => (
              <CompetitorTableRow key={`${r.brand}-${i}`} row={r} />
            ))}
          </tbody>
        </table>
      </div>

      {b.one_liner && <p className="rv2-prose">{b.one_liner}</p>}
    </section>
  );
}

function CompetitorTableRow({ row }: { row: CompetitorRow }) {
  return (
    <tr className={row.is_audited_brand ? "rv2-table-hi" : ""}>
      <td>
        <strong>{row.brand}</strong>
        {row.is_audited_brand && <span className="rv2-tag">You</span>}
      </td>
      <td>{row.unique_seller_count != null ? row.unique_seller_count : "—"}</td>
      <td>
        {row.brand_controlled_pct != null
          ? `${Math.round(row.brand_controlled_pct * 100)}%`
          : "—"}
      </td>
      <td>{row.branded_search_volume != null ? formatVolume(row.branded_search_volume) : "—"}</td>
      <td>{row.organic_serp_rank != null ? `#${row.organic_serp_rank}` : "—"}</td>
      <td>{row.listing_health != null ? `${row.listing_health}/100` : "—"}</td>
    </tr>
  );
}

// ====================================================================
// Section 6 — The Math (transparent)
// ====================================================================

function SectionMath({ narrative }: { narrative: NarrativeV2 }) {
  const m = narrative.math;
  return (
    <section id="s-math" className="rv2-section rv2-section-alt">
      <SectionHead
        eyebrow="The Math"
        title="Every number, every assumption"
        source="Editable per deal"
      />

      <div className="rv2-table-wrap">
        <table className="rv2-table rv2-math-table">
          <thead>
            <tr>
              <th>Line</th>
              <th>Value</th>
              <th>Source / Assumption</th>
            </tr>
          </thead>
          <tbody>
            {m.lines.map((l) => (
              <MathRow key={l.key} line={l} />
            ))}
          </tbody>
        </table>
      </div>

      {m.notes && <p className="rv2-prose rv2-prose-callout">{m.notes}</p>}
    </section>
  );
}

function MathRow({ line }: { line: MathLine }) {
  return (
    <tr className={line.is_total ? "rv2-math-total" : ""}>
      <td>{line.label}</td>
      <td className="rv2-num">{formatMath(line)}</td>
      <td>
        <span className={line.editable ? "rv2-tag rv2-tag-edit" : "rv2-muted-small"}>
          {line.source}
        </span>
      </td>
    </tr>
  );
}

function formatMath(line: MathLine): string {
  if (line.value == null) return "— not measured";
  if (line.format === "money") {
    return `$${Math.round(Number(line.value)).toLocaleString("en-US")}`;
  }
  if (line.format === "percent") {
    return `${(Number(line.value) * 100).toFixed(1)}%`;
  }
  return String(line.value);
}

// ====================================================================
// Section 7 — 90-day plan
// ====================================================================

function SectionPlan({ narrative }: { narrative: NarrativeV2 }) {
  const p = narrative.plan;
  return (
    <section id="s-plan" className="rv2-section">
      <SectionHead eyebrow="90-Day Takeover Plan" title="How we run it" />
      {p.intro && <p className="rv2-prose">{p.intro}</p>}
      <div className="rv2-plan-grid">
        {p.columns.map((col, i) => (
          <div key={i} className="rv2-plan-col">
            <div className="rv2-plan-label">{col.label}</div>
            <ul>
              {col.bullets.map((b, j) => (
                <li key={j}>{b}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

// ====================================================================
// Section 8 — Why RCG
// ====================================================================

function SectionWhyRcg({ narrative }: { narrative: NarrativeV2 }) {
  const w = narrative.why_rcg;
  return (
    <section id="s-why" className="rv2-section rv2-section-alt">
      <SectionHead eyebrow="Why RCG" title="Operators, not consultants" />
      <div className="rv2-prose">{paragraphs(w.bio)}</div>
      <div className="rv2-cases">
        {w.case_studies.map((c, i) => (
          <div key={i} className="rv2-case">
            <div className="rv2-case-name">{c.name}</div>
            <div className="rv2-case-summary">{c.summary}</div>
            <div className="rv2-case-metric">{c.metric}</div>
          </div>
        ))}
      </div>
      <div className="rv2-risk">
        <div className="rv2-risk-eyebrow">Risk reversal</div>
        <p>{w.risk_reversal}</p>
      </div>
    </section>
  );
}

// ====================================================================
// Section 9 — CTA
// ====================================================================

function SectionCta({ narrative, pdfUrl }: { narrative: NarrativeV2; pdfUrl: string | null }) {
  const c = narrative.cta;
  return (
    <section id="s-cta" className="rv2-section rv2-section-cta">
      <h2 className="rv2-h2">{c.headline}</h2>
      <p className="rv2-prose">
        Reply to the email this came in on, or grab a slot directly.
      </p>
      <p className="rv2-cta-contact">
        <a href={`mailto:${c.secondary_email}`}>{c.secondary_email}</a>
        {c.secondary_phone && (
          <>
            <br />
            {c.secondary_phone}
          </>
        )}
      </p>
      <div className="rv2-cta-actions">
        {c.primary_cta_url && (
          <a className="rv2-btn rv2-btn-primary" href={c.primary_cta_url} target="_blank" rel="noreferrer">
            {c.primary_cta_label}
          </a>
        )}
        {pdfUrl && (
          <a className="rv2-btn" href={pdfUrl} target="_blank" rel="noreferrer">
            Download the PDF
          </a>
        )}
      </div>
    </section>
  );
}

// ====================================================================
// Building blocks
// ====================================================================

function SectionHead({ eyebrow, title, source }: { eyebrow: string; title: string; source?: string }) {
  return (
    <div className="rv2-section-head">
      <div className="rv2-eyebrow">{eyebrow}</div>
      <h2 className="rv2-h2">{title}</h2>
      {source && <div className="rv2-source">{source}</div>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rv2-stat">
      <div className="rv2-stat-num">{value}</div>
      <div className="rv2-stat-lbl">{label}</div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rv2-fact">
      <div className="rv2-fact-lbl">{label}</div>
      <div className="rv2-fact-val">{value}</div>
    </div>
  );
}

// ====================================================================
// Helpers
// ====================================================================

// Amazon merchant IDs are 13-14 chars, all caps, start with "A".
// When Keepa doesn't return a friendly storefront name we'd otherwise
// show this raw ID to the prospect, which reads like a bug.
const AMAZON_SELLER_ID_RE = /^A[A-Z0-9]{12,13}$/;

function isAmazonSellerId(s: string | null | undefined): boolean {
  return !!s && AMAZON_SELLER_ID_RE.test(s.trim());
}

function friendlySellerName(name: string | null | undefined, fallbackId?: string | null): string {
  const n = (name ?? "").trim();
  if (!n) return "Unknown 3P seller";
  if (isAmazonSellerId(n)) return `Unknown 3P seller (ID: ${n})`;
  // Sometimes Keepa hands back a name plus the ID concatenated — keep the name.
  return n;
}

// Repair a previously-generated cover headline that contains the
// "annual reseller leak of — not measured" pattern. Existing rows in
// Supabase have already-baked headlines we can't re-run; this scrubs
// at render time without changing the stored narrative.
function repairCoverHeadline(raw: string, brandName: string): string {
  let s = raw;
  // 1. Replace seller-id tokens with friendly form.
  s = s.replace(/\bA[A-Z0-9]{12,13}\b/g, (id) => `Unknown 3P seller (ID: ${id})`);
  // 2. Soft-rewrite the broken-leak sentence shape.
  //    "<X> has an annual reseller leak of — not measured, with top reseller <Y> holding a <Z>% share."
  //    →  "<X> has measurable reseller exposure on Amazon: top reseller <Y> holds <Z>% buy-box share."
  const leakRe =
    /([\w\s'&.\-]+?)\s+has\s+an\s+annual\s+reseller\s+leak\s+of\s+(?:—|--|-)\s*not\s+measured,?\s*with\s+top\s+reseller\s+([^\s,]+(?:\s+\([^)]+\))?)\s+holding\s+a?\s*([\d.]+)%\s+share\.?/i;
  s = s.replace(leakRe, (_m, brand, seller, pct) => {
    return `${(brand ?? brandName).trim()} has measurable reseller exposure on Amazon: top reseller ${seller} holds ${pct}% of buy-box share.`;
  });
  // 3. Generic null-leak phrase cleanup if the regex above didn't match.
  s = s.replace(/annual reseller leak of (?:—|--|-)\s*not measured,?/i, "measurable reseller exposure on Amazon");
  return s.trim();
}

function formatVolume(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatShortDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

function formatLongDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

function paragraphs(md: string | null | undefined) {
  if (!md) return null;
  const ps = md.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  return ps.map((p, i) => <p key={i}>{p}</p>);
}

// ====================================================================
// Styles — RCG dark/cream palette, mobile responsive, print-friendly
// ====================================================================

function V2Styles() {
  return (
    <style>{`
      .rv2, .rv2 * { box-sizing: border-box; }
      .rv2 {
        --bg: #0b0b0d;
        --bg-alt: #111114;
        --bg-cream: #f7f5f0;
        --text: #f2f2f3;
        --text-muted: #9b9ba3;
        --gold: #c9a96a;
        --gold-soft: #d8b878;
        --red: #e07b5e;
        --green: #6cb98a;
        --border: rgba(255,255,255,0.08);
        --border-soft: rgba(255,255,255,0.05);
        background: var(--bg);
        color: var(--text);
        min-height: 100vh;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        line-height: 1.6;
        overflow-x: hidden;
        max-width: 100vw;
      }

      /* Layout: side nav on desktop, header + scroll on mobile */
      .rv2-main {
        max-width: 980px;
        margin: 0 auto;
        padding: 0 clamp(16px, 4vw, 24px);
        width: 100%;
      }
      .rv2-section {
        padding: clamp(40px, 8vw, 64px) 0;
        border-top: 1px solid var(--border-soft);
        position: relative;
      }
      .rv2-section:first-of-type { border-top: none; }
      /* Full-bleed alt background without the old -9999px margin hack
         (which created a 20k+ px element on mobile). Use a pseudo-element
         pinned to the viewport behind content. */
      .rv2-section-alt { background: var(--bg-alt); }
      .rv2-section-cover { padding-top: clamp(48px, 10vw, 96px); }
      .rv2-section-cta { padding: clamp(48px, 10vw, 96px) 0; text-align: center; }
      .rv2-section-head { max-width: 720px; margin-bottom: 28px; }

      .rv2-eyebrow {
        text-transform: uppercase; letter-spacing: 0.14em;
        font-size: 11px; color: var(--gold); font-weight: 600;
      }
      .rv2-source {
        margin-top: 6px; font-size: 12px; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.06em;
      }

      .rv2-h1, .rv2-h2 {
        color: var(--text); margin: 0;
        font-family: 'Fraunces', 'Inter', serif; font-weight: 600;
        letter-spacing: -0.02em;
        overflow-wrap: anywhere;
      }
      .rv2-h1 { font-size: clamp(28px, 6vw, 44px); line-height: 1.15; margin: 18px 0 0; }
      .rv2-h2 { font-size: clamp(22px, 4.5vw, 28px); line-height: 1.2; margin: 8px 0 6px; }

      .rv2-prose { font-size: 16px; line-height: 1.7; color: var(--text); margin: 16px 0; }
      .rv2-prose p { margin: 0 0 14px; }
      .rv2-prose-callout {
        background: rgba(201,169,106,0.06); border-left: 3px solid var(--gold);
        padding: 16px 18px; border-radius: 0 8px 8px 0;
      }
      .rv2-muted { color: var(--text-muted); }
      .rv2-muted-small { color: var(--text-muted); font-size: 12px; }

      /* Header */
      .rv2-hdr {
        position: sticky; top: 0; z-index: 20;
        background: rgba(11,11,13,0.85);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border-bottom: 1px solid var(--border-soft);
      }
      .rv2-hdr-row {
        display: flex; align-items: center; gap: 16px;
        padding: 14px clamp(16px, 4vw, 24px); max-width: 1200px; margin: 0 auto;
        flex-wrap: wrap;
      }
      .rv2-hdr-mid { min-width: 0; word-break: break-word; }
      .rv2-hdr-brand { display: inline-flex; align-items: center; }
      .rv2-hdr-logo { height: 28px; width: auto; }
      .rv2-hdr-mid { flex: 1; min-width: 0; }
      .rv2-hdr-title { font-weight: 600; color: var(--text); font-size: 14px; line-height: 1.2; }
      .rv2-hdr-sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
      .rv2-hdr-actions { display: flex; gap: 8px; }

      .rv2-btn {
        display: inline-block; padding: 9px 16px; border-radius: 8px;
        background: rgba(255,255,255,0.05); color: var(--text);
        border: 1px solid var(--border); font-size: 13px; font-weight: 500;
        text-decoration: none; transition: all 0.15s;
      }
      .rv2-btn:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.15); }
      .rv2-btn-primary {
        background: var(--gold); color: #1a1408; border-color: var(--gold); font-weight: 600;
      }
      .rv2-btn-primary:hover { background: var(--gold-soft); border-color: var(--gold-soft); }

      /* Side nav */
      .rv2-sidenav {
        display: none;
      }
      @media (min-width: 1180px) {
        .rv2-sidenav {
          display: block;
          position: fixed; left: 24px; top: 96px;
          width: 160px; z-index: 5;
        }
        .rv2-sidenav ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
        .rv2-sidenav a {
          color: var(--text-muted); font-size: 12px;
          text-decoration: none; padding: 4px 8px; display: block;
          border-left: 2px solid var(--border-soft);
        }
        .rv2-sidenav a:hover { color: var(--gold); border-left-color: var(--gold); }
      }

      /* Cover */
      .rv2-cover-row {
        display: flex; align-items: center; gap: 16px; margin-top: 12px;
        flex-wrap: wrap;
      }
      .rv2-cover-meta { min-width: 0; flex: 1; word-break: break-word; }
      .rv2-cover-logo {
        width: 64px; height: 64px; border-radius: 12px;
        background: rgba(255,255,255,0.05);
        border: 1px solid var(--border);
        display: flex; align-items: center; justify-content: center;
        overflow: hidden;
      }
      .rv2-cover-logo-img { max-width: 100%; max-height: 100%; }
      .rv2-cover-initials { color: var(--gold); font-weight: 700; font-size: 22px; letter-spacing: 0.04em; }
      .rv2-cover-meta-line { font-size: 14px; }

      .rv2-kpi-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 14px; margin-top: 36px;
      }
      .rv2-kpi {
        padding: 18px; border: 1px solid var(--border);
        background: rgba(255,255,255,0.02); border-radius: 12px;
      }
      .rv2-kpi-num {
        font-size: 30px; font-weight: 700; letter-spacing: -0.01em;
        color: var(--gold); font-variant-numeric: tabular-nums;
      }
      .rv2-kpi-lbl { font-size: 13px; color: var(--text); margin-top: 4px; }
      .rv2-kpi-sub { font-size: 11px; color: var(--text-muted); margin-top: 2px; }

      /* Reseller bars */
      .rv2-bars {
        display: grid; gap: 10px; margin-top: 4px;
        padding: 16px; border: 1px solid var(--border-soft);
        border-radius: 12px; background: rgba(255,255,255,0.015);
        min-width: 0;
      }
      .rv2-bar-row {
        display: grid;
        grid-template-columns: 22px minmax(0, 180px) minmax(0, 1fr) 56px 80px;
        gap: 10px; align-items: center;
        font-size: 13px;
        min-width: 0;
      }
      .rv2-bar-rank { color: var(--gold); font-weight: 600; }
      .rv2-bar-name {
        color: var(--text);
        min-width: 0;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .rv2-bar-track { height: 14px; background: rgba(255,255,255,0.04); border-radius: 4px; overflow: hidden; min-width: 0; }
      .rv2-bar-fill { height: 100%; background: linear-gradient(90deg, var(--gold), var(--gold-soft)); }
      .rv2-bar-val { text-align: right; color: var(--gold-soft); font-variant-numeric: tabular-nums; }
      .rv2-bar-asins { color: var(--text-muted); font-size: 11px; text-align: right; }

      .rv2-checklist {
        margin-top: 24px; padding: 18px;
        border: 1px solid var(--border-soft); border-radius: 10px;
        background: rgba(255,255,255,0.015);
      }
      .rv2-checklist-title { font-weight: 600; margin-bottom: 10px; font-size: 14px; }
      .rv2-checklist ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
      .rv2-checklist li { display: flex; align-items: center; gap: 10px; font-size: 14px; }
      .rv2-q {
        display: inline-flex; align-items: center; justify-content: center;
        width: 20px; height: 20px; border-radius: 4px;
        background: rgba(224,123,94,0.15); color: var(--red); font-weight: 700;
      }
      .rv2-checklist-note { color: var(--text-muted); font-size: 12px; margin-top: 10px; font-style: italic; }

      .rv2-bbpanel {
        margin-top: 24px; padding: 18px;
        border: 1px solid var(--border-soft); border-radius: 10px;
        background: rgba(255,255,255,0.015);
      }
      .rv2-bbpanel-title { font-weight: 600; margin-bottom: 12px; font-size: 14px; }
      .rv2-bbpanel-bar {
        display: flex; height: 36px; border-radius: 6px; overflow: hidden;
      }
      .rv2-bbpanel-brand { background: var(--gold); color: #1a1408; }
      .rv2-bbpanel-reseller { background: var(--red); color: #2a0e0a; }
      .rv2-bbpanel-brand, .rv2-bbpanel-reseller {
        display: flex; align-items: center; justify-content: center;
        font-size: 12px; font-weight: 600; min-width: 0; padding: 0 8px;
      }
      .rv2-bbpanel-note { color: var(--text-muted); font-size: 12px; margin-top: 8px; }

      /* Dossier */
      .rv2-dossier-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px;
      }
      .rv2-fact {
        padding: 14px; border: 1px solid var(--border-soft);
        border-radius: 10px; background: rgba(255,255,255,0.015);
      }
      .rv2-fact-lbl {
        font-size: 11px; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.08em;
      }
      .rv2-fact-val { font-size: 15px; color: var(--text); margin-top: 4px; }

      .rv2-dossier-asins { margin-top: 24px; }
      .rv2-dossier-subtitle {
        font-size: 12px; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px;
      }
      .rv2-dossier-asins ul { list-style: none; padding: 0; margin: 0; }
      .rv2-dossier-asins li {
        display: grid; grid-template-columns: 110px minmax(0, 1fr) 80px;
        gap: 12px; align-items: baseline;
        padding: 10px 0; border-bottom: 1px solid var(--border-soft);
        font-size: 14px;
        min-width: 0;
      }
      .rv2-asin {
        font-family: ui-monospace, SFMono-Regular, monospace;
        color: var(--gold); font-size: 12px; font-weight: 600;
        overflow-wrap: anywhere;
        word-break: break-all;
      }
      .rv2-asin-title { color: var(--text); min-width: 0; overflow-wrap: anywhere; }
      .rv2-asin-price { text-align: right; color: var(--gold-soft); font-variant-numeric: tabular-nums; }

      /* CX audit */
      .rv2-stats-row {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px; margin-bottom: 24px;
      }
      .rv2-stat {
        padding: 14px; border: 1px solid var(--border-soft);
        border-radius: 10px; background: rgba(255,255,255,0.015);
      }
      .rv2-stat-num { font-size: 22px; font-weight: 700; color: var(--gold); }
      .rv2-stat-lbl { font-size: 12px; color: var(--text); margin-top: 4px; }

      .rv2-block { margin: 16px 0; }
      .rv2-block-title {
        font-size: 12px; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 10px;
      }
      .rv2-kwlist { list-style: none; padding: 0; margin: 0; }
      .rv2-kwlist li {
        display: flex; justify-content: space-between; gap: 12px;
        padding: 8px 0; border-bottom: 1px solid var(--border-soft); font-size: 14px;
      }
      .rv2-kw { color: var(--text); }
      .rv2-kw-vol { color: var(--gold-soft); font-variant-numeric: tabular-nums; }

      .rv2-asin-scores {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px; margin-top: 16px;
      }
      .rv2-asincard {
        padding: 14px; border: 1px solid var(--border-soft);
        border-radius: 10px; background: rgba(255,255,255,0.015);
      }
      .rv2-asincard-top { display: flex; justify-content: space-between; align-items: baseline; }
      .rv2-asincard-score { color: var(--gold); font-weight: 700; font-variant-numeric: tabular-nums; }
      .rv2-asincard-title { font-size: 13px; color: var(--text); margin: 6px 0 8px; min-height: 32px; }
      .rv2-asincard-bar { height: 6px; background: rgba(255,255,255,0.04); border-radius: 3px; overflow: hidden; }
      .rv2-asincard-bar-fill { height: 100%; background: var(--gold); }
      .rv2-asincard-note { font-size: 11px; color: var(--text-muted); margin-top: 8px; }

      .rv2-callouts {
        margin-top: 24px; padding: 16px;
        border: 1px solid var(--border-soft); border-radius: 10px;
        background: rgba(255,255,255,0.015);
      }
      .rv2-callouts ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
      .rv2-callouts li {
        padding: 10px 14px; border-left: 2px solid var(--gold);
        background: rgba(201,169,106,0.06); color: var(--text); font-size: 14px;
        border-radius: 0 6px 6px 0;
      }

      /* Tables (benchmark + math) */
      .rv2-table-wrap {
        overflow-x: auto;
        max-width: 100%;
        -webkit-overflow-scrolling: touch;
        margin-left: -4px;
        margin-right: -4px;
        padding-left: 4px;
        padding-right: 4px;
      }
      .rv2-table {
        width: 100%; border-collapse: collapse; font-size: 14px;
        margin: 8px 0;
        min-width: 480px;
      }
      .rv2-table th, .rv2-table td {
        text-align: left; padding: 10px 12px;
        border-bottom: 1px solid var(--border-soft);
        overflow-wrap: anywhere;
      }
      .rv2-table th {
        font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
        color: var(--text-muted); font-weight: 600;
      }
      .rv2-table-hi { background: rgba(201,169,106,0.08); }
      .rv2-tag {
        display: inline-block; padding: 1px 6px; margin-left: 6px;
        border-radius: 4px; background: var(--gold); color: #1a1408;
        font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700;
      }
      .rv2-tag-edit {
        background: rgba(108,185,138,0.12); color: var(--green);
        margin-left: 0; padding: 2px 8px; font-weight: 600;
      }
      .rv2-num { text-align: right; font-variant-numeric: tabular-nums; color: var(--gold-soft); }
      .rv2-math-total td { font-weight: 700; color: var(--text); border-top: 1px solid var(--border); }
      .rv2-math-total .rv2-num { color: var(--gold); }

      /* Plan */
      .rv2-plan-grid {
        display: grid; grid-template-columns: repeat(3, 1fr);
        gap: 14px; margin-top: 16px;
      }
      .rv2-plan-col {
        padding: 18px; border: 1px solid var(--border-soft);
        border-radius: 10px; background: rgba(255,255,255,0.015);
      }
      .rv2-plan-label {
        font-size: 11px; color: var(--gold);
        text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;
        margin-bottom: 10px;
      }
      .rv2-plan-col ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
      .rv2-plan-col li {
        font-size: 13px; line-height: 1.5; padding-left: 14px; position: relative;
      }
      .rv2-plan-col li::before {
        content: ""; position: absolute; left: 0; top: 8px;
        width: 6px; height: 6px; border-radius: 50%; background: var(--gold);
      }

      /* Cases */
      .rv2-cases {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 12px; margin: 16px 0;
      }
      .rv2-case {
        padding: 18px; border: 1px solid var(--border-soft);
        border-radius: 10px; background: rgba(255,255,255,0.015);
      }
      .rv2-case-name { font-weight: 600; color: var(--text); }
      .rv2-case-summary { font-size: 14px; color: var(--text-muted); margin: 8px 0; line-height: 1.5; }
      .rv2-case-metric { color: var(--gold); font-size: 13px; font-weight: 600; }

      .rv2-risk {
        margin-top: 16px; padding: 18px;
        border: 1px solid rgba(201,169,106,0.4); border-radius: 10px;
        background: rgba(201,169,106,0.06);
      }
      .rv2-risk-eyebrow {
        font-size: 11px; color: var(--gold);
        text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;
        margin-bottom: 6px;
      }

      /* CTA */
      .rv2-cta-contact { font-size: 16px; color: var(--text); margin: 16px auto 24px; line-height: 1.7; }
      .rv2-cta-contact a { color: var(--gold); text-decoration: none; }
      .rv2-cta-actions {
        display: inline-flex; gap: 12px; flex-wrap: wrap; justify-content: center;
      }

      /* Footer */
      .rv2-footer {
        padding: 28px 24px; border-top: 1px solid var(--border-soft);
        color: var(--text-muted); font-size: 12px; text-align: center;
      }

      /* Mobile */
      @media (max-width: 720px) {
        .rv2-bar-row {
          grid-template-columns: 22px minmax(0, 1fr) 60px;
          row-gap: 4px;
        }
        .rv2-bar-asins, .rv2-bar-track {
          grid-column: 1 / -1;
          text-align: left;
        }
        .rv2-plan-grid { grid-template-columns: 1fr; }
        .rv2-dossier-asins li { grid-template-columns: 1fr; row-gap: 4px; }
        .rv2-dossier-asins .rv2-asin-price { text-align: left; }
        .rv2-bbpanel-bar {
          flex-direction: column;
          height: auto;
        }
        .rv2-bbpanel-brand, .rv2-bbpanel-reseller {
          width: 100% !important;
          min-height: 32px;
          padding: 6px 8px;
        }
        .rv2-cases { grid-template-columns: 1fr; }
        .rv2-stats-row { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
        .rv2-dossier-grid { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
        .rv2-asin-scores { grid-template-columns: 1fr; }
        .rv2-kpi-grid { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
        .rv2-cover-logo { width: 56px; height: 56px; }
        .rv2-hdr-actions .rv2-btn { padding: 7px 12px; font-size: 12px; }
        .rv2-section-head { margin-bottom: 20px; }
        .rv2-prose { font-size: 15px; }
      }
      @media (max-width: 480px) {
        .rv2-bar-row { grid-template-columns: 20px minmax(0, 1fr) 56px; }
        .rv2-kpi-grid, .rv2-stats-row, .rv2-dossier-grid { grid-template-columns: 1fr; }
        .rv2-hdr-row { padding: 12px 16px; }
        .rv2-hdr-mid { flex-basis: 100%; }
      }

      /* Print */
      @media print {
        .rv2 {
          background: #fff !important; color: #111 !important;
        }
        .rv2-hdr, .rv2-sidenav, .rv2-cta-actions { display: none !important; }
        .rv2-section { page-break-inside: avoid; padding: 24px 0; border-top: 1px solid #ddd; }
        .rv2-section-alt { background: #fafafa !important; }
        .rv2-h1, .rv2-h2, .rv2-prose, .rv2-stat-lbl, .rv2-fact-val, .rv2-asin-title,
        .rv2-bar-name, .rv2-table td, .rv2-table th, .rv2-callouts li, .rv2-plan-col li,
        .rv2-case-name, .rv2-case-summary, .rv2-cover-meta-line, .rv2-bbpanel-brand, .rv2-bbpanel-reseller {
          color: #111 !important;
        }
        .rv2-eyebrow, .rv2-source, .rv2-stat-num, .rv2-kpi-num, .rv2-asin, .rv2-bar-val,
        .rv2-asincard-score, .rv2-tag, .rv2-plan-label, .rv2-case-metric, .rv2-risk-eyebrow,
        .rv2-num, .rv2-asincard-bar-fill, .rv2-bar-fill, .rv2-bar-rank {
          color: #8a6d2e !important;
        }
        .rv2-muted, .rv2-fact-lbl, .rv2-asincard-note, .rv2-checklist-note, .rv2-bbpanel-note,
        .rv2-block-title, .rv2-dossier-subtitle, .rv2-muted-small {
          color: #555 !important;
        }
        .rv2-kpi, .rv2-stat, .rv2-fact, .rv2-asincard, .rv2-plan-col, .rv2-case, .rv2-bars,
        .rv2-checklist, .rv2-bbpanel, .rv2-callouts, .rv2-prose-callout, .rv2-risk {
          background: #fafafa !important; border-color: #ddd !important;
        }
        .rv2-bar-fill { background: #c9a96a !important; }
        .rv2-bbpanel-brand { background: #c9a96a !important; }
        .rv2-bbpanel-reseller { background: #d6d3cb !important; }
      }
    `}</style>
  );
}
