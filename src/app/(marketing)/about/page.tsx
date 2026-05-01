import Link from "next/link";

export const metadata = {
  title: "About — Rolle Consulting Group",
  description:
    "Operator-led Amazon channel ownership consulting for mid-market brands. Aligned incentives. Free audit.",
};

export default function AboutPage() {
  return (
    <>
      <section className="m-hero" style={{ padding: "96px 0" }}>
        <div className="container">
          <div className="eyebrow">About</div>
          <h1 style={{ marginTop: 24, maxWidth: "22ch" }}>
            We help mid-market brands take their Amazon channel back.
          </h1>
          <p className="lede" style={{ maxWidth: "62ch" }}>
            Rolle Consulting Group is an Amazon channel ownership
            consultancy. We work with brands whose product is already in
            distribution — but whose Amazon presence is being run, listed,
            and priced by someone else.
          </p>
        </div>
      </section>

      <section className="m-section">
        <div className="container m-grid-2">
          <div>
            <div className="eyebrow">Why we exist</div>
            <h2 style={{ marginTop: 12 }}>
              Brand owners lose millions because the channel is being run
              by third parties.
            </h2>
            <p style={{ marginTop: 18 }}>
              Most mid-market brands we look at have a meaningful Amazon
              footprint they don&apos;t operate. Wholesale customers,
              distributors, and unauthorized resellers list the SKUs, run
              the pricing, and capture the retail margin. The brand is
              quietly subsidizing somebody else&apos;s Amazon business.
            </p>
            <p style={{ marginTop: 18 }}>
              The fix isn&apos;t a deck. It&apos;s a sequenced operating
              plan: audit, enroll, remove, take over, scale. Run cleanly,
              the channel typically doubles in profit and contributes
              materially to enterprise value at exit.
            </p>
          </div>

          <div>
            <div className="eyebrow">How we&apos;re different</div>
            <h2 style={{ marginTop: 12 }}>Aligned incentives, operator depth, data first.</h2>
            <ul style={{ display: "grid", gap: 18, marginTop: 18, listStyle: "none", padding: 0 }}>
              <li>
                <strong style={{ color: "var(--m-ink)" }}>Aligned.</strong>{" "}
                Our fee is 50% of additional first-year profits. No
                retainer, no upfront cost. We only earn if the channel
                actually grows.
              </li>
              <li>
                <strong style={{ color: "var(--m-ink)" }}>Operator-led.</strong>{" "}
                Brand Registry, gating, MAP enforcement, FBA takeover,
                listing rebuild — done by people who&apos;ve actually run
                channels at this scale.
              </li>
              <li>
                <strong style={{ color: "var(--m-ink)" }}>Data first.</strong>{" "}
                Every engagement starts with a quantitative audit. Active
                resellers, lost margin, unit economics, projected lift —
                written down, before anyone signs anything.
              </li>
              <li>
                <strong style={{ color: "var(--m-ink)" }}>Selective.</strong>{" "}
                We don&apos;t take engagements where we can&apos;t move
                the number. The audit tells both sides whether it&apos;s
                worth doing.
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="m-section alt">
        <div className="container">
          <div className="m-section-head">
            <div className="eyebrow">Team</div>
            <h2>The people behind RCG.</h2>
            <p className="lede">
              We&apos;re a small operator-led team. We do the work
              ourselves rather than hand engagements to junior staff.
            </p>
          </div>

          {/* TODO: fill in real team bios + replace placeholder headshots */}
          <div className="m-grid-3">
            <div className="m-card">
              <div
                aria-hidden
                style={{
                  width: "100%",
                  aspectRatio: "1 / 1",
                  background:
                    "linear-gradient(135deg, var(--m-bg-alt) 0%, #ddd9cc 100%)",
                  marginBottom: 20,
                  borderRadius: 2,
                }}
              />
              <h3>Steve Rolle</h3>
              <div style={{ marginTop: 4, fontSize: 13, color: "var(--m-muted)" }}>
                Founder
              </div>
              <p style={{ marginTop: 14, fontSize: 14 }}>
                A decade running Amazon and e-commerce P&amp;Ls inside
                manufacturing businesses. Led the channel at Diversified
                Hospitality Solutions through its takeover from
                reseller-dependent to direct.
              </p>
            </div>
            <div className="m-card">
              <div
                aria-hidden
                style={{
                  width: "100%",
                  aspectRatio: "1 / 1",
                  background:
                    "linear-gradient(135deg, var(--m-bg-alt) 0%, #d6d2c4 100%)",
                  marginBottom: 20,
                  borderRadius: 2,
                }}
              />
              <h3>Channel Operations</h3>
              <div style={{ marginTop: 4, fontSize: 13, color: "var(--m-muted)" }}>
                Listings, ads, FBA
              </div>
              <p style={{ marginTop: 14, fontSize: 14 }}>
                Day-to-day operators handling listing rebuilds, advertising,
                inventory planning, and FBA takeover work across active
                engagements.
              </p>
            </div>
            <div className="m-card">
              <div
                aria-hidden
                style={{
                  width: "100%",
                  aspectRatio: "1 / 1",
                  background:
                    "linear-gradient(135deg, var(--m-bg-alt) 0%, #cfcabb 100%)",
                  marginBottom: 20,
                  borderRadius: 2,
                }}
              />
              <h3>Brand Enforcement</h3>
              <div style={{ marginTop: 4, fontSize: 13, color: "var(--m-muted)" }}>
                Brand Registry, MAP
              </div>
              <p style={{ marginTop: 14, fontSize: 14 }}>
                Brand Registry, gating, MAP policy authoring, and
                unauthorized-reseller enforcement on behalf of partner
                brands.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="m-dark">
        <div className="container" style={{ maxWidth: 800 }}>
          <h2>Want to see what this looks like in practice?</h2>
          <p style={{ marginTop: 14, fontSize: "1.1rem" }}>
            The Diversified Hospitality Solutions case study walks through
            exactly what changed, what we did, and what the channel looked
            like a year later.
          </p>
          <div style={{ marginTop: 28, display: "flex", gap: 14, flexWrap: "wrap" }}>
            <Link href="/case-studies" className="m-btn m-btn-light">
              Read the case study →
            </Link>
            <Link
              href="/contact"
              className="m-btn m-btn-outline"
              style={{ borderColor: "#fff", color: "#fff" }}
            >
              Request a free audit
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
