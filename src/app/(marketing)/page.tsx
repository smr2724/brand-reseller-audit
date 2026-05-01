import Link from "next/link";

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="m-hero">
        <div className="container">
          <div className="eyebrow">Rolle Management Group</div>
          <h1 style={{ marginTop: 24 }}>
            You already make the product.<br />
            We build the e-commerce engine around it.
          </h1>
          <p className="lede">
            Rolle Management Group helps established manufacturers identify and
            capture overlooked Amazon and marketplace opportunities — without
            disrupting the existing business they&apos;ve already built.
          </p>
          <div className="m-hero-cta">
            <Link href="/partner" className="m-btn">Partner with us →</Link>
            <Link href="/case-studies" className="m-btn m-btn-outline">See the case studies</Link>
          </div>
        </div>
      </section>

      {/* Stats band — real metrics, no fluff */}
      <section>
        <div className="container">
          <div className="m-stats">
            <div className="m-stat">
              <div className="num">$60M+</div>
              <div className="lbl">Lifetime Amazon sales operated across partner brands</div>
            </div>
            <div className="m-stat">
              <div className="num">$10M / yr</div>
              <div className="lbl">Hospitality consumables channel grown from $0 in 6 years</div>
            </div>
            <div className="m-stat">
              <div className="num">$1M+ ARR</div>
              <div className="lbl">Run-rate built on Legion Chemicals in 10 months from launch</div>
            </div>
            <div className="m-stat">
              <div className="num">$716.9B</div>
              <div className="lbl">Amazon&apos;s 2025 net sales — the marketplace you&apos;re missing</div>
            </div>
          </div>
        </div>
      </section>

      {/* The problem / positioning */}
      <section className="m-section">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">The Problem</div>
            <h2>You make a great product. The marketplace is eating you anyway.</h2>
            <p className="lede">
              Most established manufacturers don&apos;t lose because their product
              isn&apos;t good — they lose because no one is operating the channel.
              Resellers list the SKU, race the price down, run the reviews into
              the ground, and treat your brand as a commodity. Meanwhile the
              category leader is whoever bothers to show up every day.
            </p>
          </div>

          <div className="m-grid-3">
            <div className="m-card">
              <h3>Resellers run the show</h3>
              <p>
                Whoever lists first writes the listing. Whoever races the price
                down owns the buy-box. The brand owner is last to hear when
                things break.
              </p>
            </div>
            <div className="m-card">
              <h3>Listings as afterthoughts</h3>
              <p>
                Title, bullets, A+ content, backend keywords, video, variations,
                pricing strategy — most categories you&apos;d call &ldquo;competitive&rdquo; have
                listings that wouldn&apos;t pass a 10-minute audit.
              </p>
            </div>
            <div className="m-card">
              <h3>No one operates the channel</h3>
              <p>
                Inventory, ads, reviews, complaints, returns, brand registry,
                gating, suspensions — Amazon is a full-time business. Treat it
                like one and the math changes.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* What we do — six-step playbook */}
      <section className="m-section alt">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">The Playbook</div>
            <h2>Six steps from overlooked SKU to category leader.</h2>
          </div>

          <div className="m-grid-2">
            {[
              {
                n: "01",
                t: "Find the overlooked category",
                p: "Real demand, weak competition, a clear path in. Not the obvious crowded niches — the boring practical ones nobody else wants to do.",
              },
              {
                n: "02",
                t: "Find the real product",
                p: "Match the opportunity to a manufacturer who actually makes it. We don't drop-ship guesses — we source from operators who can scale.",
              },
              {
                n: "03",
                t: "Build the marketplace strategy",
                p: "Done-for-you under your brand. Wholesale and private label. Or authorized reseller. Pick the model that protects the business you've already built.",
              },
              {
                n: "04",
                t: "Build the listing as an asset",
                p: "Title, bullets, A+ content, video, variations, backend keywords — engineered to convert and to compound over time, not to look pretty.",
              },
              {
                n: "05",
                t: "Operate the channel",
                p: "Inventory planning, ads, reviews, customer service, brand registry, suspensions. Daily operator work — that's the moat.",
              },
              {
                n: "06",
                t: "Scale what works",
                p: "Once a category proves out, expand SKUs, sizes, formats, and adjacent products. Compound the wins; cut the losers fast.",
              },
            ].map((step) => (
              <div key={step.n} className="m-card">
                <div className="m-numbered">
                  <span className="n">{step.n}</span>
                </div>
                <h3>{step.t}</h3>
                <p style={{ marginTop: 10 }}>{step.p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Partnership models */}
      <section className="m-section">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">Partnership Models</div>
            <h2>Three ways we work with manufacturers.</h2>
            <p className="lede">
              We don&apos;t force one structure. The right model depends on what
              you&apos;ve already built, what you want to protect, and how
              hands-off you want to be.
            </p>
          </div>

          <div className="m-grid-3">
            <div className="m-card">
              <div className="eyebrow" style={{ marginBottom: 14 }}>Model 01</div>
              <h3>Done-for-you under your brand</h3>
              <p style={{ marginTop: 12 }}>
                You keep the brand. We operate the Amazon channel end-to-end —
                listings, ads, inventory, customer service, brand registry —
                under your name, on your terms, with full transparency.
              </p>
            </div>
            <div className="m-card">
              <div className="eyebrow" style={{ marginBottom: 14 }}>Model 02</div>
              <h3>Wholesale / private label</h3>
              <p style={{ marginTop: 12 }}>
                We buy from you wholesale and sell under an RMG-controlled
                private brand. You keep the manufacturing relationship clean;
                we own the channel risk and reward.
              </p>
            </div>
            <div className="m-card">
              <div className="eyebrow" style={{ marginBottom: 14 }}>Model 03</div>
              <h3>Authorized wholesale partner</h3>
              <p style={{ marginTop: 12 }}>
                We buy your branded product wholesale and operate as an
                authorized partner — keeping the listing clean, the brand
                consistent, and the resellers in line.
              </p>
            </div>
          </div>

          <div style={{ marginTop: 48 }}>
            <Link href="/partner" className="m-btn">Find the right model →</Link>
          </div>
        </div>
      </section>

      {/* Pull quote */}
      <section className="m-section alt">
        <div className="container" style={{ maxWidth: 880 }}>
          <div className="m-quote">
            &ldquo;Most manufacturers don&apos;t need a louder website. They need
            someone to actually run the marketplace channel like a business —
            every day, with discipline, for years.&rdquo;
          </div>
          <div style={{ marginTop: 20, fontSize: 14, color: "var(--m-muted)" }}>
            — Steve Rolle, Founder
          </div>
        </div>
      </section>

      {/* CTA dark band */}
      <section className="m-dark">
        <div className="container" style={{ display: "grid", gap: 24, maxWidth: 880 }}>
          <div className="eyebrow" style={{ color: "#a4adb8" }}>Let&apos;s talk</div>
          <h2>If you make something practical and useful — talk to us.</h2>
          <p style={{ fontSize: "1.1rem" }}>
            We&apos;re selective about who we partner with. Tell us about your
            product, your current channel mix, and where you think the
            opportunity is. If it&apos;s a fit, we&apos;ll know fast.
          </p>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 12 }}>
            <Link href="/contact" className="m-btn m-btn-light">Start a conversation →</Link>
            <Link href="/case-studies" className="m-btn m-btn-outline" style={{ borderColor: "#fff", color: "#fff" }}>
              See proof first
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
