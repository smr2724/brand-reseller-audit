import Link from "next/link";
import AuditForm from "@/components/marketing/AuditForm";

export const metadata = {
  title: "Free Channel Ownership Audit — Rolle Consulting Group",
  description:
    "Two inputs. One roadmap. No obligation. Roadmap delivered within 2 business days.",
};

export default function ContactPage() {
  return (
    <>
      <section className="m-hero" style={{ paddingBottom: 56 }}>
        <div className="container">
          <div className="m-hero-eyebrow-row">
            <span className="dot" aria-hidden />
            <span className="eyebrow">Contact</span>
          </div>
          <h1>Your free Channel Ownership Audit.</h1>
          <p className="lede" style={{ maxWidth: "60ch" }}>
            Two inputs. One roadmap. No obligation. We&apos;ll come back
            with a written audit within 2 business days: who&apos;s
            currently selling you on Amazon, the estimated lost margin, and
            what the unlocked profit looks like.
          </p>
        </div>
      </section>

      <section className="m-section" style={{ paddingTop: 0 }}>
        <div className="container m-grid-2" style={{ alignItems: "start" }}>
          <AuditForm variant="full" sourcePage="/contact" />

          <div>
            <div className="eyebrow">What happens next</div>
            <h2 style={{ marginTop: 14, fontSize: "1.7rem" }}>
              A response within 2 business days.
            </h2>

            <ol style={{ marginTop: 28, display: "grid", gap: 22, listStyle: "none", padding: 0 }}>
              <li style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 18, alignItems: "start" }}>
                <span
                  style={{
                    fontFamily: "var(--font-fraunces), Georgia, serif",
                    fontStyle: "italic",
                    color: "var(--color-accent-ink)",
                    fontSize: 22,
                    fontVariantNumeric: "tabular-nums",
                    minWidth: 28,
                  }}
                >
                  01
                </span>
                <div>
                  <strong style={{ color: "var(--color-ink)", display: "block", marginBottom: 4 }}>
                    Read.
                  </strong>
                  We&apos;ll review what you sent and pull a quick
                  outside-in read on the resellers currently active on your
                  listings.
                </div>
              </li>
              <li style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 18, alignItems: "start" }}>
                <span
                  style={{
                    fontFamily: "var(--font-fraunces), Georgia, serif",
                    fontStyle: "italic",
                    color: "var(--color-accent-ink)",
                    fontSize: 22,
                    fontVariantNumeric: "tabular-nums",
                    minWidth: 28,
                  }}
                >
                  02
                </span>
                <div>
                  <strong style={{ color: "var(--color-ink)", display: "block", marginBottom: 4 }}>
                    Audit.
                  </strong>
                  Within 2 business days, you&apos;ll get a written audit:
                  active sellers, estimated lost margin per SKU, and a
                  projected unlocked profit number.
                </div>
              </li>
              <li style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 18, alignItems: "start" }}>
                <span
                  style={{
                    fontFamily: "var(--font-fraunces), Georgia, serif",
                    fontStyle: "italic",
                    color: "var(--color-accent-ink)",
                    fontSize: 22,
                    fontVariantNumeric: "tabular-nums",
                    minWidth: 28,
                  }}
                >
                  03
                </span>
                <div>
                  <strong style={{ color: "var(--color-ink)", display: "block", marginBottom: 4 }}>
                    Decide.
                  </strong>
                  If the math is worth it for both sides, we&apos;ll
                  propose an engagement. 50% of the additional first-year
                  profit. No upfront cost. No retainer.
                </div>
              </li>
            </ol>

            <hr className="rule" style={{ margin: "36px 0" }} />

            <div className="eyebrow">Prefer a call?</div>
            {/* TODO: replace with real Calendly URL */}
            <p style={{ marginTop: 14 }}>
              Book 15 minutes:{" "}
              <Link
                href="https://calendly.com/rolle-consulting/intro"
                className="m-link"
              >
                calendly.com/rolle-consulting/intro
              </Link>
            </p>
            <p style={{ marginTop: 18, fontSize: 13, color: "var(--color-muted)" }}>
              No upfront cost. We&apos;re selective about engagements — the
              audit tells both sides whether it&apos;s worth doing.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
