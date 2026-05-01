import Link from "next/link";

export const metadata = {
  title:
    "Diversified Hospitality Solutions — Case Study | Rolle Consulting Group",
  description:
    "From reseller-dependent to ~$9M direct on Amazon by 2023. $5M+ accounts payable paid down. Valuation roughly doubled.",
};

export default function DhsCaseStudy() {
  return (
    <>
      <section className="m-hero" style={{ paddingBottom: 64 }}>
        <div className="container">
          <Link href="/case-studies" className="m-link" style={{ borderColor: "transparent", fontSize: 13 }}>
            ← Case studies
          </Link>
          <div className="m-hero-eyebrow-row" style={{ marginTop: 24 }}>
            <span className="dot" aria-hidden />
            <span className="eyebrow">Hospitality consumables · 2022–2023</span>
          </div>
          <h1 style={{ marginTop: 28 }}>
            From reseller-dependent to $9M direct on Amazon.
          </h1>
          <p className="lede">
            Diversified Hospitality Solutions had real product, real
            distribution, and a real Amazon presence — but the Amazon
            presence was being run by everyone except them. Here&apos;s
            what changed.
          </p>
        </div>
      </section>

      {/* Outcome strip */}
      <section style={{ background: "var(--color-paper-2)" }}>
        <div className="container">
          <div className="m-stats">
            <div className="m-stat">
              <div className="num">
                $8.34M <em>→</em> $9.02M
              </div>
              <div className="lbl">Direct Amazon revenue, 2022 → 2023</div>
            </div>
            <div className="m-stat">
              <div className="num">$5M+</div>
              <div className="lbl">Accounts payable paid down in 24 months</div>
            </div>
            <div className="m-stat">
              <div className="num"><em>~2×</em></div>
              <div className="lbl">Approximate valuation lift</div>
            </div>
            <div className="m-stat">
              <div className="num">$1.2M</div>
              <div className="lbl">A single reseller&apos;s annual net income on the brand</div>
            </div>
          </div>
        </div>
      </section>

      {/* Challenge */}
      <section className="m-section">
        <div className="container m-grid-2" style={{ alignItems: "start" }}>
          <div>
            <div className="eyebrow">The challenge</div>
            <h2 style={{ marginTop: 14 }}>
              Resellers ran the channel. The brand was boxed out of its own retail margin.
            </h2>
            <p style={{ marginTop: 22 }}>
              For years, DHS relied on a reseller network. On the surface it
              looked like volume — underneath, pricing was inconsistent,
              packaging was off-brand, and customer service was a gamble.
              One reseller alone earned $1.2M in net income in a single year
              on DHS&apos;s product, nearly matching DHS&apos;s own total
              net income.
            </p>
            <p style={{ marginTop: 18 }}>
              Cash flow was the second tell. 60–90 day payment terms from
              resellers strained the business. The channel that should have
              been the most profitable, fastest-cashing piece of the
              business was running as the slowest.
            </p>
            <p style={{ marginTop: 18 }}>
              The brand was effectively subsidizing other people&apos;s
              Amazon businesses while taking a haircut on its own enterprise
              value when acquirers looked at the channel.
            </p>
          </div>

          <div className="m-card" style={{ background: "var(--color-paper-2)" }}>
            <div className="eyebrow">Starting position</div>
            <ul style={{ marginTop: 18, display: "grid", gap: 14, listStyle: "none", padding: 0 }}>
              <li style={{ paddingLeft: 16, position: "relative" }}>
                <span style={{ position: "absolute", left: 0, color: "var(--color-accent)" }}>·</span>
                Multiple unauthorized resellers on every key SKU
              </li>
              <li style={{ paddingLeft: 16, position: "relative" }}>
                <span style={{ position: "absolute", left: 0, color: "var(--color-accent)" }}>·</span>
                No Brand Registry enrollment or gating
              </li>
              <li style={{ paddingLeft: 16, position: "relative" }}>
                <span style={{ position: "absolute", left: 0, color: "var(--color-accent)" }}>·</span>
                Uncontrolled pricing; MAP not enforced
              </li>
              <li style={{ paddingLeft: 16, position: "relative" }}>
                <span style={{ position: "absolute", left: 0, color: "var(--color-accent)" }}>·</span>
                Listings written by resellers, not the brand
              </li>
              <li style={{ paddingLeft: 16, position: "relative" }}>
                <span style={{ position: "absolute", left: 0, color: "var(--color-accent)" }}>·</span>
                60–90 day payment terms straining cash
              </li>
              <li style={{ paddingLeft: 16, position: "relative" }}>
                <span style={{ position: "absolute", left: 0, color: "var(--color-accent)" }}>·</span>
                Significant trade payable balance from category investment
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* The work */}
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

          <ol className="m-rail">
            <li className="step">
              <div className="n" aria-hidden>01</div>
              <div>
                <h3>Audit</h3>
                <p>
                  Mapped every active reseller, lost margin per SKU, MAP
                  violations, and projected unlocked profit. Written audit,
                  signed off before anything visible happened.
                </p>
              </div>
            </li>
            <li className="step">
              <div className="n" aria-hidden>02</div>
              <div>
                <h3>Set up</h3>
                <p>
                  Brand Registry, brand gating on the core SKUs, MAP policy
                  authoring, authorized-seller list. Updated distribution
                  agreements to prohibit Amazon resale by wholesale customers.
                </p>
              </div>
            </li>
            <li className="step">
              <div className="n" aria-hidden>03</div>
              <div>
                <h3>Protect</h3>
                <p>
                  Halted Amazon-bound sales to reseller accounts. Warned,
                  then enforced against unauthorized resellers under Brand
                  Registry. Sequenced over weeks so inventory stayed
                  available throughout.
                </p>
              </div>
            </li>
            <li className="step">
              <div className="n" aria-hidden>04</div>
              <div>
                <h3>Transition</h3>
                <p>
                  Direct FBA operation. Reclaimed listing content, rebuilt
                  titles / bullets / A+ / video, took ownership of pricing,
                  advertising, and customer service end-to-end. Resellers
                  sold through their existing inventory; DHS stocked the
                  shelf.
                </p>
              </div>
            </li>
            <li className="step">
              <div className="n" aria-hidden>05</div>
              <div>
                <h3>Scale</h3>
                <p>
                  Built the in-house team to operate the channel daily.
                  Expanded the SKU footprint. Layered in paid media. The
                  channel compounded into the ~$9M run-rate by 2023 — and
                  the cash it threw off paid down the trade payables that
                  had been weighing on the balance sheet.
                </p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      {/* Outcome */}
      <section className="m-section">
        <div className="container m-grid-2" style={{ alignItems: "start" }}>
          <div>
            <div className="eyebrow">The outcome</div>
            <h2 style={{ marginTop: 14 }}>A channel the brand actually owns.</h2>
            <p style={{ marginTop: 22 }}>
              By 2023, the Amazon channel was clearing roughly $9M in direct
              sales — $8.34M in 2022 to $9.02M in 2023 — margin landing on
              DHS&apos;s P&amp;L instead of a reseller&apos;s. The cash
              generated paid down over $5M of accounts payable in the
              process. Cash conversion went from a drag to an engine.
            </p>
            <p style={{ marginTop: 18 }}>
              The valuation impact was the part most owners underweight.
              When the next set of acquirer conversations came up, the
              Amazon channel was no longer a haircut item — it was a
              defensible, brand-controlled segment with operating history.
              The business&apos;s implied valuation roughly doubled across
              that window.
            </p>
            <p style={{ marginTop: 18, fontSize: 14, color: "var(--color-muted)", fontStyle: "italic" }}>
              Specific outcomes vary by category, velocity, and starting
              position. These figures reflect what channel ownership unlocked
              for DHS specifically.
            </p>
          </div>

          <div>
            <div className="m-quote">
              We were paying for our own Amazon business twice — once in
              margin we gave up to resellers, and again in the discount
              acquirers were applying to the channel. Once the playbook ran,
              both went away.
            </div>
            <div style={{ marginTop: 18, fontSize: 13, color: "var(--color-muted)", letterSpacing: "0.04em" }}>
              — Operator, Diversified Hospitality Solutions
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--color-faint)", fontStyle: "italic" }}>
              Representative paraphrase capturing the operator&apos;s view; not a literal quotation.
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="m-dark">
        <div className="container narrow">
          <div className="eyebrow">Next step</div>
          <h2 style={{ marginTop: 18 }}>Run the audit on your own channel.</h2>
          <p style={{ marginTop: 22, fontSize: "1.1rem", color: "#D5D8DD" }}>
            Same starting point we used at DHS. Free, written, no obligation.
            We&apos;ll quantify your active resellers, lost margin, and
            unlocked profit potential within 2 business days.
          </p>
          <div style={{ marginTop: 32, display: "flex", gap: 14, flexWrap: "wrap" }}>
            <Link href="/contact" className="m-btn m-btn-light">
              Request a free audit →
            </Link>
            <Link
              href="/case-studies/legion-chemicals"
              className="m-btn m-btn-outline"
              style={{ borderColor: "#fff", color: "#fff" }}
            >
              Read Legion Chemicals →
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
