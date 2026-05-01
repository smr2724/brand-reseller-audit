"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

interface Props {
  turnstileSiteKey: string;
}

const ROLES = [
  "Founder/CEO",
  "Brand Manager",
  "Ops",
  "Marketing",
  "Other",
] as const;

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string;
          callback: (token: string) => void;
          "error-callback"?: () => void;
          "expired-callback"?: () => void;
          theme?: "light" | "dark" | "auto";
        },
      ) => string;
      reset: (id?: string) => void;
    };
  }
}

export default function AuditRequestForm({ turnstileSiteKey }: Props) {
  const [submitted, setSubmitted] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileEl = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  // Render the Turnstile widget once the script is loaded.
  useEffect(() => {
    function tryRender() {
      if (!turnstileSiteKey) return;
      if (!turnstileEl.current || !window.turnstile) return false;
      if (widgetIdRef.current) return true;
      widgetIdRef.current = window.turnstile.render(turnstileEl.current, {
        sitekey: turnstileSiteKey,
        theme: "light",
        callback: (token: string) => setTurnstileToken(token),
        "error-callback": () => setTurnstileToken(null),
        "expired-callback": () => setTurnstileToken(null),
      });
      return true;
    }
    if (!tryRender()) {
      const t = setInterval(() => {
        if (tryRender()) clearInterval(t);
      }, 200);
      return () => clearInterval(t);
    }
  }, [turnstileSiteKey]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const params =
      typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    const payload = {
      brand_name: String(fd.get("brand_name") ?? "").trim(),
      contact_name: String(fd.get("contact_name") ?? "").trim(),
      email: String(fd.get("email") ?? "").trim(),
      phone: String(fd.get("phone") ?? "").trim(),
      role: String(fd.get("role") ?? "").trim() || null,
      pain_point: String(fd.get("pain_point") ?? "").trim() || null,
      turnstile_token: turnstileToken,
      utm_source: params?.get("utm_source") ?? null,
      utm_medium: params?.get("utm_medium") ?? null,
      utm_campaign: params?.get("utm_campaign") ?? null,
    };
    try {
      const res = await fetch("/api/public/audit-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "submission failed");
      setSubmittedEmail(payload.email);
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "submission failed");
      // Reset turnstile so the user can submit again.
      try {
        window.turnstile?.reset(widgetIdRef.current ?? undefined);
        setTurnstileToken(null);
      } catch {}
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <div
        className="m-form"
        style={{ background: "#fff", border: "1px solid var(--color-rule)", padding: 36, borderRadius: 2 }}
      >
        <div className="eyebrow">Almost there</div>
        <h3
          style={{
            marginTop: 12,
            fontFamily: "var(--font-fraunces), Georgia, serif",
            fontSize: "1.7rem",
            fontWeight: 400,
            letterSpacing: "-0.02em",
            color: "var(--color-ink)",
            lineHeight: 1.2,
          }}
        >
          Check your email.
        </h3>
        <p style={{ marginTop: 18, color: "var(--color-ink-soft)", lineHeight: 1.6 }}>
          We just sent a verification link to{" "}
          <strong>{submittedEmail}</strong>. Click it and your audit will
          start running &mdash; the report lands in your inbox in 5&ndash;10
          minutes.
        </p>
        <p style={{ marginTop: 14, fontSize: 13, color: "var(--color-muted)" }}>
          Don&rsquo;t see it? Check spam, or write to steve@rollemanagementgroup.com.
        </p>
      </div>
    );
  }

  return (
    <>
      {turnstileSiteKey ? (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          strategy="afterInteractive"
          async
          defer
        />
      ) : null}
      <form
        onSubmit={onSubmit}
        className="m-form"
        style={{ background: "#fff", border: "1px solid var(--color-rule)", padding: 32, borderRadius: 2 }}
      >
        <div className="m-grid-2" style={{ gap: 18 }}>
          <div className="field">
            <label htmlFor="brand_name">Brand name *</label>
            <input id="brand_name" name="brand_name" required maxLength={200} autoComplete="organization" />
          </div>
          <div className="field">
            <label htmlFor="contact_name">Your name *</label>
            <input id="contact_name" name="contact_name" required maxLength={200} autoComplete="name" />
          </div>
        </div>
        <div className="m-grid-2" style={{ gap: 18 }}>
          <div className="field">
            <label htmlFor="email">Work email *</label>
            <input
              id="email"
              name="email"
              type="email"
              required
              maxLength={320}
              autoComplete="email"
              placeholder="you@yourbrand.com"
            />
            <div className="field-help">
              We block free-mail providers (gmail, yahoo, etc) so we can verify
              you actually own the brand.
            </div>
          </div>
          <div className="field">
            <label htmlFor="phone">Phone *</label>
            <input id="phone" name="phone" type="tel" required maxLength={40} autoComplete="tel" />
          </div>
        </div>
        <div className="m-grid-2" style={{ gap: 18 }}>
          <div className="field">
            <label htmlFor="role">Your role</label>
            <select id="role" name="role" defaultValue="">
              <option value="">Select…</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pain_point">What&rsquo;s bothering you most</label>
            <input id="pain_point" name="pain_point" maxLength={200} placeholder="e.g. Too many resellers" />
          </div>
        </div>

        {turnstileSiteKey ? (
          <div className="field" style={{ marginTop: 8 }}>
            <div ref={turnstileEl} />
          </div>
        ) : null}

        {error && (
          <div
            role="alert"
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
              padding: 12,
              borderRadius: 2,
              marginBottom: 14,
              fontSize: 14,
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          className="m-btn submit"
          disabled={loading || (!!turnstileSiteKey && !turnstileToken)}
          style={{ marginTop: 6, justifyContent: "center" }}
        >
          {loading ? "Submitting…" : "Get my free Channel Ownership Audit"}
        </button>
        <p style={{ marginTop: 16, fontSize: 12, color: "var(--color-muted)", letterSpacing: "0.02em" }}>
          You&rsquo;ll get a verification email in a moment. The audit runs as
          soon as you click the link.
        </p>
      </form>
    </>
  );
}
