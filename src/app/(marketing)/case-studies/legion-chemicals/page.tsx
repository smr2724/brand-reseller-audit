import Link from "next/link";

export const metadata = {
  title: "Legion Chemicals — Case Study | Rolle Consulting Group",
  description:
    "A worked example of what a Channel Ownership Audit looks like in practice — illustrative, drawn from typical mid-market specialty chemicals brands.",
};

export default function LegionCaseStudy() {
  return (
    <>
      <section className="m-hero" style={{ paddingBottom: 64 }}>
        <div className="container">
          <Link href="/case-studies" className="m-link" style={{ borderColor: "transparent", fontSize: 13 }}>
            ← Case studies
          </Link>
          <div className="m-hero-eyebrow-row" style={{ marginTop: 24 }}>
            <span className="dot" aria-hidden />
            <span className="eyebrow">Specialty chemicals · Worked example</span>
          </div>
          <h1 style={{ marginTop: 28 }}>
            Finding the brand before anyone else knew it was broken.
          </h1>
          <p className="lede">
            Legion Chemicals is a worked example of what a Channel
            Ownership Audit looks like in practice. The category and shape
            are typical for the mid-market specialty brands we audit. The
            specific figures are illustrative — useful to show the math, not
            to imply a guarantee for any individual brand.
          </p>
          <p
            style={{
              marginTop: 22,
              fontSize: 13,
              color: "var(--color-muted)",
              fontStyle: "italic",
              maxWidth: "62ch",
            }}
          >
            Note: this case study is presented as an illustrative worked
            example. Figures are typical of the category and are intended to
            show how a Channel Ownership Audit reads, not to claim a specific
            outcome for a specific brand.
          </p>
        </div>
      </section>

      {/* Audit findings strip */}
      <section style={{ background: "var(--color-paper-2)" }}>
        <div className="container">
          <div className="m-stats">
            <div className="m-stat">
              <div className="num"><em>4</em></div>
              <div className="lbl">Dominant resellers controlling the listings</div>
            </div>
            <div className="m-stat">
              <div className="num"><em>~60%</em></div>
              <div className="lbl">Of brand sales velocity captured by those resellers</div>
            </div>
            <div className="m-stat">
              <div className="num">75–90%</div>
              <div className="lbl">Spread between wholesale and Amazon retail</div>
            </div>
            <div className="m-stat">
              <div className="num">$0</div>
              <div className="lbl">Of that spread landing on the brand&apos;s P&amp;L</div>
            </div>
          </div>
        </div>
      </section>

      {/* The setup */}
      <section className="m-section">
        <div className="container m-grid-2" style={{ alignItems: "start" }}>
          <div>
            <div className="eyebrow">The setup</div>
            <h2 style={{ marginTop: 14 }}>
              A brand that looked &ldquo;fine&rdquo; on Amazon — until you read it carefully.
            </h2>
            <p style={{ marginTop: 22 }}>
              Legion Chemicals is a mid-market specialty chemicals brand
              with meaningful wholesale distribution and a scattered Amazon
              presence run by multiple third-party resellers. Buyers found
              inconsistent SKU configurations across listings — full-size
              vs. repackaged, different bundle counts, different label art.
              Pricing was wide, with the buy-box rotating between sellers.
            </p>
            <p style={{ marginTop: 18 }}>
              From the outside, none of this looked like a five-alarm fire.
              Sales were steady. Reviews were okay. The brand was earning
              its wholesale margin. The problem only showed up when you
              measured what was happening on the platform — which is
              exactly what an audit does.
            </p>
          </div>

          <div className="m-card" style={{ background: "var(--color-paper-2)" }}>
            <div className="eyebrow">Audit inputs</div>
            <ul style={{ marginTop: 18, display: "grid", gap: 14, listStyle: "none", padding: 0 }}>
              <li style={{ paddingLeft: 16, position: "relative" }}>
                <span style={{ position: "absolute", left: 0, color: "var(--color-accent)" }}>·</span>
                Reseller signal scan across active listings on the brand&apos;s top SKUs
              </li>
              <li style={{ paddingLeft: 16, position: "relative" }}>
                <span style={{ position: "absolute", left: 0, color: "var(--color-accent)" }}>·</span>
                Buy-box ownership and rotation patterns over 90 days
              </li>
              <li style={{ paddingLeft: 16, position: "relative" }}>
                <span style={{ position: "absolute", left: 0, color: "var(--color-accent)" }}>·</span>
                Wholesale price (provided by brand) vs. observed Amazon retail
              </li>
              <li style={{ paddingLeft: 16, position: "relative" }}>
                <span style={{ position: "absolute", left: 0, color: "var(--color-accent)" }}>·</span>
                Brand Registry status, MAP enforcement footprint, listing ownership
              </li>
              <li style={{ paddingLeft: 16, position: "relative" }}>
                <span style={{ position: "absolute", left: 0, color: "var(--color-accent)" }}>·</span>
                Estimated unit velocity per active reseller
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* Findings */}
      <section className="m-section alt">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">What the audit found</div>
            <h2>Four resellers running ~60% of the brand&apos;s Amazon velocity.</h2>
            <p className="lede">
              The brand had been quietly funding four other people&apos;s
              Amazon businesses. The math was clean once you wrote it down.
            </p>
          </div>

          <div className="m-grid-2">
            <div className="m-card">
              <div className="eyebrow" style={{ color: "var(--color-accent-ink)" }}>Finding 01</div>
              <h3 style={{ marginTop: 14 }}>Reseller concentration</h3>
              <p style={{ marginTop: 14 }}>
                Four dominant accounts captured an estimated 60%+ of brand
                sales velocity on Amazon. The remaining 40% was split across
                a long tail of smaller resellers and one direct listing
                operated by the brand — ranked low in the search results
                because it had been left static for months.
              </p>
            </div>
            <div className="m-card">
              <div className="eyebrow" style={{ color: "var(--color-accent-ink)" }}>Finding 02</div>
              <h3 style={{ marginTop: 14 }}>Wholesale-to-retail spread</h3>
              <p style={{ marginTop: 14 }}>
                The spread between the brand&apos;s wholesale price and the
                observed Amazon retail ranged 75–90% across the top SKUs.
                None of that spread was reaching the brand&apos;s P&amp;L.
                That gap is the prize — the number we project the brand
                could be earning if it operated the channel itself.
              </p>
            </div>
            <div className="m-card">
              <div className="eyebrow" style={{ color: "var(--color-accent-ink)" }}>Finding 03</div>
              <h3 style={{ marginTop: 14 }}>Listing fragmentation</h3>
              <p style={{ marginTop: 14 }}>
                Several SKUs had drifted across multiple ASINs as resellers
                created their own listings rather than co-listing against
                the brand&apos;s. Reviews were fragmented, search ranking
                was diluted, and Brand Registry hadn&apos;t been used to
                consolidate. Half of the listing photography wasn&apos;t
                even the brand&apos;s.
              </p>
            </div>
            <div className="m-card">
              <div className="eyebrow" style={{ color: "var(--color-accent-ink)" }}>Finding 04</div>
              <h3 style={{ marginTop: 14 }}>Capture, not growth</h3>
              <p style={{ marginTop: 14 }}>
                The most useful framing: this was a capture play, not a
                growth play. Demand for the product was already proven on
                Amazon — the resellers had done the work. The roadmap is
                redirecting that demand onto a listing the brand owns. No
                new customer acquisition required.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* The roadmap */}
      <section className="m-section">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">The proposed roadmap</div>
            <h2>The same five steps. Sequenced for a chemicals category.</h2>
            <p className="lede">
              Specialty chemicals adds two wrinkles — hazmat shipping and
              regulated-product compliance. The framework absorbs both
              without changing the order of operations.
            </p>
          </div>

          <ol className="m-rail">
            <li className="step">
              <div className="n" aria-hidden>01</div>
              <div>
                <h3>Audit (this document)</h3>
                <p>
                  Reseller map, lost-margin estimate, projected unlocked
                  profit. Written, sourced, signed off before anything
                  visible happens.
                </p>
              </div>
            </li>
            <li className="step">
              <div className="n" aria-hidden>02</div>
              <div>
                <h3>Set up</h3>
                <p>
                  Brand Registry enrollment, brand gating on the four most
                  abused SKUs, MAP policy authoring, hazmat-compliant FBA
                  setup, listing consolidation onto canonical ASINs.
                </p>
              </div>
            </li>
            <li className="step">
              <div className="n" aria-hidden>03</div>
              <div>
                <h3>Protect</h3>
                <p>
                  Updated wholesale agreements prohibiting Amazon resale.
                  Monitoring tooling for unauthorized listings. Enforcement
                  SOPs ready before any take-down letters go out.
                </p>
              </div>
            </li>
            <li className="step">
              <div className="n" aria-hidden>04</div>
              <div>
                <h3>Transition</h3>
                <p>
                  Four-to-six-week sell-out window for existing reseller
                  inventory. Brand begins stocking FBA in parallel. The
                  channel never goes dark mid-handoff — this is the part
                  most operators worry about, and it&apos;s the part the
                  framework is designed for.
                </p>
              </div>
            </li>
            <li className="step">
              <div className="n" aria-hidden>05</div>
              <div>
                <h3>Scale</h3>
                <p>
                  Train an in-house Amazon specialist or VA to operate the
                  channel daily. Layer in paid media. Expand the SKU
                  footprint. Twelve months in, the brand owns a defensible,
                  margin-rich channel that contributes meaningfully to
                  enterprise value.
                </p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      {/* Lesson */}
      <section className="m-thesis">
        <div className="container">
          <div className="eyebrow">The key lesson</div>
          <p className="display" style={{ marginTop: 18 }}>
            The brands that look <em>&ldquo;fine&rdquo;</em> on Amazon are often the biggest opportunities.
          </p>
          <p style={{ marginTop: 24, color: "var(--color-ink-soft)", fontSize: "1.1rem", maxWidth: "62ch" }}>
            Their resellers have already proven demand — which means the
            takeover is a <strong style={{ color: "var(--color-ink)" }}>capture</strong> play,
            not a growth play. You don&apos;t have to build a new audience.
            You just have to redirect the one that already exists onto a
            listing you own.
          </p>
        </div>
      </section>

      {/* Status note */}
      <section className="m-section">
        <div className="container narrow">
          <div className="eyebrow">Status</div>
          <h2 style={{ marginTop: 14 }}>An illustrative audit, not a closed engagement.</h2>
          <p style={{ marginTop: 22 }}>
            This page is published as a worked example so brand owners and
            advisors can see the shape of an audit before they request one.
            The findings, framing, and proposed roadmap are typical for the
            specialty chemicals category. The specific figures are
            illustrative.
          </p>
          <p style={{ marginTop: 18 }}>
            If you operate a brand in a similar shape — wholesale-led,
            scattered Amazon presence, a handful of resellers running the
            listings — the free Channel Ownership Audit will produce the
            real version of this document for your specific brand. Same
            structure. Real numbers.
          </p>
        </div>
      </section>

      <section className="m-dark">
        <div className="container narrow">
          <div className="eyebrow">Next step</div>
          <h2 style={{ marginTop: 18 }}>Run the real version on your brand.</h2>
          <p style={{ marginTop: 22, fontSize: "1.1rem", color: "#D5D8DD" }}>
            Free, written, sourced. Same structure as this page — with your
            actual resellers, your actual spread, and your actual unlocked
            profit. Roadmap delivered within 2 business days.
          </p>
          <div style={{ marginTop: 32, display: "flex", gap: 14, flexWrap: "wrap" }}>
            <Link href="/contact" className="m-btn m-btn-light">
              Request a free audit →
            </Link>
            <Link
              href="/case-studies/diversified-hospitality"
              className="m-btn m-btn-outline"
              style={{ borderColor: "#fff", color: "#fff" }}
            >
              Read DHS &nbsp;→
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
