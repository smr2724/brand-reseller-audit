"use client";

import { useState } from "react";

export default function ContactPage() {
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);

    // Build a mailto with the form contents — works without a backend.
    const fd = new FormData(e.currentTarget);
    const body = [
      `Name: ${fd.get("name") ?? ""}`,
      `Company: ${fd.get("company") ?? ""}`,
      `Email: ${fd.get("email") ?? ""}`,
      `Phone: ${fd.get("phone") ?? ""}`,
      `Best fit model: ${fd.get("model") ?? ""}`,
      `Annual revenue: ${fd.get("revenue") ?? ""}`,
      "",
      "About the product / opportunity:",
      `${fd.get("message") ?? ""}`,
    ].join("\n");

    const mailto =
      "mailto:steve@rollemanagementgroup.com" +
      `?subject=${encodeURIComponent("Partnership inquiry — " + (fd.get("company") ?? ""))}` +
      `&body=${encodeURIComponent(body)}`;

    window.location.href = mailto;
    setSubmitted(true);
    setLoading(false);
  }

  return (
    <>
      <section className="m-hero" style={{ padding: "96px 0 72px" }}>
        <div className="container">
          <div className="eyebrow">Contact</div>
          <h1 style={{ marginTop: 24, maxWidth: "22ch" }}>
            Tell us what you make. We&apos;ll tell you fast if we can move the number.
          </h1>
          <p className="lede" style={{ maxWidth: "60ch" }}>
            The more honest you are about the product, the channel mix, and
            the margin, the more useful our first reply will be.
          </p>
        </div>
      </section>

      <section className="m-section" style={{ paddingTop: 0 }}>
        <div className="container m-grid-2" style={{ alignItems: "start" }}>
          <div className="m-card m-form">
            {submitted ? (
              <div>
                <div className="eyebrow">Message ready</div>
                <h3 style={{ marginTop: 12 }}>Your email client should be opening now.</h3>
                <p style={{ marginTop: 14 }}>
                  If it didn&apos;t, write us directly at{" "}
                  <a className="m-link" href="mailto:steve@rollemanagementgroup.com">
                    steve@rollemanagementgroup.com
                  </a>
                  .
                </p>
              </div>
            ) : (
              <form onSubmit={onSubmit}>
                <div className="m-grid-2" style={{ gap: 18 }}>
                  <div className="field">
                    <label htmlFor="name">Your name</label>
                    <input id="name" name="name" required />
                  </div>
                  <div className="field">
                    <label htmlFor="company">Company</label>
                    <input id="company" name="company" required />
                  </div>
                </div>
                <div className="m-grid-2" style={{ gap: 18 }}>
                  <div className="field">
                    <label htmlFor="email">Email</label>
                    <input id="email" name="email" type="email" required />
                  </div>
                  <div className="field">
                    <label htmlFor="phone">Phone (optional)</label>
                    <input id="phone" name="phone" />
                  </div>
                </div>
                <div className="m-grid-2" style={{ gap: 18 }}>
                  <div className="field">
                    <label htmlFor="model">Best fit model</label>
                    <select id="model" name="model" defaultValue="">
                      <option value="" disabled>Pick one…</option>
                      <option>Done-for-you under our brand</option>
                      <option>Wholesale / private label</option>
                      <option>Authorized wholesale partner</option>
                      <option>Not sure yet</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="revenue">Approx. annual revenue</label>
                    <select id="revenue" name="revenue" defaultValue="">
                      <option value="" disabled>Pick one…</option>
                      <option>Under $1M</option>
                      <option>$1M – $5M</option>
                      <option>$5M – $25M</option>
                      <option>$25M – $100M</option>
                      <option>$100M+</option>
                    </select>
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="message">About the product / opportunity</label>
                  <textarea
                    id="message"
                    name="message"
                    placeholder="What do you make? Who buys it today? Where do you think the marketplace opportunity is — and what's blocked it so far?"
                    required
                  />
                </div>
                <button type="submit" className="m-btn" disabled={loading}>
                  {loading ? "Opening email…" : "Send to Steve →"}
                </button>
              </form>
            )}
          </div>

          <div>
            <div className="eyebrow">Direct</div>
            <h2 style={{ marginTop: 12 }}>Or just write us.</h2>
            <p style={{ marginTop: 18 }}>
              <a className="m-link" href="mailto:steve@rollemanagementgroup.com">
                steve@rollemanagementgroup.com
              </a>
            </p>

            <hr style={{ border: 0, borderTop: "1px solid var(--m-rule-soft)", margin: "32px 0" }} />

            <div className="eyebrow">What happens next</div>
            <ul style={{ marginTop: 14, display: "grid", gap: 14, listStyle: "none", padding: 0 }}>
              <li>
                <strong style={{ color: "var(--m-ink)" }}>1. Quick read.</strong>{" "}
                We&apos;ll review what you sent and pull a fast outside-in look
                at the category on the marketplace.
              </li>
              <li>
                <strong style={{ color: "var(--m-ink)" }}>2. 30-min call.</strong>{" "}
                If it looks like a fit, we&apos;ll set up a working call —
                product, margin, current channel mix, what you want protected.
              </li>
              <li>
                <strong style={{ color: "var(--m-ink)" }}>3. Honest yes or no.</strong>{" "}
                If we can move the number, we&apos;ll propose a model. If we
                can&apos;t, we&apos;ll tell you that too — and usually point
                you to someone who can.
              </li>
            </ul>
          </div>
        </div>
      </section>
    </>
  );
}
