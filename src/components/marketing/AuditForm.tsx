"use client";

import { useState } from "react";

type Variant = "compact" | "full";

interface Props {
  variant?: Variant;
  sourcePage?: string;
}

export default function AuditForm({ variant = "compact", sourcePage = "/" }: Props) {
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const fd = new FormData(e.currentTarget);
    const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;

    const payload = {
      brand_name: String(fd.get("brand_name") ?? "").trim(),
      contact_name: String(fd.get("contact_name") ?? "").trim() || null,
      email: String(fd.get("email") ?? "").trim(),
      website: String(fd.get("website") ?? "").trim() || null,
      wholesale_price: fd.get("wholesale_price")
        ? Number(fd.get("wholesale_price"))
        : null,
      note: String(fd.get("note") ?? "").trim() || null,
      source_page: sourcePage,
      utm_source: params?.get("utm_source") ?? null,
      utm_medium: params?.get("utm_medium") ?? null,
      utm_campaign: params?.get("utm_campaign") ?? null,
    };

    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Submission failed");
      }
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <div className="m-card m-form">
        <div className="eyebrow">Received</div>
        <h3 style={{ marginTop: 12 }}>Thanks — we&apos;ll be in touch within 2 business days.</h3>
        <p style={{ marginTop: 14 }}>
          We&apos;ll review your channel, identify your active resellers, and
          send back a written audit with the estimated unlocked profit.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="m-card m-form">
      <div className="m-grid-2" style={{ gap: 18 }}>
        <div className="field">
          <label htmlFor="brand_name">Brand name</label>
          <input id="brand_name" name="brand_name" required />
        </div>
        <div className="field">
          <label htmlFor="email">Work email</label>
          <input id="email" name="email" type="email" required />
        </div>
      </div>

      {variant === "full" && (
        <>
          <div className="m-grid-2" style={{ gap: 18 }}>
            <div className="field">
              <label htmlFor="contact_name">Your name</label>
              <input id="contact_name" name="contact_name" />
            </div>
            <div className="field">
              <label htmlFor="website">Website (optional)</label>
              <input id="website" name="website" placeholder="brand.com" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="wholesale_price">Wholesale price per unit (optional)</label>
            <input
              id="wholesale_price"
              name="wholesale_price"
              type="number"
              step="0.01"
              min="0"
              placeholder="44.00"
            />
          </div>
          <div className="field">
            <label htmlFor="note">Anything we should know</label>
            <textarea
              id="note"
              name="note"
              placeholder="Current Amazon situation, top SKUs, who's reselling you, any constraints we should know about."
            />
          </div>
        </>
      )}

      {variant === "compact" && (
        <div className="field">
          <label htmlFor="wholesale_price">Wholesale price per unit (optional)</label>
          <input
            id="wholesale_price"
            name="wholesale_price"
            type="number"
            step="0.01"
            min="0"
            placeholder="44.00"
          />
        </div>
      )}

      {error && (
        <div
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

      <button type="submit" className="m-btn" disabled={loading}>
        {loading ? "Submitting…" : "Get my free Channel Ownership Audit →"}
      </button>
      <p style={{ marginTop: 14, fontSize: 12, color: "var(--m-muted)" }}>
        No upfront cost. We&apos;ll respond within 2 business days.
      </p>
    </form>
  );
}
