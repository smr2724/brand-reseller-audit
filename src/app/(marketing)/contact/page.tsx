import Link from "next/link";
import AuditForm from "@/components/marketing/AuditForm";

export const metadata = {
  title: "Contact — Rolle Consulting Group",
  description:
    "Request a free Channel Ownership Audit. We respond within 2 business days.",
};

export default function ContactPage() {
  return (
    <>
      <section className="m-hero" style={{ padding: "96px 0 48px" }}>
        <div className="container">
          <div className="eyebrow">Contact</div>
          <h1 style={{ marginTop: 24, maxWidth: "22ch" }}>
            Get your free Channel Ownership Audit.
          </h1>
          <p className="lede" style={{ maxWidth: "62ch" }}>
            Tell us about your brand. We&apos;ll come back with a written
            audit: who&apos;s currently selling you on Amazon, the estimated
            lost margin, and what the unlocked profit looks like if you
            take the channel back.
          </p>
        </div>
      </section>

      <section className="m-section" style={{ paddingTop: 0 }}>
        <div className="container m-grid-2" style={{ alignItems: "start" }}>
          <AuditForm variant="full" sourcePage="/contact" />

          <div>
            <div className="eyebrow">What happens next</div>
            <h2 style={{ marginTop: 12, fontSize: "1.6rem" }}>
              A response within 2 business days.
            </h2>
            <ul style={{ marginTop: 22, display: "grid", gap: 18, listStyle: "none", padding: 0 }}>
              <li>
                <strong style={{ color: "var(--m-ink)" }}>1. Read.</strong>{" "}
                We&apos;ll review what you sent and pull a quick outside-in
                read on the resellers currently active on your listings.
              </li>
              <li>
                <strong style={{ color: "var(--m-ink)" }}>2. Audit.</strong>{" "}
                Within 5–7 business days, you&apos;ll get a written audit:
                active sellers, estimated lost margin per SKU, and a
                projected unlocked profit number.
              </li>
              <li>
                <strong style={{ color: "var(--m-ink)" }}>3. Decide.</strong>{" "}
                If the math is worth it for both sides, we&apos;ll propose
                an engagement. Fee is 50% of additional first-year profits.
                No upfront cost. No retainer.
              </li>
            </ul>

            <hr style={{ border: 0, borderTop: "1px solid var(--m-rule-soft)", margin: "32px 0" }} />

            <div className="eyebrow">Prefer a call?</div>
            {/* TODO: replace with real Calendly URL */}
            <p style={{ marginTop: 14 }}>
              Book 15 minutes with us:{" "}
              <Link
                href="https://calendly.com/rolle-consulting/intro"
                className="m-link"
              >
                calendly.com/rolle-consulting/intro
              </Link>
            </p>
            <p style={{ marginTop: 18, fontSize: 14, color: "var(--m-muted)" }}>
              No upfront cost. We&apos;re selective about engagements — the
              audit tells both sides whether it&apos;s worth doing.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
