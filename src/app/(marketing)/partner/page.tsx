import Link from "next/link";

export const metadata = {
  title: "Partner — Rolle Consulting Group",
  description:
    "For agencies, M&A advisors, and fractional CFOs working with mid-market brands that have an Amazon channel problem.",
};

export default function PartnerPage() {
  return (
    <>
      <section className="m-hero">
        <div className="container">
          <div className="m-hero-eyebrow-row">
            <span className="dot" aria-hidden />
            <span className="eyebrow">Partner</span>
          </div>
          <h1>For agencies, M&amp;A advisors, and fractional CFOs.</h1>
          <p className="lede">
            If you advise mid-market brand owners and you&apos;ve seen the
            same pattern we have — a brand whose Amazon channel is being
            run by someone else, dragging on the valuation — we&apos;d like
            to hear from you.
          </p>
        </div>
      </section>

      <section className="m-section">
        <div className="container prose">
          <p>
            The pattern is simple. You identify a portfolio brand with an
            Amazon problem. We run a free Channel Ownership Audit —
            written, quantitative, useful as a diligence input regardless
            of whether the brand engages us. If the brand decides to take
            the channel back, we operate the playbook on aligned-incentive
            terms (50% of the additional first-year profit, no retainer).
            You get a transparent referral relationship. We don&apos;t pay
            introduction fees, but we make our partners look good.
          </p>
          <div style={{ marginTop: 36 }}>
            <Link href="/contact" className="m-btn">
              Start a conversation →
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
