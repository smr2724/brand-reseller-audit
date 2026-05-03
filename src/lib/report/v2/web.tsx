/**
 * Phase 8 / v2.1 — Public web renderer for v2 audit reports.
 *
 * v2.1 reframe: opportunity-first, not feature-rich. Cover leads with
 * the recapture-without-growth thesis. CX section is now Top Products
 * & Listing Health (top 10 ASINs with revenue/units estimates).
 * Competitor benchmark is hidden from the rendered output (data stays
 * in the DB). The 90-day plan becomes the 5-step Capture framework
 * (6-12 months, no advertising/DTC/growth language). RCG credibility
 * is sprinkled across the report as small inline callouts instead of
 * stacked in a standalone "Why RCG" section.
 *
 * v1 reports still render via the old PublicReportView.
 */
/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import type { BrandEnrichmentBundle } from "@/lib/enrichment";
import type {
  CxAuditAsinScore,
  DiyStep,
  MathLine,
  NarrativeV2,
  PlanStep,
  ReportAssumptions,
  ResellerRow,
} from "./types";
import { DEFAULT_ASSUMPTIONS } from "./types";
import { LegionMathSection } from "./LegionMathSection";

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
  /** URL token used to namespace localStorage state for the editable
   * math input panel. */
  reportToken: string;
  /** Persisted ReportAssumptions for this report; falls back to
   * `DEFAULT_ASSUMPTIONS` when missing/legacy. */
  assumptions: ReportAssumptions | null;
}

const STRATEGY_CALL_MAILTO_SUBJECT = "Amazon%20opportunity%20call";
const STEVE_EMAIL = "steve@rollemanagementgroup.com";

function strategyCallHref(narrative: NarrativeV2, brandName: string): string {
  const calendly = narrative.cta?.primary_cta_url;
  if (calendly) return calendly;
  const subj = `${STRATEGY_CALL_MAILTO_SUBJECT}%20-%20${encodeURIComponent(brandName)}`;
  return `mailto:${STEVE_EMAIL}?subject=${subj}`;
}

export function PublicReportV2({ narrative, brand, bundle, pdfUrl, reportToken, assumptions }: PublicReportV2Props) {
  const callHref = strategyCallHref(narrative, brand.name);

  // Phase 24 — Report mode controls which sections render. Older reports
  // omit `report_mode`; treat as the default high_fit pitch.
  const isDiy = narrative.report_mode === "diy_fit";

  // Pull the seed values for the editable math input panel out of
  // narrative_json + the persisted ReportAssumptions row. Anything
  // missing falls back to DEFAULT_ASSUMPTIONS.
  const revenueLine = narrative.math.lines.find((l) => l.key === "revenue");
  const initialRevenue: number | null =
    typeof revenueLine?.value === "number" ? revenueLine.value : null;
  const revenueSource = revenueLine?.source ?? "Keepa";
  const revenueBadge = revenueLine?.badge ?? null;
  const a: ReportAssumptions = { ...DEFAULT_ASSUMPTIONS, ...(assumptions ?? {}) };
  const initialAssumptions = {
    reseller_markup_pct: a.reseller_markup_pct,
    outbound_shipping_pct: a.outbound_shipping_pct,
    outbound_shipping_payer: a.outbound_shipping_payer,
    reseller_net_margin_pct: a.reseller_net_margin_pct,
    current_profit_margin_pct: a.current_profit_margin_pct,
    ebitda_multiple: a.ebitda_multiple,
    labor_cost_override: a.labor_cost_override ?? null,
  };

  return (
    <div className="rv2">
      <V2Styles />
      <Header brand={brand} pdfUrl={pdfUrl} narrative={narrative} isDiy={isDiy} />
      <SideNav isDiy={isDiy} />

      <main className="rv2-main">
        {isDiy ? (
          <SectionDiyCover narrative={narrative} brand={brand} />
        ) : (
          <SectionCover narrative={narrative} brand={brand} callHref={callHref} />
        )}
        <SectionResellerReality narrative={narrative} bundle={bundle} />
        <SectionResellerDossier narrative={narrative} />
        <SectionTopProducts narrative={narrative} />
        {isDiy ? (
          <SectionDiySteps narrative={narrative} />
        ) : (
          <>
            <LegionMathSection
              reportToken={reportToken}
              initialRevenue={initialRevenue}
              initialAssumptions={initialAssumptions}
              revenueSource={revenueSource}
              revenueBadge={revenueBadge ?? null}
              revenueFootnote={extractRevenueFootnote(narrative.math.notes ?? "")}
              notes={cleanMathNotes(narrative.math.notes ?? "") || null}
            />
            <SectionPlan narrative={narrative} />
          </>
        )}
        {isDiy ? (
          <SectionDiyFooterCta narrative={narrative} brand={brand} pdfUrl={pdfUrl} callHref={callHref} />
        ) : (
          <SectionFooterCta narrative={narrative} brand={brand} pdfUrl={pdfUrl} callHref={callHref} />
        )}
      </main>

      <footer className="rv2-footer">
        © {new Date().getFullYear()} Rolle Consulting Group · Confidential audit prepared for {brand.name}
      </footer>
    </div>
  );
}

