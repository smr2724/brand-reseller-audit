import Link from "next/link";

export const metadata = {
  title: "Case Studies — Rolle Consulting Group",
  description:
    "Two brands. One playbook. How RCG helps mid-market brands take their Amazon channel back from third-party resellers.",
};

export default function CaseStudiesPage() {
  return (
    <>
      <section className="m-hero">
        <div className="container">
          <div className="m-hero-eyebrow-row">
            <span className="dot" aria-hidden />
            <span className="eyebrow">Case studies</span>
          </div>
          <h1>Two brands. One playbook.</h1>
          <p className="lede">
            Every engagement starts with the same audit and follows the same
            five-step framework. The categories vary. The shape of the result
            doesn&apos;t.
          </p>
        </div>
      </section>

      <section className="m-section">
        <div className="container">
          <div className="m-grid-2">
            <Link href="/case-studies/diversified-hospitality" className="m-case-card">
              <div className="meta">Hospitality consumables · 2022–2023</div>
              <h3>From reseller-dependent to $9M direct on Amazon.</h3>
              <p style={{ marginTop: 16, color: "var(--color-ink-soft)" }}>
                Diversified Hospitality Solutions had real product, real
                distribution, and a real Amazon presence — being run by
                everyone except them. We took it back. Revenue: $8.34M
                (2022) → $9.02M (2023). $5M+ accounts payable paid down.
                Valuation roughly doubled.
              </p>
              <div className="arrow">Read the case study →</div>
            </Link>

            <Link href="/case-studies/legion-chemicals" className="m-case-card">
              <div className="meta">Specialty chemicals · Worked example</div>
              <h3>Finding the brand before anyone else knew it was broken.</h3>
              <p style={{ marginTop: 16, color: "var(--color-ink-soft)" }}>
                Legion Chemicals: a worked example of what a Channel
                Ownership Audit looks like in practice. Four resellers
                capturing &gt;60% of brand sales velocity. A 75–90% spread
                between wholesale and Amazon retail. Capture, not growth.
              </p>
              <div className="arrow">Read the case study →</div>
            </Link>
          </div>
        </div>
      </section>

      <section className="m-incentives">
        <div className="container">
          <div className="eyebrow">Run yours</div>
          <h2 style={{ marginTop: 18 }}>
            Think your channel fits the pattern?
          </h2>
          <p>
            The free Channel Ownership Audit will tell you. Submit your
            brand and we&apos;ll send back a written read on who&apos;s
            currently selling you on Amazon and what the unlocked profit
            looks like.
          </p>
          <div style={{ marginTop: 32, display: "flex", gap: 14, flexWrap: "wrap" }}>
            <Link href="/contact" className="m-btn">
              Get your free audit →
            </Link>
            <Link href="/about" className="m-btn m-btn-outline">
              About RCG
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
