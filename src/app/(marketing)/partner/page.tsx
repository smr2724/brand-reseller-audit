import Link from "next/link";

export const metadata = {
  title: "Partnerships — Rolle Consulting Group",
  description:
    "Referral and co-investment partnerships with operators, M&A advisors, and lenders working with mid-market brands.",
};

export default function PartnerPage() {
  return (
    <>
      <section className="m-hero" style={{ padding: "96px 0" }}>
        <div className="container">
          <div className="eyebrow">Partnerships</div>
          <h1 style={{ marginTop: 24, maxWidth: "22ch" }}>
            Working with operators, advisors, and lenders.
          </h1>
          <p className="lede" style={{ maxWidth: "62ch" }}>
            Most of our work comes through M&amp;A advisors, lenders, and
            operating partners who notice the same pattern we do — a
            mid-market brand whose Amazon channel is being run by someone
            else, dragging on the valuation. If that&apos;s you, we&apos;d
            like to hear from you.
          </p>
        </div>
      </section>

      <section className="m-section">
        <div className="container" style={{ maxWidth: 720 }}>
          <p>
            We don&apos;t pay introduction fees, but we&apos;re happy to
            run a free Channel Ownership Audit on a portfolio brand you
            think might fit — written, quantitative, and useful as a
            diligence input regardless of whether the brand engages us.
          </p>
          <div style={{ marginTop: 32 }}>
            <Link href="/contact" className="m-btn">
              Start a conversation →
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