/** assemble.ts appends `\n\nRevenue note: …` when the figure is from the
 * estimator. Pull that out so the LegionMathSection can render it
 * separately under Tier 2. */
function extractRevenueFootnote(notes: string): string | null {
  const m = notes.match(/Revenue note:\s*([\s\S]*)$/);
  return m ? m[1].trim() : null;
}
function cleanMathNotes(notes: string): string {
  return notes.replace(/\n*Revenue note:[\s\S]*$/, "").trim();
}

// ====================================================================
// Header (sticky)
// ====================================================================

function Header({
  brand,
  pdfUrl,
  narrative,
  isDiy,
}: {
  brand: PublicReportV2Brand;
  pdfUrl: string | null;
  narrative: NarrativeV2;
  isDiy?: boolean;
}) {
  // DIY mode keeps the same header chrome but reframes the subtitle —
  // "Channel Ownership Recommendations" lands warmer than "Audit" when
  // the report is congratulating the brand on already running a tight
  // channel.
  const subtitle = isDiy
    ? `Channel Ownership Recommendations · ${formatShortDate(narrative.generated_at)}`
    : `Channel Ownership Audit · ${formatShortDate(narrative.generated_at)}`;
  return (
    <header className="rv2-hdr">
      <div className="rv2-hdr-row">
        <Link href="/" className="rv2-hdr-brand">
          <img src="/rmg-logo-white.png" alt="Rolle Consulting Group" className="rv2-hdr-logo" />
          <span className="rv2-hdr-wordmark">Rolle Consulting Group</span>
        </Link>
        <div className="rv2-hdr-mid">
          <div className="rv2-hdr-title">{brand.name}</div>
          <div className="rv2-hdr-sub">{subtitle}</div>
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

function SideNav({ isDiy }: { isDiy?: boolean }) {
  const items: [string, string][] = isDiy
    ? [
        ["s-cover", "The good news"],
        ["s-reseller-reality", "Reseller reality"],
        ["s-dossier", "Reseller dossier"],
        ["s-products", "Top products"],
        ["s-diy", "3 steps to wrap this up"],
        ["s-cta", "Want help later?"],
      ]
    : [
        ["s-cover", "The opportunity"],
        ["s-reseller-reality", "Reseller reality"],
        ["s-dossier", "Reseller dossier"],
        ["s-products", "Top products"],
        ["s-math", "The math"],
        ["s-plan", "Capture plan"],
        ["s-cta", "Book a call"],
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
// Section 1 — Cover (opportunity-first headline + 2 big stats)
// ====================================================================

function SectionCover({
  narrative,
  brand,
  callHref,
}: {
  narrative: NarrativeV2;
  brand: PublicReportV2Brand;
  callHref: string;
}) {
  const c = narrative.cover;
  const profit = c.delta_profit ?? null;
  const value = c.exit_lift ?? null;

  // Always render the new opportunity-first headline at render time, even
  // for legacy narrative_json rows whose `cover.headline` was generated
  // under the old "you're losing $X" template.
  const headline = renderOpportunityHeadline(brand.name, profit, value);

  return (
    <section id="s-cover" className="rv2-section rv2-section-cover">
      <div className="rv2-eyebrow">Channel Ownership Audit</div>
      <div className="rv2-cover-meta">
        <div className="rv2-cover-meta-line">Prepared for {brand.name}</div>
        <div className="rv2-cover-meta-line rv2-muted">
          {formatLongDate(narrative.generated_at)} · By Rolle Consulting Group
        </div>
      </div>
      <h1 className="rv2-h1">{headline}</h1>

      <div className="rv2-kpi-grid rv2-kpi-grid-2">
        <BigStat
          label="Annual profit recovered"
          value={profit != null ? money(profit) : "— not measured"}
          sub="Recoverable margin + ops + fulfillment, transparent math below"
        />
        <BigStat
          label="Business value created"
          value={value != null ? money(value) : "— not measured"}
          sub="7× EBITDA on the new annual profit"
        />
      </div>

      <RcgCallout
        kicker="Track record"
        body={
          <>
            Steve, RCG's founder, took <strong>Diversified Hospitality Solutions</strong> from a reseller-fragmented brand to <strong>$8.34M (2022) → $9.02M (2023)</strong> in Amazon revenue and <strong>~2× business valuation</strong> — by capturing existing demand and removing resellers, with no new customer acquisition.
          </>
        }
      />

      <div className="rv2-cover-actions">
        <a className="rv2-btn rv2-btn-primary" href={callHref}>
          Book a strategy call
        </a>
      </div>
    </section>
  );
}

function renderOpportunityHeadline(
  brandName: string,
  profit: number | null,
  value: number | null,
): string {
  if (profit != null && value != null) {
    return `${brandName}, you can recapture ${money(profit)} in annual profit and ${money(value)} in business value — without adding a single new customer.`;
  }
  if (profit != null) {
    return `${brandName}, you can recapture ${money(profit)} in annual profit — without adding a single new customer.`;
  }
  return `${brandName}, you can recapture significant profit and business value from your Amazon channel — without adding a single new customer.`;
}

function BigStat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rv2-bigstat">
      <div className="rv2-bigstat-num">{value}</div>
      <div className="rv2-bigstat-lbl">{label}</div>
      <div className="rv2-bigstat-sub">{sub}</div>
    </div>
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
  const sellerCount =
    narrative.reseller_reality.top_sellers.length || null;
  const inverseBrandPct =
    d?.share_pct != null ? Math.round(d.share_pct * 100) : null;

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
            <Fact label="Country" value={prettyCountry(d.country) ?? "— not measured"} />
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

          <RcgCallout
            kicker="What we do here"
            body={
              <>
                {sellerCount ?? "Multiple"} unauthorized resellers controlling{" "}
                <strong>
                  {inverseBrandPct != null ? `${inverseBrandPct}%+` : "most"}
                </strong>{" "}
                of your buy box. We've removed resellers for Diversified Hospitality and dozens of other brands without disrupting wholesale relationships — written terms, MAP enforcement, sequenced cutovers.
              </>
            }
          />
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
// Section 4 — Top Products & Listing Health (per-ASIN economics)
// ====================================================================

function SectionTopProducts({ narrative }: { narrative: NarrativeV2 }) {
  const cx = narrative.cx_audit;
  // Cards are sorted by revenue desc and capped at 10. Older
  // narrative_json may have only 3 — we keep what's there.
  const sorted = cx.asin_scores
    .slice()
    .sort((a, b) => (b.ttm_revenue ?? -1) - (a.ttm_revenue ?? -1))
    .slice(0, 10);

  return (
    <section id="s-products" className="rv2-section rv2-section-alt">
      <SectionHead
        eyebrow="Top Products & Listing Health"
        title="Where the demand sits — and what each listing looks like"
        source="Keepa /product · BSR + price · 365-day avg"
      />

      {sorted.length > 0 ? (
        <div className="rv2-asin-scores rv2-asin-scores-wide">
          {sorted.map((a) => (
            <AsinScoreCard key={a.asin} score={a} />
          ))}
        </div>
      ) : (
        <p className="rv2-muted">
          Top product economics — not measured this run.
        </p>
      )}

      {cx.whats_broken.length > 0 && (
        <div className="rv2-callouts">
          <div className="rv2-block-title">What's broken right now</div>
          <ul>
            {cx.whats_broken.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="rv2-muted-small">
        Per-ASIN revenue and units are directional estimates from Keepa BSR + buy-box price (365-day avg). Replace with seller's actual TTM during diligence.
      </p>
    </section>
  );
}

function AsinScoreCard({ score }: { score: CxAuditAsinScore }) {
  const facts: { label: string; value: string }[] = [];
  if (score.images != null) facts.push({ label: "Images", value: String(score.images) });
  if (score.bullets != null) facts.push({ label: "Bullets", value: String(score.bullets) });
  if (score.rating != null) facts.push({ label: "Rating", value: score.rating.toFixed(1) });
  if (score.reviews != null)
    facts.push({ label: "Reviews", value: score.reviews.toLocaleString("en-US") });
  if (score.has_a_plus != null) facts.push({ label: "A+", value: score.has_a_plus ? "Yes" : "No" });
  if (score.has_video != null)
    facts.push({ label: "Video", value: score.has_video ? "Yes" : "No" });
  return (
    <div className="rv2-asincard">
      <div className="rv2-asincard-top">
        <span className="rv2-asin">{score.asin}</span>
        <span className="rv2-rev-badge rv2-rev-badge-est" title="Directional estimate from Keepa BSR + buy-box price">
          Estimate
        </span>
      </div>
      {score.title && <div className="rv2-asincard-title">{score.title}</div>}
      <div className="rv2-asincard-econ">
        <div className="rv2-asincard-econ-row">
          <span className="rv2-asincard-econ-lbl">TTM revenue</span>
          <span className="rv2-asincard-econ-val">
            {score.ttm_revenue != null ? money(score.ttm_revenue) : "— not measured"}
          </span>
        </div>
        <div className="rv2-asincard-econ-row">
          <span className="rv2-asincard-econ-lbl">TTM units</span>
          <span className="rv2-asincard-econ-val">
            {score.ttm_units != null ? Math.round(score.ttm_units).toLocaleString("en-US") : "— not measured"}
          </span>
        </div>
        {score.buy_box_price != null && (
          <div className="rv2-asincard-econ-row">
            <span className="rv2-asincard-econ-lbl">Buy-box price</span>
            <span className="rv2-asincard-econ-val">${score.buy_box_price.toFixed(2)}</span>
          </div>
        )}
      </div>
      {score.score != null && (
        <div className="rv2-asincard-health">
          <div className="rv2-asincard-health-lbl">
            Listing health <span className="rv2-asincard-health-val">{score.score}/100</span>
          </div>
          <div className="rv2-asincard-bar">
            <div
              className="rv2-asincard-bar-fill"
              style={{ width: `${score.score}%` }}
              aria-hidden
            />
          </div>
        </div>
      )}
      {facts.length > 0 && (
        <div className="rv2-asincard-facts">
          {facts.map((f) => (
            <span key={f.label} className="rv2-asincard-fact">
              <span className="rv2-asincard-fact-lbl">{f.label}</span>
              <span className="rv2-asincard-fact-val">{f.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Section 5 — The Math — rendered by `LegionMathSection` (client). See
// `./LegionMathSection.tsx` for the two-tier disclosure + editable
// input panel.

// ====================================================================
// Section 6 — 6-12 Month Capture Plan (Five-Step Framework)
// ====================================================================

function SectionPlan({ narrative }: { narrative: NarrativeV2 }) {
  const p = narrative.plan;
  const steps = p.steps && p.steps.length === 5 ? p.steps : null;

  return (
    <section id="s-plan" className="rv2-section rv2-section-alt">
      <SectionHead
        eyebrow="6–12 Month Capture Plan"
        title="The Five-Step Framework"
      />
      {p.intro && <p className="rv2-prose">{p.intro}</p>}

      {steps ? (
        <div className="rv2-fivestep">
          {steps.map((s, i) => (
            <PlanStepCard
              key={s.number}
              step={s}
              callout={i === 3 ? "step4" : i === 4 ? "step5" : null}
            />
          ))}
        </div>
      ) : (
        // Legacy 90-day shape — keeps older reports rendering during the
        // backfill window.
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
      )}

      {p.closing && (
        <p className="rv2-prose rv2-plan-closing">{p.closing}</p>
      )}
    </section>
  );
}

function PlanStepCard({
  step,
  callout,
}: {
  step: PlanStep;
  callout: "step4" | "step5" | null;
}) {
  return (
    <div className="rv2-step">
      <div className="rv2-step-head">
        <div className="rv2-step-num">Step {step.number}</div>
        <div className="rv2-step-title">{step.title}</div>
      </div>
      <p className="rv2-step-body">{step.body}</p>
      {callout === "step4" && (
        <RcgCallout
          kicker="Case study"
          body={
            <>
              When we did this for Diversified Hospitality, customer experience metrics improved immediately and Amazon sales went from <strong>$8.34M (2022)</strong> to <strong>$9.02M (2023)</strong> — without adding a single new customer. They also paid down $5M in AP from the recovered margin.
            </>
          }
        />
      )}
      {callout === "step5" && (
        <RcgCallout
          kicker="Team model"
          body={
            <>
              Your team will typically be <strong>1-2 US-based members</strong> supported by offshore for logistics, ops, customer service, and listing management — the same model that runs Diversified Hospitality today.
            </>
          }
        />
      )}
    </div>
  );
}

// ====================================================================
// Section 7 — Footer CTA + Steve bio block
// ====================================================================

function SectionFooterCta({
  narrative,
  brand,
  pdfUrl,
  callHref,
}: {
  narrative: NarrativeV2;
  brand: PublicReportV2Brand;
  pdfUrl: string | null;
  callHref: string;
}) {
  const c = narrative.cta;
  return (
    <section id="s-cta" className="rv2-section rv2-section-cta">
      <h2 className="rv2-h2">
        Book a strategy call to walk through these numbers and your 6–12 month plan.
      </h2>
      <p className="rv2-prose rv2-cta-prose">
        No high-pressure sales — we'll walk the math line-by-line, talk through
        the reseller list, and answer questions. The report sells the result; this
        call just opens the door.
      </p>

      <div className="rv2-cta-actions">
        <a className="rv2-btn rv2-btn-primary" href={callHref}>
          Book a strategy call
        </a>
        {pdfUrl && (
          <a className="rv2-btn" href={pdfUrl} target="_blank" rel="noreferrer">
            Download the PDF
          </a>
        )}
      </div>

      <div className="rv2-bio">
        <div className="rv2-bio-name">Steve Rolle · Founder, Rolle Consulting Group</div>
        <p className="rv2-bio-body">
          Brand owner who doubled the value of Diversified Hospitality Solutions on
          Amazon by reclaiming control from resellers — taking it from a
          reseller-fragmented catalog to <strong>$9.02M (2023)</strong> in revenue and
          paying down $5M in AP from the recovered margin. RCG is the consulting
          group that productized that playbook. We work performance-based on the
          additional first-year profit we generate; if we don't add profit, we
          don't get paid.
        </p>
        <p className="rv2-cta-contact">
          <a href={`mailto:${c.secondary_email}`}>{c.secondary_email}</a>
          {c.secondary_phone && (
            <>
              {" · "}
              {c.secondary_phone}
            </>
          )}
        </p>
      </div>
    </section>
  );
}

// ====================================================================
// Phase 24 — DIY-mode sections (rendered only when narrative.report_mode
// === 'diy_fit'). The brand is already running a tight Amazon channel;
// the residual reseller share is too small to justify RCG fees, so we
// drop the capture plan / WHY-RCG callouts / math section in favor of a
// friendly "wrap this up yourself" 3-step list. Reseller dossier + CX +
// keywords + competitors stay because they're genuinely useful info.
// ====================================================================

function SectionDiyCover({
  narrative,
  brand,
}: {
  narrative: NarrativeV2;
  brand: PublicReportV2Brand;
}) {
  const pct = narrative.brand_controlled_pct ?? null;
  const pctLabel =
    pct != null ? `${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%` : "most";
  const headline =
    narrative.cover.headline ||
    `${brand.name}, you're already running a tight Amazon channel.`;
  return (
    <section id="s-cover" className="rv2-section rv2-section-cover">
      <div className="rv2-eyebrow">Channel Ownership Recommendations</div>
      <div className="rv2-cover-meta">
        <div className="rv2-cover-meta-line">Prepared for {brand.name}</div>
        <div className="rv2-cover-meta-line rv2-muted">
          {formatLongDate(narrative.generated_at)} · By Rolle Consulting Group
        </div>
      </div>
      <h1 className="rv2-h1">{headline}</h1>

      <div className="rv2-kpi-grid rv2-kpi-grid-1">
        <BigStat
          label={`You already control ${pctLabel} of your own Amazon sales — that's strong.`}
          value={pctLabel}
          sub="Buy-box ownership across your top SKUs · Keepa"
        />
      </div>

      <p className="rv2-prose rv2-cta-prose">
        Below: who's left on your listings, what they're shipping, and three concrete steps to seal the leak yourself.
      </p>
    </section>
  );
}

function SectionDiySteps({ narrative }: { narrative: NarrativeV2 }) {
  const steps: DiyStep[] = narrative.diy_steps ?? [];
  if (!steps.length) return null;
  return (
    <section id="s-diy" className="rv2-section rv2-section-alt">
      <SectionHead
        eyebrow="3 steps to wrap this up yourself"
        title="How to seal the residual reseller leakage"
      />
      <div className="rv2-fivestep">
        {steps.map((s) => (
          <div key={s.number} className="rv2-step">
            <div className="rv2-step-head">
              <div className="rv2-step-num">Step {s.number}</div>
              <div className="rv2-step-title">{s.title}</div>
            </div>
            <p className="rv2-step-body">{s.body}</p>
          </div>
        ))}
      </div>
      <p className="rv2-prose rv2-plan-closing">
        Most brands at this stage close the residual leakage in 30–60 days using just these three moves. No agency needed.
      </p>
    </section>
  );
}

function SectionDiyFooterCta({
  narrative,
  brand,
  pdfUrl,
  callHref,
}: {
  narrative: NarrativeV2;
  brand: PublicReportV2Brand;
  pdfUrl: string | null;
  callHref: string;
}) {
  const c = narrative.cta;
  return (
    <section id="s-cta" className="rv2-section rv2-section-cta">
      <h2 className="rv2-h2">
        When you're ready to scale or want a hand executing on this, we're a click away.
      </h2>
      <p className="rv2-prose rv2-cta-prose">
        Most brands at {brand.name}'s stage don't need a consultant — they just need a clean plan. If you'd like a second pair of eyes later, the strategy call is free and we'll walk through whatever you're seeing.
      </p>

      <div className="rv2-cta-actions">
        <a className="rv2-btn" href={callHref}>
          Book a free strategy call
        </a>
        {pdfUrl && (
          <a className="rv2-btn" href={pdfUrl} target="_blank" rel="noreferrer">
            Download the PDF
          </a>
        )}
      </div>

      <p className="rv2-cta-contact rv2-muted">
        <a href={`mailto:${c.secondary_email}`}>{c.secondary_email}</a>
      </p>
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

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rv2-fact">
      <div className="rv2-fact-lbl">{label}</div>
      <div className="rv2-fact-val">{value}</div>
    </div>
  );
}

function RcgCallout({
  kicker,
  body,
}: {
  kicker: string;
  body: React.ReactNode;
}) {
  return (
    <aside className="rv2-rcg-callout">
      <div className="rv2-rcg-callout-kicker">{kicker}</div>
      <div className="rv2-rcg-callout-body">{body}</div>
    </aside>
  );
}

// ====================================================================
// Helpers
// ====================================================================

const AMAZON_SELLER_ID_RE = /^A[A-Z0-9]{12,13}$/;

function isAmazonSellerId(s: string | null | undefined): boolean {
  return !!s && AMAZON_SELLER_ID_RE.test(s.trim());
}

function friendlySellerName(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  if (!n) return "Unknown 3P seller";
  if (isAmazonSellerId(n)) return `Unknown 3P seller (ID: ${n})`;
  return n;
}

const COUNTRY_NAMES: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  UK: "United Kingdom",
  CA: "Canada",
  DE: "Germany",
  FR: "France",
  IT: "Italy",
  ES: "Spain",
  JP: "Japan",
  AU: "Australia",
  MX: "Mexico",
  CN: "China",
  IN: "India",
  BR: "Brazil",
  NL: "Netherlands",
  PL: "Poland",
  SE: "Sweden",
  TR: "Turkey",
  AE: "United Arab Emirates",
  SG: "Singapore",
  HK: "Hong Kong",
  TW: "Taiwan",
  KR: "South Korea",
};

function prettyCountry(c: string | null | undefined): string | null {
  if (!c) return null;
  const k = c.trim().toUpperCase();
  if (!k) return null;
  return COUNTRY_NAMES[k] ?? k;
}

function money(n: number | null | undefined): string {
  if (n == null) return "— not measured";
  return `$${Math.round(Number(n)).toLocaleString("en-US")}`;
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
      .rv2-hdr-brand {
        display: inline-flex; align-items: center; gap: 8px;
        text-decoration: none;
      }
      .rv2-hdr-logo { height: 28px; width: auto; }
      .rv2-hdr-wordmark {
        color: var(--text); font-size: 13px; font-weight: 600;
        letter-spacing: 0.02em; white-space: nowrap;
      }
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
      .rv2-sidenav { display: none; }
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
      .rv2-cover-meta { margin-top: 12px; min-width: 0; word-break: break-word; }
      .rv2-cover-meta-line { font-size: 14px; }
      .rv2-cover-actions { margin-top: 28px; }

      .rv2-kpi-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 14px; margin-top: 36px;
      }
      .rv2-kpi-grid-2 {
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }
      .rv2-kpi-grid-1 {
        grid-template-columns: 1fr;
        max-width: 560px;
      }

      /* Big stats on the cover */
      .rv2-bigstat {
        padding: 24px; border: 1px solid var(--border);
        background: rgba(255,255,255,0.02); border-radius: 14px;
      }
      .rv2-bigstat-num {
        font-size: clamp(34px, 6vw, 48px); font-weight: 700; letter-spacing: -0.02em;
        color: var(--gold); font-variant-numeric: tabular-nums; line-height: 1.1;
      }
      .rv2-bigstat-lbl {
        font-size: 14px; color: var(--text); margin-top: 6px; font-weight: 600;
      }
      .rv2-bigstat-sub { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

      /* RCG credibility callouts (sprinkled throughout) */
      .rv2-rcg-callout {
        margin: 24px 0;
        padding: 14px 18px;
        border-left: 3px solid var(--gold);
        border-top: 1px solid rgba(201,169,106,0.18);
        border-right: 1px solid rgba(201,169,106,0.18);
        border-bottom: 1px solid rgba(201,169,106,0.18);
        background: linear-gradient(180deg, rgba(201,169,106,0.10), rgba(201,169,106,0.04));
        border-radius: 0 8px 8px 0;
        font-size: 13px; line-height: 1.55;
      }
      .rv2-rcg-callout-kicker {
        font-size: 10px; color: var(--gold);
        text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700;
        margin-bottom: 4px;
      }
      .rv2-rcg-callout-body { color: var(--text); }
      .rv2-rcg-callout-body strong { color: var(--gold-soft); font-weight: 600; }

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

      /* Top products / ASIN cards */
      .rv2-asin-scores {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 14px; margin-top: 16px;
      }
      .rv2-asin-scores-wide {
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }
      .rv2-asincard {
        padding: 16px; border: 1px solid var(--border-soft);
        border-radius: 10px; background: rgba(255,255,255,0.015);
        display: flex; flex-direction: column; gap: 10px;
      }
      .rv2-asincard-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
      .rv2-asincard-title { font-size: 13px; color: var(--text); line-height: 1.45; min-height: 32px; }
      .rv2-asincard-econ {
        display: grid; gap: 4px;
        padding: 10px 12px; border-radius: 8px;
        background: rgba(201,169,106,0.06);
        border: 1px solid rgba(201,169,106,0.18);
      }
      .rv2-asincard-econ-row {
        display: flex; justify-content: space-between; align-items: baseline;
        gap: 8px; font-size: 13px;
      }
      .rv2-asincard-econ-lbl { color: var(--text-muted); }
      .rv2-asincard-econ-val { color: var(--gold-soft); font-weight: 600; font-variant-numeric: tabular-nums; }
      .rv2-asincard-health { display: grid; gap: 4px; }
      .rv2-asincard-health-lbl {
        font-size: 11px; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.06em;
        display: flex; justify-content: space-between;
      }
      .rv2-asincard-health-val { color: var(--gold); font-weight: 700; letter-spacing: 0; text-transform: none; }
      .rv2-asincard-bar { height: 6px; background: rgba(255,255,255,0.04); border-radius: 3px; overflow: hidden; }
      .rv2-asincard-bar-fill { height: 100%; background: var(--gold); }
      .rv2-asincard-facts {
        display: flex; flex-wrap: wrap; gap: 6px;
      }
      .rv2-asincard-fact {
        display: inline-flex; align-items: baseline; gap: 4px;
        padding: 3px 8px; border-radius: 6px;
        background: rgba(255,255,255,0.04);
        border: 1px solid var(--border-soft);
        font-size: 11px;
      }
      .rv2-asincard-fact-lbl { color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-size: 10px; }
      .rv2-asincard-fact-val { color: var(--gold-soft); font-variant-numeric: tabular-nums; font-weight: 600; }

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
      .rv2-block-title {
        font-size: 12px; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 10px;
      }

      /* Tables */
      .rv2-table-wrap {
        width: 100%;
        max-width: 100%;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        box-sizing: border-box;
      }
      .rv2-table-wrap > .rv2-table { min-width: 480px; }
      .rv2-table {
        width: 100%; border-collapse: collapse; font-size: 14px;
        margin: 8px 0;
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

      /* Revenue actual/estimate badges */
      .rv2-rev-badge {
        display: inline-block; margin-left: 8px;
        padding: 2px 8px; border-radius: 999px;
        font-size: 10px; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.08em;
        vertical-align: middle;
      }
      .rv2-rev-badge-actual {
        background: rgba(108,185,138,0.15); color: var(--green);
        border: 1px solid rgba(108,185,138,0.4);
      }
      .rv2-rev-badge-est {
        background: rgba(224,170,76,0.15); color: var(--gold-soft);
        border: 1px solid rgba(224,170,76,0.4);
      }

      /* Five-step plan */
      .rv2-fivestep {
        display: grid; gap: 14px; margin-top: 16px;
      }
      .rv2-step {
        padding: 20px; border: 1px solid var(--border-soft);
        border-radius: 12px; background: rgba(255,255,255,0.015);
      }
      .rv2-step-head {
        display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px;
        flex-wrap: wrap;
      }
      .rv2-step-num {
        font-size: 11px; color: var(--gold);
        text-transform: uppercase; letter-spacing: 0.12em; font-weight: 700;
      }
      .rv2-step-title {
        font-size: 17px; color: var(--text); font-weight: 600;
        font-family: 'Fraunces', 'Inter', serif;
      }
      .rv2-step-body { font-size: 14.5px; color: var(--text); margin: 0; line-height: 1.6; }
      .rv2-plan-closing {
        margin-top: 20px; padding: 16px 20px;
        border-left: 3px solid var(--gold);
        background: rgba(201,169,106,0.06);
        border-radius: 0 8px 8px 0;
        font-style: italic;
      }

      /* Legacy 90-day plan */
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

      /* Bio + CTA */
      .rv2-cta-prose { max-width: 620px; margin: 16px auto 24px; color: var(--text-muted); }
      .rv2-cta-actions {
        display: inline-flex; gap: 12px; flex-wrap: wrap; justify-content: center;
      }
      .rv2-bio {
        max-width: 640px; margin: 40px auto 0;
        padding: 22px; border: 1px solid var(--border-soft);
        border-radius: 12px; background: rgba(255,255,255,0.015);
        text-align: left;
      }
      .rv2-bio-name {
        font-weight: 600; color: var(--text); font-size: 15px; margin-bottom: 8px;
      }
      .rv2-bio-body { font-size: 14px; color: var(--text); line-height: 1.65; margin: 0 0 12px; }
      .rv2-bio-body strong { color: var(--gold-soft); font-weight: 600; }
      .rv2-cta-contact { font-size: 14px; color: var(--text); margin: 0; }
      .rv2-cta-contact a { color: var(--gold); text-decoration: none; }

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
        .rv2-dossier-grid { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
        .rv2-asin-scores, .rv2-asin-scores-wide { grid-template-columns: 1fr; }
        .rv2-kpi-grid, .rv2-kpi-grid-2 { grid-template-columns: 1fr; }
        .rv2-hdr-actions .rv2-btn { padding: 7px 12px; font-size: 12px; }
        .rv2-hdr-wordmark { display: none; }
        .rv2-section-head { margin-bottom: 20px; }
        .rv2-prose { font-size: 15px; }
      }
      @media (max-width: 480px) {
        .rv2-bar-row { grid-template-columns: 20px minmax(0, 1fr) 56px; }
        .rv2-dossier-grid { grid-template-columns: 1fr; }
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
        .rv2-h1, .rv2-h2, .rv2-prose, .rv2-fact-val, .rv2-asin-title,
        .rv2-bar-name, .rv2-table td, .rv2-table th, .rv2-callouts li, .rv2-plan-col li,
        .rv2-step-title, .rv2-step-body, .rv2-bio-name, .rv2-bio-body, .rv2-bigstat-lbl,
        .rv2-cover-meta-line, .rv2-bbpanel-brand, .rv2-bbpanel-reseller, .rv2-rcg-callout-body {
          color: #111 !important;
        }
        .rv2-eyebrow, .rv2-source, .rv2-bigstat-num, .rv2-asin, .rv2-bar-val,
        .rv2-asincard-health-val, .rv2-tag, .rv2-plan-label, .rv2-step-num, .rv2-rcg-callout-kicker,
        .rv2-num, .rv2-asincard-bar-fill, .rv2-bar-fill, .rv2-bar-rank, .rv2-asincard-econ-val {
          color: #8a6d2e !important;
        }
        .rv2-muted, .rv2-fact-lbl, .rv2-asincard-note, .rv2-checklist-note, .rv2-bbpanel-note,
        .rv2-block-title, .rv2-dossier-subtitle, .rv2-muted-small, .rv2-bigstat-sub {
          color: #555 !important;
        }
        .rv2-bigstat, .rv2-fact, .rv2-asincard, .rv2-plan-col, .rv2-step, .rv2-bars,
        .rv2-checklist, .rv2-bbpanel, .rv2-callouts, .rv2-prose-callout, .rv2-rcg-callout, .rv2-bio {
          background: #fafafa !important; border-color: #ddd !important;
        }
        .rv2-bar-fill { background: #c9a96a !important; }
        .rv2-bbpanel-brand { background: #c9a96a !important; }
        .rv2-bbpanel-reseller { background: #d6d3cb !important; }
      }
    `}</style>
  );
}
