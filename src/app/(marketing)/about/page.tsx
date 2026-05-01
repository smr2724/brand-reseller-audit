import Link from "next/link";

export const metadata = {
  title: "About — Rolle Management Group",
  description:
    "Operators, not consultants. RMG is a manufacturer-side e-commerce partner founded by Steve Rolle.",
};

export default function AboutPage() {
  return (
    <>
      <section className="m-hero" style={{ padding: "96px 0" }}>
        <div className="container">
          <div className="eyebrow">About</div>
          <h1 style={{ marginTop: 24, maxWidth: "22ch" }}>
            Operators. Not consultants.
          </h1>
          <p className="lede" style={{ maxWidth: "60ch" }}>
            Rolle Management Group was built around a simple observation: most
            manufacturers don&apos;t need another agency deck. They need
            someone to actually run the marketplace channel — through every
            stockout, suspension, ad-spend swing, and reseller fight.
          </p>
        </div>
      </section>

      <section className="m-section">
        <div className="container m-grid-2">
          <div>
            <div className="eyebrow">Founder</div>
            <h2 style={{ marginTop: 12 }}>Steve Rolle</h2>
            <p style={{ marginTop: 18 }}>
              Steve has spent the last decade running e-commerce P&amp;Ls
              inside manufacturing businesses, not from the outside. He grew
              the Amazon and e-commerce channel for{" "}
              <Link href="/case-studies" className="m-link">
                Diversified Hospitality Solutions
              </Link>{" "}
              from $0 in 2017 to roughly $10M / year within six years —
              operating the brands Terra Pure, Eco Botanics, Terra Breeze, and
              H2O Therapy across hotels, motels, vacation rentals, and
              universities.
            </p>
            <p style={{ marginTop: 18 }}>
              In June 2025 he launched Legion Chemicals from zero — a niche
              concrete-remover line sold in quarts, gallons, 5-gallon buckets,
              55-gallon drums, and 275-gallon totes. Ten months later it was
              clearing roughly $85,000 in a single month, on a $1M+ annualized
              run rate.
            </p>
            <p style={{ marginTop: 18 }}>
              The lesson from both: the manufacturer who actually controls the
              channel beats the reseller free-for-all every time. RMG exists
              to bring that operating discipline to other established
              manufacturers.
            </p>
          </div>

          <div>
            <div className="eyebrow">How we work</div>
            <h2 style={{ marginTop: 12 }}>Selective partnerships, daily operations.</h2>
            <ul style={{ display: "grid", gap: 18, marginTop: 18, listStyle: "none", padding: 0 }}>
              <li>
                <strong style={{ color: "var(--m-ink)" }}>Selective.</strong>{" "}
                We don&apos;t take on clients we can&apos;t move the number for.
                If the product, math, or category isn&apos;t right, we&apos;ll
                tell you.
              </li>
              <li>
                <strong style={{ color: "var(--m-ink)" }}>Hands-on.</strong>{" "}
                Listings, ads, inventory, brand registry, customer service,
                Seller Support fights. The unglamorous daily work is where the
                margin lives.
              </li>
              <li>
                <strong style={{ color: "var(--m-ink)" }}>Aligned.</strong>{" "}
                We pick a partnership model that protects the business
                you&apos;ve already built — done-for-you, wholesale / private
                label, or authorized reseller.
              </li>
              <li>
                <strong style={{ color: "var(--m-ink)" }}>Long-term.</strong>{" "}
                Marketplace channels compound. We build for years, not for the
                next launch window.
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="m-section alt">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">What we&apos;re not</div>
            <h2>A few things that make us different.</h2>
          </div>
          <div className="m-grid-3">
            <div className="m-card">
              <h3>Not an agency</h3>
              <p style={{ marginTop: 10 }}>
                Agencies bill by retainer and optimize for client count. We
                operate channels and optimize for the P&amp;L. Different
                business, different incentives.
              </p>
            </div>
            <div className="m-card">
              <h3>Not a reseller racing to the bottom</h3>
              <p style={{ marginTop: 10 }}>
                Resellers compete on price and burn the brand down with it. We
                lock the brand experience in and grow on quality, not
                discount.
              </p>
            </div>
            <div className="m-card">
              <h3>Not a consulting deck</h3>
              <p style={{ marginTop: 10 }}>
                You don&apos;t need another 60-page strategy. You need someone
                accountable to the number. That&apos;s the job.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="m-dark">
        <div className="container" style={{ maxWidth: 800 }}>
          <h2>Want to see what this actually produces?</h2>
          <p style={{ marginTop: 14, fontSize: "1.1rem" }}>
            The case studies show the work — what we touched, what changed,
            and what the channel looked like a year later.
          </p>
          <div style={{ marginTop: 28, display: "flex", gap: 14, flexWrap: "wrap" }}>
            <Link href="/case-studies" className="m-btn m-btn-light">Read the case studies →</Link>
            <Link href="/contact" className="m-btn m-btn-outline" style={{ borderColor: "#fff", color: "#fff" }}>
              Talk to Steve
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
