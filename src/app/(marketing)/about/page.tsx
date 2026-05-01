import Link from "next/link";

export const metadata = {
  title: "About — Rolle Consulting Group",
  description:
    "Operator-led Amazon channel ownership consulting for mid-market brands. Aligned incentives. We've run this playbook ourselves.",
};

export default function AboutPage() {
  return (
    <>
      <section className="m-hero">
        <div className="container">
          <div className="m-hero-eyebrow-row">
            <span className="dot" aria-hidden />
            <span className="eyebrow">About</span>
          </div>
          <h1>We&apos;ve run this playbook ourselves.</h1>
          <p className="lede">
            Rolle Consulting Group is a small, operator-led consultancy. We
            help mid-market brands take their Amazon channel back from
            third-party resellers — and turn it into the most defensible
            piece of enterprise value they own.
          </p>
        </div>
      </section>

      {/* Operator narrative */}
      <section className="m-section">
        <div className="container prose">
          <div className="eyebrow">Why we exist</div>
          <h2 style={{ marginTop: 14 }}>
            Brand owners losing seven figures of margin to resellers who add no value.
          </h2>

          <div style={{ marginTop: 32, display: "grid", gap: 22 }}>
            <p>
              Steve is a brand owner. A few years ago, he looked at his own
              Amazon channel and realized that his wholesale customers were
              quietly running a second business on top of his — pricing it,
              listing it, capturing the retail spread, and walking away with
              the margin that was supposed to be his. He took the channel
              back. The result was the doubling that started this firm.
            </p>
            <p>
              RCG exists because too many mid-market brands are leaking
              seven-figure margin and enterprise value to resellers who
              aren&apos;t adding value. The reason isn&apos;t skill or
              effort. It&apos;s that the in-house playbook isn&apos;t
              obvious — it&apos;s a sequence of legal, operational, and
              channel moves that have to happen in the right order, and
              there&apos;s no good template for it. So most brands stay
              stuck.
            </p>
            <p>
              We work the way we&apos;d want a partner to work for us. A
              quantitative audit comes first — written down, sourced,
              defensible. The fee is aligned with the outcome: 50% of the
              additional first-year profit we create. We do the work
              ourselves rather than hand it off to junior consultants. And
              we leave you with a trained team that can run the channel for
              the next decade. Twelve months in, twelve months out, you own
              the channel.
            </p>
          </div>
        </div>
      </section>

      {/* Three principle cards */}
      <section className="m-section alt">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">Principles</div>
            <h2>Three rules we don&apos;t bend.</h2>
          </div>

          <div className="m-grid-3">
            <div className="m-card">
              <div className="eyebrow" style={{ color: "var(--color-accent-ink)" }}>01 — Aligned</div>
              <h3 style={{ marginTop: 14 }}>We only make money when you make more money.</h3>
              <p style={{ marginTop: 14 }}>
                No retainer. No upfront cost. 50% of the additional
                first-year profit we create. If we can&apos;t move the
                number, we don&apos;t earn — and we&apos;ll tell you so
                during the audit.
              </p>
            </div>
            <div className="m-card">
              <div className="eyebrow" style={{ color: "var(--color-accent-ink)" }}>02 — Operator-led</div>
              <h3 style={{ marginTop: 14 }}>We&apos;ve lived the playbook, not just written about it.</h3>
              <p style={{ marginTop: 14 }}>
                Brand Registry, MAP enforcement, FBA takeover, listing
                rebuilds, in-house team build — done by people who&apos;ve
                actually run channels at this scale, not by interns
                reading a deck.
              </p>
            </div>
            <div className="m-card">
              <div className="eyebrow" style={{ color: "var(--color-accent-ink)" }}>03 — Finite</div>
              <h3 style={{ marginTop: 14 }}>Twelve-month engagement. You own the channel when we leave.</h3>
              <p style={{ marginTop: 14 }}>
                We&apos;re not a retainer agency you keep paying forever.
                We come in, run the playbook, train your team, and go.
                You leave with the channel, the playbook, and the
                operators.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Founder placeholder card */}
      <section className="m-section">
        <div className="container m-grid-2" style={{ alignItems: "center" }}>
          <div
            aria-hidden
            style={{
              aspectRatio: "1 / 1",
              maxWidth: 360,
              background:
                "linear-gradient(135deg, var(--color-paper-2) 0%, #ddd9cc 100%)",
              border: "1px solid var(--color-rule)",
              borderRadius: 2,
              position: "relative",
            }}
          >
            {/* TODO: replace with real founder photo */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--color-faint)",
                fontSize: 12,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
              }}
            >
              Portrait
            </div>
          </div>
          <div>
            <div className="eyebrow">Founder</div>
            <h2 style={{ marginTop: 14 }}>Steve Rolle</h2>
            <p style={{ marginTop: 18 }}>
              Brand owner. Operator. Took his own Amazon channel back from
              resellers and roughly doubled the value of the underlying
              business. Started RCG to run the same playbook for other
              mid-market brands stuck in the same trap.
            </p>
            <p style={{ marginTop: 18 }}>
              &ldquo;Your brand deserves to thrive. Don&apos;t let resellers
              control your story, your reputation, or your profits. Take
              ownership.&rdquo;
            </p>
          </div>
        </div>
      </section>

      {/* CTA strip */}
      <section className="m-dark">
        <div className="container narrow">
          <div className="eyebrow">Next step</div>
          <h2 style={{ marginTop: 18 }}>
            Want to know what&apos;s sitting in your channel?
          </h2>
          <p style={{ marginTop: 22, fontSize: "1.1rem", color: "#D5D8DD" }}>
            Free Channel Ownership Audit. We&apos;ll quantify the gap between
            what your brand is earning on Amazon and what it could earn —
            written, sourced, no obligation.
          </p>
          <div style={{ marginTop: 32, display: "flex", gap: 14, flexWrap: "wrap" }}>
            <Link href="/contact" className="m-btn m-btn-light">
              Get my free audit →
            </Link>
            <Link
              href="/case-studies"
              className="m-btn m-btn-outline"
              style={{ borderColor: "#fff", color: "#fff" }}
            >
              See case studies
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
