import Link from "next/link";
import AuditForm from "@/components/marketing/AuditForm";

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="m-hero">
        <div className="container">
          <div className="eyebrow">Rolle Consulting Group</div>
          <h1 style={{ marginTop: 24 }}>
            Your Amazon channel is probably being run by someone else.
          </h1>
          <p className="lede">
            We help you take it back — and double its contribution to your
            enterprise value.
          </p>
          <div className="m-hero-cta">
            <Link href="#audit" className="m-btn">
              Get your free Channel Ownership Audit →
            </Link>
            <Link href="#math" className="m-btn m-btn-outline">
              See how the math works
            </Link>
          </div>
        </div>
      </section>

      {/* Problem */}
      <section className="m-section">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">The Problem</div>
            <h2>You may already have a meaningful Amazon business — but it&apos;s being run by someone else.</h2>
            <p className="lede">
              Wholesale buyers, distributors, and unauthorized resellers
              capture the retail margin that should be yours. They control
              your pricing, your listings, your reviews — and the buyer who
              eventually evaluates your business sees the channel as someone
              else&apos;s asset, not yours.
            </p>
          </div>

          <div className="m-grid-3">
            <div className="m-card">
              <div className="eyebrow" style={{ marginBottom: 14 }}>01</div>
              <h3>Resellers control your margin</h3>
              <p style={{ marginTop: 12 }}>
                Your wholesale customers mark up your product 80–100% on
                Amazon. That spread should be yours. Instead, it funds
                someone else&apos;s arbitrage.
              </p>
            </div>
            <div className="m-card">
              <div className="eyebrow" style={{ marginBottom: 14 }}>02</div>
              <h3>You don&apos;t control your pricing</h3>
              <p style={{ marginTop: 12 }}>
                Multiple sellers race the buy-box price down. Listings drift
                away from brand standards. MAP gets ignored. Your retail
                partners notice — and complain.
              </p>
            </div>
            <div className="m-card">
              <div className="eyebrow" style={{ marginBottom: 14 }}>03</div>
              <h3>Buyers discount your business</h3>
              <p style={{ marginTop: 12 }}>
                Acquirers and lenders look at a brand whose biggest channel
                is operated by third parties and apply a haircut. You lose
                enterprise value before the term sheet is even drafted.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Thesis */}
      <section className="m-section alt">
        <div className="container" style={{ maxWidth: 920 }}>
          <div className="eyebrow">Our Thesis</div>
          <h2 style={{ marginTop: 16 }}>
            Taking the channel in-house typically doubles channel profit —
            and doubles the channel&apos;s contribution to enterprise value.
          </h2>
          <p className="lede" style={{ marginTop: 24 }}>
            The retail margin a reseller currently keeps becomes yours. The
            channel stops looking like a bolt-on someone else operates and
            starts looking like a defensible part of your business — which
            is what acquirers actually pay for.
          </p>
        </div>
      </section>

      {/* Profit model — the money slide */}
      <section id="math" className="m-section">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">The Math</div>
            <h2>Selling through resellers vs. selling direct.</h2>
            <p className="lede">
              Illustrative. Real numbers vary by category, velocity, and
              cost structure — but the shape of the gap holds across most
              mid-market brands we&apos;ve looked at.
            </p>
          </div>

          <div className="m-grid-2">
            <div className="m-card" style={{ background: "#fff" }}>
              <div className="eyebrow">Through resellers</div>
              <h3 style={{ marginTop: 12 }}>You sell wholesale. They sell retail.</h3>

              <div style={{ marginTop: 28, display: "grid", gap: 18 }}>
                <Row label="Wholesale price / unit" value="~$44" />
                <Row label="Profit / unit (after COGS, fees, overhead)" value="$11.48" big />
                <Row label="Annual profit @ 100k units" value="$1.15M" big />
              </div>
              <p style={{ marginTop: 24, fontSize: 13, color: "var(--m-muted)" }}>
                The reseller keeps the retail spread. You stay a vendor.
              </p>
            </div>

            <div
              className="m-card"
              style={{
                background: "var(--m-ink)",
                color: "#fff",
                borderColor: "var(--m-ink)",
              }}
            >
              <div className="eyebrow" style={{ color: "#a4adb8" }}>Direct on Amazon</div>
              <h3 style={{ marginTop: 12, color: "#fff" }}>
                You operate the channel. You keep the spread.
              </h3>

              <div style={{ marginTop: 28, display: "grid", gap: 18 }}>
                <Row label="Retail price / unit" value="~$80" dark />
                <Row label="Profit / unit (after COGS, Amazon fees, FBA, overhead)" value="$24" big dark />
                <Row label="Annual profit @ 100k units" value="$2.4M" big dark />
              </div>
              <p style={{ marginTop: 24, fontSize: 13, color: "#a4adb8" }}>
                The retail margin lands on your P&amp;L. The channel becomes yours.
              </p>
            </div>
          </div>

          <div
            style={{
              marginTop: 48,
              padding: "32px 36px",
              background: "var(--m-bg-alt)",
              border: "1px solid var(--m-rule-soft)",
            }}
          >
            <div className="eyebrow">Enterprise value lift</div>
            <div
              style={{
                marginTop: 12,
                fontSize: "clamp(2.4rem, 4.5vw, 3.6rem)",
                fontWeight: 600,
                color: "var(--m-ink)",
                letterSpacing: "-0.03em",
                fontVariantNumeric: "tabular-nums",
                lineHeight: 1,
              }}
            >
              ~$8M+ unlocked
            </div>
            <p style={{ marginTop: 14, color: "var(--m-muted)", maxWidth: "62ch" }}>
              At a 7× EV multiple — typical for the categories we work in —
              the ~$1.25M annual profit gap above translates to roughly $8M
              of additional enterprise value. Many brands are sitting on a
              gap of this magnitude without realizing it.
            </p>
          </div>
        </div>
      </section>

      {/* 5-step playbook */}
      <section className="m-section alt">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">The Playbook</div>
            <h2>Five steps from reseller-controlled to brand-controlled.</h2>
            <p className="lede">
              The same path we&apos;ve walked with every brand. Sequenced so
              you don&apos;t blow up your existing wholesale relationships
              while you take back the channel.
            </p>
          </div>

          <ol style={{ display: "grid", gap: 20, listStyle: "none", padding: 0, margin: 0 }}>
            {[
              {
                n: "01",
                t: "Audit",
                p: "Free Channel Ownership Audit — we identify every active reseller, estimate the lost margin, and quantify the unlocked profit.",
              },
              {
                n: "02",
                t: "Enroll",
                p: "Brand Registry, brand gating, and MAP policy. Lock down the listing and the legal footing before you do anything visible.",
              },
              {
                n: "03",
                t: "Remove",
                p: "Warn, then cut off unauthorized resellers via enforcement. Done in sequence so nothing goes out of stock when they walk.",
              },
              {
                n: "04",
                t: "Take over",
                p: "Direct FBA operation. Reclaim the listings, rebuild pricing, take ownership of the customer experience end-to-end.",
              },
              {
                n: "05",
                t: "Scale",
                p: "In-house team, paid media, product expansion, retail partnerships. The channel compounds — quietly, for years.",
              },
            ].map((step) => (
              <li
                key={step.n}
                className="m-card"
                style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 28, alignItems: "start" }}
              >
                <div
                  style={{
                    fontSize: "clamp(1.6rem, 3vw, 2.2rem)",
                    fontWeight: 600,
                    color: "var(--m-faint)",
                    fontVariantNumeric: "tabular-nums",
                    letterSpacing: "-0.02em",
                    minWidth: 56,
                  }}
                >
                  {step.n}
                </div>
                <div>
                  <h3>{step.t}</h3>
                  <p style={{ marginTop: 8 }}>{step.p}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Case study preview */}
      <section className="m-section">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">Case Study</div>
            <h2>From reseller-dependent to $9M direct on Amazon.</h2>
          </div>

          <div className="m-card" style={{ display: "grid", gap: 24 }}>
            <div className="m-grid-2" style={{ alignItems: "start" }}>
              <div>
                <div className="m-case meta">Diversified Hospitality Solutions</div>
                <h3 style={{ fontSize: "1.5rem" }}>
                  Hospitality consumables brand, formerly dependent on
                  third-party resellers.
                </h3>
                <p style={{ marginTop: 14 }}>
                  Brand Registry, MAP enforcement, reseller cut-off, direct
                  FBA takeover, in-house team build. By 2023, the channel was
                  doing roughly $9M in direct Amazon sales. $5M+ of accounts
                  payable was paid down in the process. Valuation roughly
                  doubled.
                </p>
                <div style={{ marginTop: 24 }}>
                  <Link href="/case-studies/diversified-hospitality" className="m-link">
                    Read the full case study →
                  </Link>
                </div>
              </div>

              <div style={{ display: "grid", gap: 20 }}>
                <Stat label="Direct Amazon sales by 2023" value="~$9M" />
                <Stat label="Accounts payable paid down" value="$5M+" />
                <Stat label="Approximate valuation lift" value="~2×" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing / risk reversal */}
      <section className="m-section alt">
        <div className="container" style={{ maxWidth: 880 }}>
          <div className="eyebrow">Our Model</div>
          <h2 style={{ marginTop: 16 }}>
            No upfront cost. No retainer. We only get paid if you make more money.
          </h2>
          <p className="lede" style={{ marginTop: 24 }}>
            Our fee is 50% of the additional first-year profits we generate.
            After year one, you keep 100% of the upside and the operating
            playbook. Our incentives are perfectly aligned with yours — we
            eat when the brand eats.
          </p>

          <div className="m-grid-3" style={{ marginTop: 40 }}>
            <div>
              <div className="eyebrow">Audit</div>
              <div style={{ marginTop: 10, fontSize: "1.4rem", fontWeight: 600, color: "var(--m-ink)" }}>
                Free
              </div>
              <p style={{ marginTop: 8, fontSize: 14 }}>
                Quantitative read on your channel and unlocked profit.
              </p>
            </div>
            <div>
              <div className="eyebrow">Engagement</div>
              <div style={{ marginTop: 10, fontSize: "1.4rem", fontWeight: 600, color: "var(--m-ink)" }}>
                $0 upfront
              </div>
              <p style={{ marginTop: 8, fontSize: 14 }}>
                We do the work and front the operating cost.
              </p>
            </div>
            <div>
              <div className="eyebrow">Fee</div>
              <div style={{ marginTop: 10, fontSize: "1.4rem", fontWeight: 600, color: "var(--m-ink)" }}>
                50% of year-1 lift
              </div>
              <p style={{ marginTop: 8, fontSize: 14 }}>
                Of the additional profit we generate. Then it&apos;s all yours.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Audit CTA */}
      <section id="audit" className="m-dark">
        <div className="container m-grid-2" style={{ alignItems: "start", gap: 56 }}>
          <div>
            <div className="eyebrow" style={{ color: "#a4adb8" }}>Next step</div>
            <h2 style={{ marginTop: 14 }}>
              Get your free Channel Ownership Audit.
            </h2>
            <p style={{ marginTop: 18, fontSize: "1.1rem" }}>
              Tell us your brand name, work email, and (optionally) your
              wholesale price per unit. We&apos;ll come back with a written
              audit: who&apos;s currently selling you on Amazon, what the
              estimated lost margin is, and what the unlocked profit looks
              like if you take the channel back.
            </p>
            <p style={{ marginTop: 18, fontSize: 14, color: "var(--m-dark-muted)" }}>
              Typical turnaround: 5–7 business days. No upfront cost.
            </p>
          </div>
          <div>
            <AuditForm variant="compact" sourcePage="/" />
          </div>
        </div>
      </section>
    </>
  );
}

function Row({
  label,
  value,
  big = false,
  dark = false,
}: {
  label: string;
  value: string;
  big?: boolean;
  dark?: boolean;
}) {
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div
        style={{
          fontSize: 12,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: dark ? "#a4adb8" : "var(--m-muted)",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: big ? "clamp(1.8rem, 3.2vw, 2.4rem)" : "1.1rem",
          fontWeight: 600,
          color: dark ? "#fff" : "var(--m-ink)",
          letterSpacing: "-0.025em",
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1.05,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: "20px 24px",
        background: "var(--m-bg-alt)",
        borderLeft: "2px solid var(--m-accent)",
      }}
    >
      <div
        style={{
          fontSize: "1.6rem",
          fontWeight: 600,
          color: "var(--m-ink)",
          letterSpacing: "-0.025em",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div style={{ marginTop: 4, fontSize: 13, color: "var(--m-muted)" }}>
        {label}
      </div>
    </div>
  );
}
