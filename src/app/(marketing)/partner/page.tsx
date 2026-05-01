import Link from "next/link";

export const metadata = {
  title: "Partner With Us — Rolle Management Group",
  description:
    "Three partnership models: done-for-you under your brand, wholesale / private label, or authorized wholesale partner.",
};

export default function PartnerPage() {
  return (
    <>
      <section className="m-hero" style={{ padding: "96px 0" }}>
        <div className="container">
          <div className="eyebrow">Partner With Us</div>
          <h1 style={{ marginTop: 24, maxWidth: "22ch" }}>
            Three ways to work together. One outcome: you own the category.
          </h1>
          <p className="lede" style={{ maxWidth: "62ch" }}>
            We don&apos;t force one structure on every partner. The right model
            depends on what you&apos;ve already built, what you want to
            protect, and how hands-off you want to be on the channel itself.
          </p>
        </div>
      </section>

      {/* Three models, expanded */}
      <section className="m-section">
        <div className="container" style={{ display: "grid", gap: 56 }}>
          {/* Model 1 */}
          <div className="m-grid-2">
            <div>
              <div className="eyebrow">Model 01</div>
              <h2 style={{ marginTop: 12 }}>Done-for-you under your brand</h2>
              <p className="lede" style={{ marginTop: 18 }}>
                You keep the brand. We operate the Amazon channel end-to-end —
                listings, ads, inventory planning, customer service, brand
                registry, suspensions — under your name, on your terms, with
                full transparency.
              </p>
              <p style={{ marginTop: 18 }}>
                Best for manufacturers with an established brand identity who
                want the upside of operating the channel without building the
                team to do it.
              </p>
            </div>
            <div className="m-card" style={{ background: "var(--m-bg-alt)" }}>
              <div className="eyebrow">What we own</div>
              <ul style={{ marginTop: 14, display: "grid", gap: 10, listStyle: "none", padding: 0 }}>
                <li>· Listing copy, A+ content, video, variations</li>
                <li>· Advertising strategy and daily management</li>
                <li>· Inventory planning and replenishment cadence</li>
                <li>· Customer service and review monitoring</li>
                <li>· Brand registry, gating, and reseller enforcement</li>
                <li>· Channel P&amp;L reporting</li>
              </ul>
              <hr style={{ border: 0, borderTop: "1px solid var(--m-rule-soft)", margin: "24px 0" }} />
              <div className="eyebrow">What you keep</div>
              <ul style={{ marginTop: 14, display: "grid", gap: 10, listStyle: "none", padding: 0 }}>
                <li>· Brand ownership and identity</li>
                <li>· Wholesale, retail, and B2B channels</li>
                <li>· Final say on positioning and packaging</li>
              </ul>
            </div>
          </div>

          {/* Model 2 */}
          <div className="m-grid-2">
            <div className="m-card" style={{ background: "var(--m-bg-alt)", order: 2 }}>
              <div className="eyebrow">What we own</div>
              <ul style={{ marginTop: 14, display: "grid", gap: 10, listStyle: "none", padding: 0 }}>
                <li>· An RMG-controlled private brand</li>
                <li>· Inventory risk and channel investment</li>
                <li>· All listing assets and ad spend</li>
                <li>· Customer relationship on the marketplace</li>
              </ul>
              <hr style={{ border: 0, borderTop: "1px solid var(--m-rule-soft)", margin: "24px 0" }} />
              <div className="eyebrow">What you keep</div>
              <ul style={{ marginTop: 14, display: "grid", gap: 10, listStyle: "none", padding: 0 }}>
                <li>· Manufacturing margin on every wholesale order</li>
                <li>· Zero channel risk or operating overhead</li>
                <li>· Your existing brand, completely untouched</li>
              </ul>
            </div>
            <div style={{ order: 1 }}>
              <div className="eyebrow">Model 02</div>
              <h2 style={{ marginTop: 12 }}>Wholesale / private label</h2>
              <p className="lede" style={{ marginTop: 18 }}>
                We buy from you wholesale and sell under an RMG-controlled
                private brand. You keep the manufacturing relationship clean;
                we take on the channel risk and reward.
              </p>
              <p style={{ marginTop: 18 }}>
                Best for manufacturers who want stable wholesale volume without
                worrying about marketplace operations, MAP enforcement, or
                brand perception on Amazon at all.
              </p>
            </div>
          </div>

          {/* Model 3 */}
          <div className="m-grid-2">
            <div>
              <div className="eyebrow">Model 03</div>
              <h2 style={{ marginTop: 12 }}>Authorized wholesale partner</h2>
              <p className="lede" style={{ marginTop: 18 }}>
                We buy your branded product wholesale and operate as an
                authorized partner — keeping the listing clean, the brand
                consistent, and the unauthorized resellers in line.
              </p>
              <p style={{ marginTop: 18 }}>
                Best for manufacturers whose brand is already on Amazon but
                being run into the ground by a long tail of resellers, with no
                one accountable to the listing or the customer experience.
              </p>
            </div>
            <div className="m-card" style={{ background: "var(--m-bg-alt)" }}>
              <div className="eyebrow">What we own</div>
              <ul style={{ marginTop: 14, display: "grid", gap: 10, listStyle: "none", padding: 0 }}>
                <li>· Buy-box ownership and pricing discipline</li>
                <li>· Listing quality and content fidelity</li>
                <li>· Reseller policing under brand registry</li>
                <li>· Customer service for marketplace orders</li>
              </ul>
              <hr style={{ border: 0, borderTop: "1px solid var(--m-rule-soft)", margin: "24px 0" }} />
              <div className="eyebrow">What you keep</div>
              <ul style={{ marginTop: 14, display: "grid", gap: 10, listStyle: "none", padding: 0 }}>
                <li>· Brand ownership and full pricing authority</li>
                <li>· All other channels untouched</li>
                <li>· A predictable wholesale customer</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Fit / not-fit */}
      <section className="m-section alt">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">Who this is for</div>
            <h2>We&apos;re selective. Here&apos;s the honest filter.</h2>
          </div>
          <div className="m-grid-2">
            <div className="m-card">
              <h3>Good fit</h3>
              <ul style={{ marginTop: 14, display: "grid", gap: 10, listStyle: "none", padding: 0 }}>
                <li>· Established manufacturer with proven product</li>
                <li>· Practical category — utility &gt; novelty</li>
                <li>· Real margin to support paid acquisition</li>
                <li>· Willing to give one operator real authority on the channel</li>
                <li>· Long-term mindset — comfortable building over years</li>
              </ul>
            </div>
            <div className="m-card">
              <h3>Probably not a fit</h3>
              <ul style={{ marginTop: 14, display: "grid", gap: 10, listStyle: "none", padding: 0 }}>
                <li>· Pre-product or unproven prototype</li>
                <li>· Razor-thin margins that can&apos;t fund ads</li>
                <li>· Saturated commodity with no real differentiation</li>
                <li>· Multiple channel partners we&apos;d have to compete with internally</li>
                <li>· Looking for a 90-day spike, not a long-term channel</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="m-dark">
        <div className="container" style={{ maxWidth: 800 }}>
          <h2>Tell us about your product.</h2>
          <p style={{ marginTop: 14, fontSize: "1.1rem" }}>
            A few honest questions and we&apos;ll know fast whether we can
            actually move the number for you.
          </p>
          <div style={{ marginTop: 28, display: "flex", gap: 14, flexWrap: "wrap" }}>
            <Link href="/contact" className="m-btn m-btn-light">Start the conversation →</Link>
            <Link href="/case-studies" className="m-btn m-btn-outline" style={{ borderColor: "#fff", color: "#fff" }}>
              See proof first
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
