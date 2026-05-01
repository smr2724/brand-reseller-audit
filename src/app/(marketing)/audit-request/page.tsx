import AuditRequestForm from "@/components/marketing/AuditRequestForm";

export const metadata = {
  title: "Free Channel Ownership Audit — Rolle Consulting Group",
  description:
    "Get a free Channel Ownership Audit for your Amazon brand in under 10 minutes. Verified resellers, lost margin, and the recapture roadmap — no upfront cost.",
};

export const dynamic = "force-dynamic";

export default function AuditRequestPage() {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
  return (
    <>
      <section className="m-hero" style={{ paddingBottom: 48 }}>
        <div className="container">
          <div className="m-hero-eyebrow-row">
            <span className="dot" aria-hidden />
            <span className="eyebrow">Free Audit</span>
          </div>
          <h1>Get a free Channel Ownership Audit for your Amazon brand in under 10 minutes.</h1>
          <p className="lede" style={{ maxWidth: "60ch" }}>
            Tell us your brand. We&rsquo;ll map every reseller currently
            sitting on your Buy Box, the share of your sales they&rsquo;re
            pulling, and a real-numbers estimate of the margin you can
            recapture by taking the channel back.
          </p>
        </div>
      </section>

      <section className="m-section" style={{ paddingTop: 0 }}>
        <div className="container m-grid-2" style={{ alignItems: "start" }}>
          <AuditRequestForm turnstileSiteKey={siteKey} />

          <div>
            <div className="eyebrow">What you&rsquo;ll get</div>
            <h2 style={{ marginTop: 14, fontSize: "1.7rem" }}>
              A full v2 Channel Ownership Audit, in your inbox.
            </h2>
            <ol style={{ marginTop: 28, display: "grid", gap: 22, listStyle: "none", padding: 0 }}>
              <Step n="1" t="Confirm by email">
                We send a one-click verification link to make sure
                we&rsquo;ve got the right inbox &mdash; nothing happens
                until you click.
              </Step>
              <Step n="2" t="Audit runs automatically">
                Keepa + DataForSEO pull your live Amazon channel data,
                resellers, and search visibility.
              </Step>
              <Step n="3" t="Report delivered">
                A v2 Channel Ownership Audit lands in your inbox in
                5&ndash;10 minutes, with the unlocked-margin number on the
                first page.
              </Step>
            </ol>
            <p style={{ marginTop: 24, fontSize: 12, color: "var(--color-muted)", letterSpacing: "0.02em" }}>
              No upfront cost. No obligation. We only follow up if the math is worth it for both sides.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}

function Step({ n, t, children }: { n: string; t: string; children: React.ReactNode }) {
  return (
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
        {n}
      </span>
      <div>
        <div style={{ fontWeight: 500 }}>{t}</div>
        <div style={{ marginTop: 4, color: "var(--color-ink-soft)", lineHeight: 1.6 }}>{children}</div>
      </div>
    </li>
  );
}
