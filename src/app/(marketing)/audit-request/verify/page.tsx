import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { sha256Hex } from "@/lib/audit-request/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = {
  title: "Verify your audit — Rolle Consulting Group",
};

interface Props {
  searchParams: { token?: string };
}

type VerifyState =
  | { ok: true; brand_name: string }
  | { ok: false; reason: "missing" | "invalid" | "expired" | "error" };

async function verify(token: string | undefined): Promise<VerifyState> {
  if (!token) return { ok: false, reason: "missing" };
  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, reason: "error" };

  const tokenHash = sha256Hex(token);
  const { data: lead, error } = await admin
    .from("leads")
    .select(
      "id, brand_name, email_verify_expires_at, email_verified_at, audit_status",
    )
    .eq("email_verify_token_hash", tokenHash)
    .maybeSingle();
  if (error) {
    console.error("[verify] lookup error", error);
    return { ok: false, reason: "error" };
  }
  if (!lead) return { ok: false, reason: "invalid" };

  // Already verified — treat as success (idempotent).
  if (lead.email_verified_at) {
    return { ok: true, brand_name: lead.brand_name };
  }

  if (lead.email_verify_expires_at) {
    const exp = new Date(lead.email_verify_expires_at).getTime();
    if (Number.isFinite(exp) && exp < Date.now()) {
      return { ok: false, reason: "expired" };
    }
  }

  const { error: upErr } = await admin
    .from("leads")
    .update({
      email_verified_at: new Date().toISOString(),
      audit_status: "pending",
      // Clear the hash so the link can't be reused.
      email_verify_token_hash: null,
    })
    .eq("id", lead.id);
  if (upErr) {
    console.error("[verify] update error", upErr);
    return { ok: false, reason: "error" };
  }
  return { ok: true, brand_name: lead.brand_name };
}

export default async function VerifyPage({ searchParams }: Props) {
  const state = await verify(searchParams.token);
  return (
    <section className="m-section" style={{ paddingTop: 64, paddingBottom: 96 }}>
      <div className="container" style={{ maxWidth: 640 }}>
        {state.ok ? (
          <Success brand={state.brand_name} />
        ) : (
          <Failure reason={state.reason} />
        )}
      </div>
    </section>
  );
}

function Success({ brand }: { brand: string }) {
  return (
    <div style={{ background: "#fff", border: "1px solid var(--color-rule)", padding: 36, borderRadius: 2 }}>
      <div className="eyebrow">Verified</div>
      <h1 style={{
        marginTop: 14,
        fontFamily: "var(--font-fraunces), Georgia, serif",
        fontSize: "2rem",
        fontWeight: 400,
        letterSpacing: "-0.02em",
        lineHeight: 1.2,
      }}>
        Your audit is queued.
      </h1>
      <p style={{ marginTop: 18, color: "var(--color-ink-soft)", lineHeight: 1.7 }}>
        We&rsquo;re running the Channel Ownership Audit for <strong>{brand}</strong> right
        now &mdash; mapping every reseller, your search visibility, and the
        recapturable margin. The full report will land in your inbox in
        <strong> 5&ndash;10 minutes</strong>.
      </p>
      <p style={{ marginTop: 14, fontSize: 13, color: "var(--color-muted)" }}>
        Steve will follow up personally inside 24 hours. No upfront cost. No
        obligation either way.
      </p>
    </div>
  );
}

function Failure({ reason }: { reason: "missing" | "invalid" | "expired" | "error" }) {
  const heading =
    reason === "expired"
      ? "This link has expired."
      : reason === "missing"
      ? "Verification token missing."
      : reason === "invalid"
      ? "We couldn't verify this link."
      : "Something went wrong on our side.";
  const body =
    reason === "expired"
      ? "Verification links expire after 24 hours. Re-submit the form and we'll send a new link."
      : reason === "error"
      ? "Please try the link again, or write to steve@rollemanagementgroup.com and we'll set it up manually."
      : "It looks like the link is broken or has already been used. Re-submit the audit request and we'll resend.";
  return (
    <div style={{ background: "#fff", border: "1px solid var(--color-rule)", padding: 36, borderRadius: 2 }}>
      <div className="eyebrow">Verification</div>
      <h1
        style={{
          marginTop: 14,
          fontFamily: "var(--font-fraunces), Georgia, serif",
          fontSize: "1.7rem",
          fontWeight: 400,
          letterSpacing: "-0.02em",
          lineHeight: 1.2,
        }}
      >
        {heading}
      </h1>
      <p style={{ marginTop: 18, color: "var(--color-ink-soft)", lineHeight: 1.7 }}>{body}</p>
      <p style={{ marginTop: 18 }}>
        <a href="/audit-request" style={{ color: "var(--color-accent-ink)" }}>
          Back to the audit request form →
        </a>
      </p>
    </div>
  );
}
