import Link from "next/link";
import AuditForm from "@/components/marketing/AuditForm";
import HeroMotif from "@/components/marketing/HeroMotif";
import ProfitMathChart from "@/components/marketing/ProfitMathChart";
import StepRail from "@/components/marketing/StepRail";
import Objections from "@/components/marketing/Objections";

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="m-hero">
        <HeroMotif className="m-hero-motif" />
        <div className="container" style={{ position: "relative", zIndex: 1 }}>
          <div className="m-hero-eyebrow-row">
            <span className="dot" aria-hidden />
            <span className="eyebrow">Amazon Channel Ownership</span>
          </div>
          <h1>
            Your Amazon channel is being run by someone&nbsp;else.
          </h1>
          <p className="lede">
            We help mid-market brands take it back — and typically double what
            that channel contributes to enterprise value. No upfront fees. 50%
            of the additional profit we create.
          </p>
          <div className="m-hero-cta">
            <Link href="/contact" className="m-btn">
              Get your free audit →
            </Link>
            <Link href="#math" className="m-btn m-btn-outline">
              See the math
            </Link>
          </div>
        </div>
      </section>

      {/* Three problem statements — stacked, hairline-ruled */}
      <section className="m-section alt">
        <div className="container">
          <div className="m-section-head fade-rise">
            <div className="eyebrow">The problem</div>
            <h2>Three things every brand owner already feels.</h2>
          </div>

          <div className="fade-rise">
            <div className="m-problem-row">
              <h3>Price wars you didn&apos;t start.</h3>
              <p className="body">
                Resellers compete on your listings, race the buy-box price down,
                trash your pricing consistency, and confuse your buyers. MAP
                gets ignored. Your retail partners notice — and complain.
              </p>
            </div>
            <div className="m-problem-row">
              <h3>Packaging, positioning, reviews — all outside your control.</h3>
              <p className="body">
                A repackaged product with a bad review hurts every future sale
                you make. The reseller&apos;s mistake becomes your brand
                problem. The customer never blames the middleman; they blame
                you.
              </p>
            </div>
            <div className="m-problem-row">
              <h3>Margin that should be yours, isn&apos;t.</h3>
              <p className="body">
                Resellers aren&apos;t adding value. They&apos;re arbitraging
                your work. The retail spread between wholesale and Amazon
                retail is the prize — and right now it&apos;s landing on
                somebody else&apos;s P&amp;L.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Thesis band */}
      <section className="m-thesis">
        <div className="container">
          <div className="eyebrow">Our thesis</div>
          <p className="display" style={{ marginTop: 18 }}>
            You may already have a meaningful Amazon business. It&apos;s just
            being run by <em>someone else</em>.
          </p>
        </div>
      </section>

      {/* Money slide */}
      <section id="math" className="m-money">
        <div className="container">
          <div className="m-section-head fade-rise" style={{ marginBottom: 32 }}>
            <div className="eyebrow" style={{ color: "var(--m-dark-muted)" }}>The math</div>
            <h2>Selling through resellers vs. selling direct.</h2>
            <p className="lede" style={{ color: "var(--m-dark-muted)" }}>
              Illustrative. Real numbers vary by category, velocity, and cost
              structure — but the shape of the gap holds across most mid-market
              brands we&apos;ve looked at.
            </p>
          </div>

          <ProfitMathChart />

          <div className="compare">
            <div className="col">
              <div className="eyebrow" style={{ color: "var(--m-dark-muted)" }}>Through resellers</div>
              <h3 style={{ marginTop: 8 }}>You sell wholesale. They sell retail.</h3>
              <div className="row" style={{ marginTop: 18 }}>
                <span className="lbl">Wholesale price / unit</span>
                <span className="val tabular">$44</span>
              </div>
              <div className="row big">
                <span className="lbl">Profit / unit</span>
                <span className="val tabular">$11.48</span>
              </div>
              <div className="row big">
                <span className="lbl">Annual profit @ 100k units</span>
                <span className="val tabular">~$1.15M</span>
              </div>
              <p style={{ marginTop: 18, fontSize: 13, color: "var(--m-dark-muted)" }}>
                The reseller keeps the retail spread. You stay a vendor.
              </p>
            </div>

            <div className="col bright">
              <div className="eyebrow" style={{ color: "var(--color-accent)" }}>Direct on Amazon</div>
              <h3 style={{ marginTop: 8 }}>You operate the channel. You keep the spread.</h3>
              <div className="row" style={{ marginTop: 18 }}>
                <span className="lbl">Retail price / unit</span>
                <span className="val tabular">$80</span>
              </div>
              <div className="row big accent">
                <span className="lbl">Profit / unit</span>
                <span className="val tabular">$24</span>
              </div>
              <div className="row big accent">
                <span className="lbl">Annual profit @ 100k units</span>
                <span className="val tabular">~$2.4M</span>
              </div>
              <p style={{ marginTop: 18, fontSize: 13, color: "var(--m-dark-muted)" }}>
                The retail margin lands on your P&amp;L. The channel becomes yours.
              </p>
            </div>
          </div>

          <div className="ev-line">
            <div className="eyebrow" style={{ color: "var(--m-dark-muted)" }}>Enterprise value lift</div>
            <div className="num" style={{ marginTop: 10 }}>
              At <em>7×</em>, that&apos;s roughly $8M+
            </div>
            <p style={{ marginTop: 18, maxWidth: "60ch" }}>
              At a 7× multiple — typical for the categories we work in — the
              ~$1.25M annual profit gap above translates to roughly $8M of
              enterprise value you&apos;re leaving on the table.
            </p>
            <p className="small-disclaimer">
              Illustrative. Actual figures vary by category, velocity, and cost structure.
            </p>
          </div>
        </div>
      </section>

      {/* 5-step rail */}
      <section className="m-section">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">The playbook</div>
            <h2>Five steps. Sequenced so the channel never goes dark.</h2>
            <p className="lede">
              The same path we walk with every brand. Sequenced so you don&apos;t
              blow up your existing wholesale relationships while you take the
              channel back.
            </p>
          </div>
          <StepRail />
        </div>
      </section>

      {/* Case-study preview */}
      <section className="m-section alt">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">Case studies</div>
            <h2>Two brands. One playbook.</h2>
          </div>

          <div className="m-grid-2">
            <Link href="/case-studies/diversified-hospitality" className="m-case-card">
              <div className="meta">Hospitality consumables</div>
              <h3>From reseller-dependent to $9M direct on Amazon.</h3>
              <p style={{ marginTop: 14, color: "var(--color-ink-soft)" }}>
                Diversified Hospitality Solutions: $8.34M (2022) → $9.02M
                (2023). $5M+ accounts payable paid down. Valuation roughly
                doubled.
              </p>
              <div className="arrow">Read the case study →</div>
            </Link>

            <Link href="/case-studies/legion-chemicals" className="m-case-card">
              <div className="meta">Specialty chemicals</div>
              <h3>Finding the brand before anyone else knew it was broken.</h3>
              <p style={{ marginTop: 14, color: "var(--color-ink-soft)" }}>
                Legion Chemicals: a worked example of what a Channel Ownership
                Audit looks like — four resellers, &gt;60% of brand sales
                velocity, captured spread you can quantify before you spend a
                dollar.
              </p>
              <div className="arrow">Read the case study →</div>
            </Link>
          </div>
        </div>
      </section>

      {/* Aligned incentives band */}
      <section className="m-incentives">
        <div className="container">
          <div className="eyebrow">Our model</div>
          <h2 style={{ marginTop: 18 }}>
            We don&apos;t get paid unless you make more money.
          </h2>
          <p>
            50% of the additional first-year profit we create. No retainer. No
            setup fee. After year one, you keep 100% of the upside and the
            operating playbook.
          </p>
          <div style={{ marginTop: 32, display: "flex", gap: 14, flexWrap: "wrap" }}>
            <Link href="/contact" className="m-btn">
              Run the audit on my channel →
            </Link>
            <Link href="/about" className="m-btn m-btn-outline">
              How we work
            </Link>
          </div>
        </div>
      </section>

      {/* Objections */}
      <section className="m-section">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">Objections, handled</div>
            <h2>The five questions every brand owner asks.</h2>
          </div>
          <Objections />
        </div>
      </section>

      {/* Audit CTA band */}
      <section id="audit" className="m-dark">
        <div className="container m-grid-2" style={{ alignItems: "start" }}>
          <div>
            <div className="eyebrow">Next step</div>
            <h2 style={{ marginTop: 18 }}>
              Get your free Channel Ownership Audit.
            </h2>
            <p style={{ marginTop: 22, fontSize: "1.1rem", color: "#D5D8DD" }}>
              Tell us your brand name, work email, and (optionally) your
              wholesale price per unit. We&apos;ll come back with a written
              audit: who&apos;s currently selling you on Amazon, the estimated
              lost margin, and what the unlocked profit looks like if you take
              the channel back.
            </p>
            <p style={{ marginTop: 22, fontSize: 13, color: "var(--m-dark-muted)", letterSpacing: "0.04em" }}>
              No-obligation. Roadmap delivered within 2 business days.
            </p>
          </div>
          <AuditForm variant="compact" sourcePage="/" />
        </div>
      </section>
    </>
  );
}
