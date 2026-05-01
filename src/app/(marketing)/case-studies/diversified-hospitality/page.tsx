import Link from "next/link";

export const metadata = {
  title: "Diversified Hospitality Solutions — Case Study | Rolle Consulting Group",
  description:
    "From reseller-dependent to ~$9M in direct Amazon sales by 2023. $5M+ AP paid down. Valuation roughly doubled.",
};

export default function DhsCaseStudy() {
  return (
    <>
      <section className="m-hero" style={{ padding: "96px 0 72px" }}>
        <div className="container">
          <div className="eyebrow">
            <Link href="/case-studies" className="m-link" style={{ borderColor: "transparent" }}>
              ← Case Studies
            </Link>
          </div>
          <h1 style={{ marginTop: 24, maxWidth: "20ch" }}>
            From reseller-dependent to $9M direct on Amazon.
          </h1>
          <p className="lede" style={{ maxWidth: "62ch" }}>
            Diversified Hospitality Solutions had real product, real
            distribution, and a real Amazon presence — but the Amazon
            presence was being run by everyone except them. Here&apos;s
            what changed.
          </p>
        </div>
      </section>

      {/* Outcome strip */}
      <section style={{ borderBottom: "1px solid var(--m-rule-soft)" }}>
        <div className="container">
          <div className="m-stats">
            <div className="m-stat">
              <div className="num">~$9M</div>
              <div className="lbl">Direct Amazon sales by 2023</div>
            </div>
            <div className="m-stat">
              <div className="num">$5M+</div>
              <div className="lbl">Accounts payable paid down in the process</div>
            </div>
            <div className="m-stat">
              <div className="num">~2×</div>
              <div className="lbl">Approximate valuation lift</div>
            </div>
            <div className="m-stat">
              <div className="num">5 yrs</div>
              <div className="lbl">From takeover decision to outcome</div>
            </div>
          </div>
        </div>
      </section>

      <section className="m-section">
        <div className="container m-grid-2" style={{ alignItems: "start" }}>
          <div>
            <div className="eyebrow">The challenge</div>
            <h2 style={{ marginTop: 14 }}>
              Resellers ran the channel. The brand was boxed out of its own retail margin.
            </h2>
            <p style={{ marginTop: 18 }}>
              Multiple third-party resellers controlled DHS&apos;s Amazon
              listings. Wholesale buyers were arbitraging the spread between
              wholesale and Amazon retail. Listings drifted. MAP went
              unenforced. Reviews accumulated against listings the brand
              didn&apos;t own. Worse, the channel showed up in valuation
              conversations as a third-party-operated channel — which is
              exactly the kind of detail acquirers haircut.
            </p>
            <p style={{ marginTop: 18 }}>
              The brand was effectively subsidizing other people&apos;s
              Amazon businesses while taking a discount on its own
              enterprise value.
            </p>
          </div>

          <div className="m-card" style={{ background: "var(--m-bg-alt)" }}>
            <div className="eyebrow">Starting position</div>
            <ul style={{ marginTop: 16, display: "grid", gap: 12, listStyle: "none", padding: 0 }}>
              <li>· Multiple unauthorized resellers on every key SKU</li>
              <li>· No Brand Registry enrollment or gating</li>
              <li>· Uncontrolled pricing; MAP not enforced</li>
              <li>· Listings written by resellers, not the brand</li>
              <li>· Significant trade payable balance from category investment</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="m-section alt">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">The work</div>
            <h2>Five steps. Sequenced so the channel never went dark.</h2>
            <p className="lede">
              The same playbook we run today. The order matters: enroll
              before you remove, take over before you scale.
            </p>
          </div>

          <ol style={{ display: "grid", gap: 20, listStyle: "none", padding: 0, margin: 0 }}>
            {[
              {
                n: "01",
                t: "Audit",
                p: "Mapped every active reseller, lost margin per SKU, MAP violations, and the projected unlocked profit. Written audit, signed off before anything visible happened.",
              },
              {
                n: "02",
                t: "Enroll",
                p: "Brand Registry enrollment, brand gating on the core SKUs, MAP policy authoring, and authorized-seller list — the legal scaffolding for everything that came next.",
              },
              {
                n: "03",
                t: "Remove",
                p: "Warned, then enforced against unauthorized resellers under Brand Registry. Sequenced over weeks so inventory stayed available throughout — no out-of-stocks during the transition.",
              },
              {
                n: "04",
                t: "Take over",
                p: "Direct FBA operation. Reclaimed listing content, rebuilt titles / bullets / A+ / video, took ownership of pricing, advertising, and customer service end-to-end.",
              },
              {
                n: "05",
                t: "Scale",
                p: "Built the in-house team to operate the channel daily. Expanded the SKU footprint. Layered in paid media. The channel compounded into the ~$9M run-rate by 2023.",
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

      <section className="m-section">
        <div className="container m-grid-2" style={{ alignItems: "start" }}>
          <div>
            <div className="eyebrow">The outcome</div>
            <h2 style={{ marginTop: 14 }}>A channel the brand actually owns.</h2>
            <p style={{ marginTop: 18 }}>
              By 2023, the Amazon channel was clearing roughly $9M in direct
              sales annually — margin on the brand&apos;s own P&amp;L
              instead of a reseller&apos;s. The cash generated paid down
              over $5M of accounts payable in the process.
            </p>
            <p style={{ marginTop: 18 }}>
              The valuation impact was the part most owners underweight.
              When the next set of acquirer conversations came up, the
              channel was no longer a haircut item. It was a defensible,
              brand-controlled segment with operating history. The
              business&apos;s implied valuation roughly doubled across that
              window.
            </p>
            <p style={{ marginTop: 18, fontSize: 14, color: "var(--m-muted)" }}>
              Specific outcomes will vary by category, velocity, and
              starting position — these numbers are illustrative of what
              channel ownership unlocked here.
            </p>
          </div>

          <div className="m-card" style={{ background: "#fff" }}>
            <div className="m-quote" style={{ marginBottom: 20 }}>
              &ldquo;We were paying for our own Amazon business twice — once
              in margin we gave up to resellers, and again in the discount
              acquirers were applying to the channel. Once the playbook
              ran, both went away.&rdquo;
            </div>
            <div style={{ fontSize: 13, color: "var(--m-muted)" }}>
              — Representative paraphrase. Brand voice; not a literal
              quotation.
            </div>
          </div>
        </div>
      </section>

      <section className="m-dark">
        <div className="container" style={{ maxWidth: 800 }}>
          <h2>Run the audit on your own channel.</h2>
          <p style={{ marginTop: 14, fontSize: "1.1rem" }}>
            Same starting point we used at DHS. Free, written, no
            obligation. We&apos;ll quantify your active resellers, lost
            margin, and unlocked profit potential.
          </p>
          <div style={{ marginTop: 28, display: "flex", gap: 14, flexWrap: "wrap" }}>
            <Link href="/contact" className="m-btn m-btn-light">
              Request a free audit →
            </Link>
            <Link
              href="/case-studies"
              className="m-btn m-btn-outline"
              style={{ borderColor: "#fff", color: "#fff" }}
            >
              Back to case studies
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
