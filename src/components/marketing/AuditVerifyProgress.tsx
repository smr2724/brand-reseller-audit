"use client";

/**
 * Phase 21 — Marketing verify page client wrapper.
 *
 * Server-side `verify()` flips the lead to `audit_status='pending'` and
 * returns its id + email + brand. The cron (every minute) then claims it,
 * creates a reports row, and writes back `lead.report_id`. This component
 * polls /api/public/lead-status until that report token is present, then
 * hands off to AuditProgress for the per-step ladder.
 */

import { useEffect, useState } from "react";
import AuditProgress from "./AuditProgress";

interface Props {
  leadId: string;
  brandName: string;
  contactEmail: string;
}

interface LeadStatus {
  lead_id: string;
  audit_status: string;
  brand_name: string;
  report_token: string | null;
  failure_reason: string | null;
}

export default function AuditVerifyProgress({ leadId, brandName, contactEmail }: Props) {
  const [lead, setLead] = useState<LeadStatus | null>(null);
  const [pollErrors, setPollErrors] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let stopped = false;
    async function tick() {
      try {
        const res = await fetch(
          `/api/public/lead-status?lead_id=${encodeURIComponent(leadId)}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          setPollErrors((n) => n + 1);
          return;
        }
        const json = (await res.json()) as LeadStatus;
        if (cancelled) return;
        setLead(json);
        setPollErrors(0);
        if (json.report_token) stopped = true;
        if (json.audit_status === "not_found" || json.audit_status === "failed") stopped = true;
      } catch {
        if (!cancelled) setPollErrors((n) => n + 1);
      }
    }
    tick();
    const id = setInterval(() => {
      if (stopped) {
        clearInterval(id);
        return;
      }
      tick();
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [leadId]);

  // Once the cron has produced a report token, hand off to the per-step
  // progress component.
  if (lead?.report_token) {
    return <AuditProgress token={lead.report_token} contactEmail={contactEmail} />;
  }

  // Hard-fail states from the queue.
  if (lead?.audit_status === "not_found") {
    return (
      <div
        style={{
          background: "#fff",
          border: "1px solid var(--color-rule)",
          padding: 28,
          borderRadius: 2,
        }}
      >
        <div className="eyebrow" style={{ color: "#c0392b" }}>Not found</div>
        <h3 style={{ marginTop: 12, fontSize: "1.2rem", fontWeight: 500 }}>
          We couldn&rsquo;t find {brandName} on Amazon US.
        </h3>
        <p style={{ marginTop: 12, color: "var(--color-ink-soft)", lineHeight: 1.6, fontSize: 14 }}>
          We&rsquo;ll email <strong>{contactEmail}</strong> with next steps.
          If you think this is wrong, reply to that email and we&rsquo;ll
          investigate manually.
        </p>
      </div>
    );
  }

  if (lead?.audit_status === "failed") {
    return (
      <div
        style={{
          background: "#fff",
          border: "1px solid var(--color-rule)",
          padding: 28,
          borderRadius: 2,
        }}
      >
        <div className="eyebrow" style={{ color: "#c0392b" }}>Generation failed</div>
        <h3 style={{ marginTop: 12, fontSize: "1.2rem", fontWeight: 500 }}>
          We hit a snag.
        </h3>
        <p style={{ marginTop: 12, color: "var(--color-ink-soft)", lineHeight: 1.6, fontSize: 14 }}>
          We&rsquo;ll fix this and re-run automatically. You&rsquo;ll get an
          email at <strong>{contactEmail}</strong> when the report is ready.
        </p>
      </div>
    );
  }

  // Pre-cron-claim state: status is `pending` (just verified) or `matching`
  // / `enriching` / `generating_report` but the report row hasn't been
  // attached yet. Show the queued-state of the per-step ladder using the
  // synthetic state.
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid var(--color-rule)",
        padding: 28,
        borderRadius: 2,
      }}
    >
      <div className="eyebrow" style={{ color: "var(--color-accent-ink)" }}>Queued</div>
      <h3 style={{ marginTop: 10, fontSize: "1.2rem", fontWeight: 500 }}>
        Building your Channel Ownership Audit for {brandName}…
      </h3>
      <p style={{ marginTop: 8, fontSize: 13, color: "var(--color-ink-soft)" }}>
        This typically takes <strong>2–3 minutes</strong> for most brands and
        up to ~15 minutes for very large catalogs. We start within the next
        minute and you can watch progress here.
      </p>

      <div
        aria-hidden
        style={{
          marginTop: 16,
          height: 6,
          width: "100%",
          background: "var(--color-rule, #e5e5e5)",
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: "5%",
            height: "100%",
            background: "var(--color-accent-ink, #111)",
          }}
        />
      </div>

      <ul
        style={{
          marginTop: 18,
          display: "grid",
          gap: 10,
          listStyle: "none",
          padding: 0,
          fontSize: 14,
        }}
      >
        <li>⠋ Request received — claim pending</li>
        <li style={{ color: "var(--color-muted)" }}>○ Fetching ASINs from Amazon (Keepa)</li>
        <li style={{ color: "var(--color-muted)" }}>○ Analyzing seller landscape</li>
        <li style={{ color: "var(--color-muted)" }}>○ Pulling keyword + competitor data</li>
        <li style={{ color: "var(--color-muted)" }}>○ Generating report</li>
      </ul>

      <div
        style={{
          marginTop: 22,
          padding: 14,
          background: "#fafaf7",
          border: "1px dashed var(--color-rule, #e5e5e5)",
          borderRadius: 4,
          fontSize: 13,
          color: "var(--color-ink-soft)",
          lineHeight: 1.55,
        }}
      >
        <strong>Don&rsquo;t want to wait?</strong> We&rsquo;ll email the
        finished report to <strong>{contactEmail}</strong>. You can close
        this tab — it&rsquo;ll arrive in your inbox when the audit finishes.
      </div>

      {pollErrors > 3 && (
        <p style={{ marginTop: 14, fontSize: 12, color: "#c0392b" }}>
          Connection hiccup — retrying in the background.
        </p>
      )}
    </div>
  );
}
