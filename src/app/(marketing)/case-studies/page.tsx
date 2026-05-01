import Link from "next/link";

export const metadata = {
  title: "Case Studies — Rolle Consulting Group",
  description:
    "How we helped mid-market brands take their Amazon channel back from third-party resellers.",
};

export default function CaseStudiesPage() {
  return (
    <>
      <section className="m-hero" style={{ padding: "96px 0" }}>
        <div className="container">
          <div className="eyebrow">Case Studies</div>
          <h1 style={{ marginTop: 24, maxWidth: "22ch" }}>
            What channel ownership looks like in practice.
          </h1>
          <p className="lede" style={{ maxWidth: "60ch" }}>
            Each engagement starts with the same audit and follows the same
            five-step playbook. The results vary by category and starting
            position — but the shape of the gain is consistent.
          </p>
        </div>
      </section>

      <section className="m-section">
        <div className="container">
          <div className="m-grid-2">
            <Link
              href="/case-studies/diversified-hospitality"
              className="m-card"
              style={{ display: "block", textDecoration: "none" }}
            >
              <div className="m-case meta">Hospitality consumables</div>
              <h2 style={{ fontSize: "1.8rem", marginTop: 6 }}>
                Diversified Hospitality Solutions
              </h2>
              <p style={{ marginTop: 14 }}>
                From reseller-dependent to roughly $9M in direct Amazon
                sales. $5M+ of accounts payable paid down. Valuation roughly
                doubled.
              </p>
              <div style={{ marginTop: 24, display: "grid", gap: 14 }}>
                <Result label="Direct Amazon sales by 2023" value="~$9M" />
                <Result label="AP paid down" value="$5M+" />
                <Result label="Valuation impact" value="~2× lift" />
              </div>
              <div style={{ marginTop: 28, fontWeight: 600, color: "var(--m-ink)" }}>
                Read the case study →
              </div>
            </Link>

            <div
              className="m-card"
              style={{
                background: "var(--m-bg-alt)",
                borderStyle: "dashed",
              }}
            >
              <div className="m-case meta">More case studies coming</div>
              <h2 style={{ fontSize: "1.6rem", marginTop: 6, color: "var(--m-muted)" }}>
                We&apos;re selective.
              </h2>
              <p style={{ marginTop: 14 }}>
                Most of our engagements are confidential by request. As more
                partner brands clear their write-up windows, we&apos;ll add
                their stories here. If you want a reference call rather than
                a public case study, ask — we&apos;ll arrange one for
                serious prospects.
              </p>
              <div style={{ marginTop: 28 }}>
                <Link href="/contact" className="m-link">
                  Request a reference call →
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="m-dark">
        <div className="container" style={{ maxWidth: 760 }}>
          <h2>Think your channel fits the pattern?</h2>
          <p style={{ marginTop: 14, fontSize: "1.1rem" }}>
            The free audit will tell you. Submit your brand and we&apos;ll
            send back a written read on who&apos;s currently selling you on
            Amazon and what the unlocked profit looks like.
          </p>
          <div style={{ marginTop: 28, display: "flex", gap: 14, flexWrap: "wrap" }}>
            <Link href="/contact" className="m-btn m-btn-light">
              Get your free audit →
            </Link>
            <Link
              href="/about"
              className="m-btn m-btn-outline"
              style={{ borderColor: "#fff", color: "#fff" }}
            >
              About RCG
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

function Result({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderTop: "1px solid var(--m-rule-soft)", paddingTop: 14 }}>
      <div style={{ fontSize: 13, color: "var(--m-muted)" }}>{label}</div>
      <div style={{ fontSize: "1.2rem", fontWeight: 600, color: "var(--m-ink)", letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
    </div>
  );
}
