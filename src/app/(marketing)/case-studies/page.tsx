import Link from "next/link";

export const metadata = {
  title: "Case Studies — Rolle Management Group",
  description:
    "Two channels built from the manufacturer side: Diversified Hospitality Solutions and Legion Chemicals.",
};

export default function CaseStudiesPage() {
  return (
    <>
      <section className="m-hero" style={{ padding: "96px 0" }}>
        <div className="container">
          <div className="eyebrow">Case Studies</div>
          <h1 style={{ marginTop: 24, maxWidth: "22ch" }}>
            Two channels. Built from zero. Operated from the manufacturer side.
          </h1>
          <p className="lede" style={{ maxWidth: "60ch" }}>
            Both stories below started with a real product, a manufacturer
            willing to let an operator run the channel, and the unglamorous
            daily work to compound it.
          </p>
        </div>
      </section>

      {/* Case 1 — DHS */}
      <section className="m-section">
        <div className="container m-grid-2 m-case">
          <div>
            <div className="meta">Case Study 01 · Hospitality consumables</div>
            <h2 style={{ fontSize: "2rem", lineHeight: 1.1 }}>
              Diversified Hospitality Solutions
            </h2>
            <p className="lede" style={{ marginTop: 18 }}>
              Steve grew the Amazon and e-commerce channel for DHS from $0 in
              2017 to roughly $10M / year within six years — operating the
              brands Terra Pure, Eco Botanics, Terra Breeze, and H2O Therapy.
            </p>
            <p style={{ marginTop: 18 }}>
              The categories: hospitality consumables — soaps, shampoos,
              lotions, body wash, detergents — sold to hotels, motels, vacation
              rentals, and universities. Boring on paper. Real money in
              practice.
            </p>
            <p style={{ marginTop: 18 }}>
              The lesson: the manufacturer who takes control of the channel
              beats reseller chaos every time. When listings, ads, inventory,
              and brand registry are run as one operation, the brand becomes a
              compounding asset instead of a commodity.
            </p>
          </div>

          <div className="m-card" style={{ background: "var(--m-bg-alt)", border: "1px solid var(--m-rule-soft)" }}>
            <div className="eyebrow">Outcome</div>
            <div className="result" style={{ marginTop: 14 }}>$0 → ~$10M / yr</div>
            <div style={{ fontSize: 14, color: "var(--m-muted)", marginTop: 6 }}>Six years operating the channel</div>

            <hr style={{ border: 0, borderTop: "1px solid var(--m-rule-soft)", margin: "28px 0" }} />

            <div className="eyebrow">Lifetime channel value</div>
            <div className="result" style={{ marginTop: 14 }}>$60M+</div>
            <div style={{ fontSize: 14, color: "var(--m-muted)", marginTop: 6 }}>Across the portfolio of brands</div>

            <hr style={{ border: 0, borderTop: "1px solid var(--m-rule-soft)", margin: "28px 0" }} />

            <div className="eyebrow">Brands operated</div>
            <ul style={{ display: "grid", gap: 6, marginTop: 12, listStyle: "none", padding: 0, fontSize: 14, color: "var(--m-ink)" }}>
              <li>Terra Pure</li>
              <li>Eco Botanics</li>
              <li>Terra Breeze</li>
              <li>H2O Therapy</li>
            </ul>
          </div>
        </div>
      </section>

      {/* Case 2 — Legion */}
      <section className="m-section alt">
        <div className="container m-grid-2 m-case">
          <div className="m-card" style={{ background: "#fff", border: "1px solid var(--m-rule-soft)", order: 2 }}>
            <div className="eyebrow">Outcome</div>
            <div className="result" style={{ marginTop: 14 }}>$0 → $85K / mo</div>
            <div style={{ fontSize: 14, color: "var(--m-muted)", marginTop: 6 }}>10 months from launch (June 2025 → April 2026)</div>

            <hr style={{ border: 0, borderTop: "1px solid var(--m-rule-soft)", margin: "28px 0" }} />

            <div className="eyebrow">Run rate</div>
            <div className="result" style={{ marginTop: 14 }}>$1M+ ARR</div>
            <div style={{ fontSize: 14, color: "var(--m-muted)", marginTop: 6 }}>And accelerating</div>

            <hr style={{ border: 0, borderTop: "1px solid var(--m-rule-soft)", margin: "28px 0" }} />

            <div className="eyebrow">Pack sizes operated</div>
            <ul style={{ display: "grid", gap: 6, marginTop: 12, listStyle: "none", padding: 0, fontSize: 14, color: "var(--m-ink)" }}>
              <li>Quarts</li>
              <li>Gallons</li>
              <li>5-gallon buckets</li>
              <li>55-gallon drums</li>
              <li>275-gallon totes</li>
            </ul>
          </div>

          <div style={{ order: 1 }}>
            <div className="meta">Case Study 02 · Industrial chemicals</div>
            <h2 style={{ fontSize: "2rem", lineHeight: 1.1 }}>Legion Chemicals</h2>
            <p className="lede" style={{ marginTop: 18 }}>
              Niche concrete remover. Launched in June 2025 from a standing
              start. By April 2026 — ten months in — clearing roughly $85,000
              in a single month, on a $1M+ annualized run rate.
            </p>
            <p style={{ marginTop: 18 }}>
              The product is practical, not flashy. Pros use it on real job
              sites. The pack-size ladder — quarts to 275-gallon totes — lets
              the same listing serve the homeowner with a stained driveway
              and the contractor specing pallets.
            </p>
            <p style={{ marginTop: 18 }}>
              The lesson: niche, practical products with real utility win on
              Amazon when someone actually operates the channel. Glamour is
              optional. Discipline isn&apos;t.
            </p>
          </div>
        </div>
      </section>

      {/* Why this matters */}
      <section className="m-section">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">Why these stories matter</div>
            <h2>The pattern is portable.</h2>
            <p className="lede">
              Different categories, different price points, different buyers.
              The mechanics are the same — find the overlooked niche, partner
              with the right manufacturer, build the listing as an asset,
              operate the channel daily. Then scale what works.
            </p>
          </div>
          <div className="m-grid-3">
            <div className="m-card">
              <h3>Built from zero</h3>
              <p style={{ marginTop: 10 }}>
                No legacy listings, no lucky parent ASIN. Both channels were
                started from a standing start and grown by operating decisions.
              </p>
            </div>
            <div className="m-card">
              <h3>Compounding, not spiking</h3>
              <p style={{ marginTop: 10 }}>
                Marketplace channels reward consistency. Reviews compound, ad
                relevance compounds, ranking compounds. We build for that.
              </p>
            </div>
            <div className="m-card">
              <h3>Manufacturer-aligned</h3>
              <p style={{ marginTop: 10 }}>
                Both stories were built side-by-side with the manufacturer —
                not on top of them. That alignment is the entire point.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="m-dark">
        <div className="container" style={{ maxWidth: 760 }}>
          <h2>Think your product fits the pattern?</h2>
          <p style={{ marginTop: 14, fontSize: "1.1rem" }}>
            Send us what you make. If the math works, we&apos;ll move fast.
          </p>
          <div style={{ marginTop: 28, display: "flex", gap: 14, flexWrap: "wrap" }}>
            <Link href="/partner" className="m-btn m-btn-light">See partnership models →</Link>
            <Link href="/contact" className="m-btn m-btn-outline" style={{ borderColor: "#fff", color: "#fff" }}>
              Contact Steve
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
