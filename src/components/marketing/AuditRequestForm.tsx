"use client";
/**
 * Phase 43 — Public client-facing 4-step audit-request wizard.
 *
 * 1. Verify brand (Keepa lookup → confirm match)
 * 2. Classify sellers (4-bucket UX mirroring the admin
 *    SellerClassificationModal: Brand-owned / Authorized / Amazon /
 *    Reseller; Amazon row locked; live footer; ≥50% banner; gate on
 *    100% classified)
 * 3. Contact info (name, work email, phone, website, approx Amazon
 *    annual revenue) — Cloudflare Turnstile gate
 * 4. Confirmation — explains the report is being prepared and that
 *    Steve is cc'd on the email
 *
 * Layout selection (tight vs opportunity) is auto-applied by the
 * generator based on the user's classifications, identical to the
 * authenticated path.
 */
import Script from "next/script";
import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  turnstileSiteKey: string;
}

const REVENUE_BANDS = [
  "Under $500K",
  "$500K – $1M",
  "$1M – $5M",
  "$5M – $10M",
  "$10M – $25M",
  "$25M – $50M",
  "$50M+",
] as const;

const ROLES = [
  "Founder/CEO",
  "Brand Manager",
  "Ops",
  "Marketing",
  "Other",
] as const;

const AMAZON_SELLER_ID = "ATVPDKIKX0DER";

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

type ClassificationBucket = "brand_owned" | "authorized" | "amazon" | "reseller";

interface SellerRow {
  id: string;
  seller_name: string | null;
  seller_id: string | null;
  seller_country: string | null;
  share_pct: number | null;
  asins_won: number | null;
  is_fba: boolean | null;
  is_brand_controlled: boolean | null;
  classification_reason: string | null;
  classification: string | null;
}

type Step = 1 | 2 | 3 | 4;

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function isAmazonRow(row: SellerRow): boolean {
  if (row.seller_id === AMAZON_SELLER_ID) return true;
  const name = (row.seller_name ?? "").toLowerCase().trim();
  return name === "amazon.com" || name === "amazon";
}

function defaultBucket(row: SellerRow): ClassificationBucket {
  if (isAmazonRow(row)) return "amazon";
  const existing = (row.classification ?? "").toLowerCase();
  if (
    existing === "brand_owned" ||
    existing === "authorized" ||
    existing === "amazon" ||
    existing === "reseller"
  ) {
    return existing as ClassificationBucket;
  }
  if (row.is_brand_controlled === true) return "brand_owned";
  return "reseller";
}

export default function AuditRequestForm({ turnstileSiteKey }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Step 1 — brand verification.
  const [brandName, setBrandName] = useState("");
  const [sampleAsin, setSampleAsin] = useState("");
  const [verifiedBrand, setVerifiedBrand] = useState<{
    lead_id: string;
    lead_token: string;
    brand_id: string;
    brand_name: string;
  } | null>(null);

  // Step 2 — sellers + classifications.
  const [sellers, setSellers] = useState<SellerRow[] | null>(null);
  const [picks, setPicks] = useState<Record<string, ClassificationBucket>>({});

  // Step 3 — contact form.
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [website, setWebsite] = useState("");
  const [revenueBand, setRevenueBand] = useState<string>("");
  const [role, setRole] = useState<string>("");

  // Turnstile state — re-used across step 1 and step 3 (rendered only
  // once at the bottom of whichever step is currently active).
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileEl = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (step !== 1 && step !== 3) return;
    function tryRender() {
      if (!turnstileSiteKey) return;
      if (!turnstileEl.current || !window.turnstile) return false;
      // Reset any existing widget when the step swaps.
      if (widgetIdRef.current) {
        try {
          window.turnstile.reset(widgetIdRef.current);
        } catch {}
        widgetIdRef.current = null;
        setTurnstileToken(null);
      }
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
  }, [turnstileSiteKey, step]);

  // ---- Step 1: verify brand ----
  async function submitVerifyBrand(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const params =
        typeof window !== "undefined"
          ? new URLSearchParams(window.location.search)
          : null;
      const res = await fetch("/api/public/audit-flow/verify-brand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand_name: brandName.trim(),
          sample_asin_or_url: sampleAsin.trim() || null,
          turnstile_token: turnstileToken,
          utm_source: params?.get("utm_source") ?? null,
          utm_medium: params?.get("utm_medium") ?? null,
          utm_campaign: params?.get("utm_campaign") ?? null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Brand verification failed.");
      if (data?.not_found) {
        setError(
          data.message ||
            "We couldn't find that brand on Amazon. Email steve@rollemanagementgroup.com.",
        );
        return;
      }
      setVerifiedBrand({
        lead_id: data.lead_id,
        lead_token: data.lead_token,
        brand_id: data.brand_id,
        brand_name: data.brand_name,
      });
      // Pull sellers immediately.
      await loadSellers(data.lead_id, data.lead_token);
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Brand verification failed.");
      try {
        if (widgetIdRef.current) window.turnstile?.reset(widgetIdRef.current);
        setTurnstileToken(null);
      } catch {}
    } finally {
      setLoading(false);
    }
  }

  async function loadSellers(leadId: string, leadToken: string) {
    const url = new URL("/api/public/audit-flow/sellers", window.location.origin);
    url.searchParams.set("lead_id", leadId);
    url.searchParams.set("lead_token", leadToken);
    const res = await fetch(url.toString(), { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || "Could not load sellers.");
    }
    const list: SellerRow[] = Array.isArray(data?.sellers) ? data.sellers : [];
    setSellers(list);
    const initial: Record<string, ClassificationBucket> = {};
    for (const s of list) initial[s.id] = defaultBucket(s);
    setPicks(initial);
  }

  // ---- Step 2: classify sellers ----
  const totals = useMemo(() => {
    let bo = 0,
      au = 0,
      am = 0,
      re = 0,
      total = 0;
    for (const r of sellers ?? []) {
      const share = typeof r.share_pct === "number" ? r.share_pct : 0;
      if (share <= 0) continue;
      total += share;
      const b = picks[r.id] ?? "reseller";
      if (b === "brand_owned") bo += share;
      else if (b === "authorized") au += share;
      else if (b === "amazon") am += share;
      else re += share;
    }
    const norm = (n: number) => (total > 0 ? n / total : 0);
    return {
      brand_owned_pct: norm(bo),
      authorized_pct: norm(au),
      amazon_pct: norm(am),
      reseller_pct: norm(re),
      non_reseller_pct: norm(bo + au + am),
    };
  }, [sellers, picks]);

  const showHighOwnershipBanner = totals.non_reseller_pct >= 0.5;
  const allClassified = useMemo(() => {
    if (!sellers || sellers.length === 0) return false;
    return sellers.every((s) => !!picks[s.id]);
  }, [sellers, picks]);

  async function submitClassifications() {
    if (!verifiedBrand || !sellers) return;
    setError(null);
    setLoading(true);
    try {
      const payload = {
        lead_id: verifiedBrand.lead_id,
        lead_token: verifiedBrand.lead_token,
        classifications: sellers.map((s) => ({
          seller_id: s.seller_id ?? null,
          seller_name: s.seller_name ?? null,
          classification: picks[s.id] ?? "reseller",
        })),
      };
      const res = await fetch("/api/public/audit-flow/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Could not save your classifications.");
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your classifications.");
    } finally {
      setLoading(false);
    }
  }

  // ---- Step 3: submit contact ----
  async function submitContact(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!verifiedBrand) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/public/audit-flow/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_id: verifiedBrand.lead_id,
          lead_token: verifiedBrand.lead_token,
          contact_name: contactName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          website: website.trim(),
          approx_amazon_revenue: revenueBand.trim(),
          role: role.trim() || null,
          turnstile_token: turnstileToken,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Submission failed.");
      setStep(4);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed.");
      try {
        if (widgetIdRef.current) window.turnstile?.reset(widgetIdRef.current);
        setTurnstileToken(null);
      } catch {}
    } finally {
      setLoading(false);
    }
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
      <div
        className="m-form"
        style={{
          background: "#fff",
          border: "1px solid var(--color-rule)",
          padding: 32,
          borderRadius: 2,
        }}
      >
        <ProgressBar step={step} />

        {error && (
          <div
            role="alert"
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
              padding: 12,
              borderRadius: 2,
              marginTop: 12,
              marginBottom: 14,
              fontSize: 14,
            }}
          >
            {error}
          </div>
        )}

        {step === 1 && (
          <Step1
            brandName={brandName}
            setBrandName={setBrandName}
            sampleAsin={sampleAsin}
            setSampleAsin={setSampleAsin}
            onSubmit={submitVerifyBrand}
            loading={loading}
            turnstileSiteKey={turnstileSiteKey}
            turnstileEl={turnstileEl}
            turnstileToken={turnstileToken}
          />
        )}

        {step === 2 && (
          <Step2
            sellers={sellers}
            picks={picks}
            setPick={(id, b) => setPicks((prev) => ({ ...prev, [id]: b }))}
            totals={totals}
            showHighOwnershipBanner={showHighOwnershipBanner}
            allClassified={allClassified}
            loading={loading}
            onBack={() => setStep(1)}
            onContinue={submitClassifications}
            brandName={verifiedBrand?.brand_name ?? brandName}
          />
        )}

        {step === 3 && (
          <Step3
            contactName={contactName}
            setContactName={setContactName}
            email={email}
            setEmail={setEmail}
            phone={phone}
            setPhone={setPhone}
            website={website}
            setWebsite={setWebsite}
            revenueBand={revenueBand}
            setRevenueBand={setRevenueBand}
            role={role}
            setRole={setRole}
            onSubmit={submitContact}
            onBack={() => setStep(2)}
            loading={loading}
            turnstileSiteKey={turnstileSiteKey}
            turnstileEl={turnstileEl}
            turnstileToken={turnstileToken}
          />
        )}

        {step === 4 && (
          <Step4 brandName={verifiedBrand?.brand_name ?? brandName} email={email} />
        )}
      </div>
    </>
  );
}

function ProgressBar({ step }: { step: Step }) {
  const labels = ["Verify brand", "Classify sellers", "Contact info", "Done"];
  return (
    <ol
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 8,
        listStyle: "none",
        padding: 0,
        margin: 0,
        marginBottom: 14,
      }}
    >
      {labels.map((label, i) => {
        const idx = (i + 1) as Step;
        const active = idx === step;
        const done = idx < step;
        return (
          <li
            key={label}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 6px",
              borderTop: `3px solid ${
                done
                  ? "var(--color-accent-ink, #7a6a4f)"
                  : active
                  ? "var(--color-ink, #1a1a1a)"
                  : "var(--color-rule, #e7e2d9)"
              }`,
              fontSize: 12,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: active
                ? "var(--color-ink)"
                : done
                ? "var(--color-accent-ink, #7a6a4f)"
                : "var(--color-muted, #8a8275)",
            }}
          >
            <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>
              {String(idx).padStart(2, "0")}
            </span>
            <span style={{ fontWeight: active ? 600 : 400 }}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

interface Step1Props {
  brandName: string;
  setBrandName: (v: string) => void;
  sampleAsin: string;
  setSampleAsin: (v: string) => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  loading: boolean;
  turnstileSiteKey: string;
  turnstileEl: React.RefObject<HTMLDivElement>;
  turnstileToken: string | null;
}

function Step1(props: Step1Props) {
  const ready = props.brandName.trim().length > 0;
  const captchaReady = !props.turnstileSiteKey || !!props.turnstileToken;
  return (
    <form onSubmit={props.onSubmit}>
      <div className="eyebrow">Step 1 of 4</div>
      <h3
        style={{
          marginTop: 8,
          fontFamily: "var(--font-fraunces), Georgia, serif",
          fontSize: "1.5rem",
          fontWeight: 400,
          letterSpacing: "-0.02em",
          color: "var(--color-ink)",
          lineHeight: 1.2,
        }}
      >
        Tell us your brand.
      </h3>
      <p style={{ marginTop: 10, color: "var(--color-ink-soft)", lineHeight: 1.6, fontSize: 14 }}>
        We&rsquo;ll search Amazon US for the brand and pull every seller currently
        on your Buy Box. You confirm who&rsquo;s who in the next step.
      </p>

      <div className="field" style={{ marginTop: 20 }}>
        <label htmlFor="brand_name">Brand name *</label>
        <input
          id="brand_name"
          name="brand_name"
          required
          maxLength={200}
          autoComplete="organization"
          value={props.brandName}
          onChange={(e) => props.setBrandName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="sample_asin">Sample ASIN or storefront URL (optional)</label>
        <input
          id="sample_asin"
          name="sample_asin"
          maxLength={400}
          placeholder="e.g. B0XXXXXXXX or amazon.com/stores/yourbrand"
          value={props.sampleAsin}
          onChange={(e) => props.setSampleAsin(e.target.value)}
        />
        <div className="field-help">
          Helps us pick the right brand if there are multiple matches.
        </div>
      </div>

      {props.turnstileSiteKey ? (
        <div className="field" style={{ marginTop: 8 }}>
          <div ref={props.turnstileEl} />
        </div>
      ) : null}

      <button
        type="submit"
        className="m-btn submit"
        disabled={props.loading || !ready || !captchaReady}
        style={{ marginTop: 6, justifyContent: "center" }}
      >
        {props.loading ? "Verifying with Amazon…" : "Verify my brand →"}
      </button>
      <p style={{ marginTop: 14, fontSize: 12, color: "var(--color-muted)", letterSpacing: "0.02em" }}>
        Verification can take 10&ndash;30 seconds. We&rsquo;re pulling live data from
        Keepa.
      </p>
    </form>
  );
}

interface Step2Props {
  sellers: SellerRow[] | null;
  picks: Record<string, ClassificationBucket>;
  setPick: (id: string, b: ClassificationBucket) => void;
  totals: {
    brand_owned_pct: number;
    authorized_pct: number;
    amazon_pct: number;
    reseller_pct: number;
    non_reseller_pct: number;
  };
  showHighOwnershipBanner: boolean;
  allClassified: boolean;
  loading: boolean;
  onBack: () => void;
  onContinue: () => void;
  brandName: string;
}

function Step2(props: Step2Props) {
  return (
    <div>
      <div className="eyebrow">Step 2 of 4</div>
      <h3
        style={{
          marginTop: 8,
          fontFamily: "var(--font-fraunces), Georgia, serif",
          fontSize: "1.5rem",
          fontWeight: 400,
          letterSpacing: "-0.02em",
          color: "var(--color-ink)",
          lineHeight: 1.2,
        }}
      >
        Who&rsquo;s selling {props.brandName}?
      </h3>
      <p style={{ marginTop: 10, color: "var(--color-ink-soft)", lineHeight: 1.6, fontSize: 14 }}>
        Tell us which of these sellers you control, who&rsquo;s an
        authorized partner, and who&rsquo;s an unauthorized reseller. Only
        unauthorized resellers count toward recoverable revenue. Amazon
        retail rows are locked.
      </p>

      {props.showHighOwnershipBanner && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            borderRadius: 2,
            background: "#fffaf0",
            border: "1px solid #f0d9a8",
            color: "#7a5a18",
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          Brand-owned + Authorized + Amazon control{" "}
          <strong>{fmtPct(props.totals.non_reseller_pct)}</strong> of sales
          (≥50%). The audit will reflect that there may be limited
          recoverable revenue.
        </div>
      )}

      <div style={{ marginTop: 16, overflowX: "auto" }}>
        {props.sellers == null ? (
          <div style={{ fontSize: 14, color: "var(--color-ink-soft)" }}>
            Loading sellers from Amazon…
          </div>
        ) : props.sellers.length === 0 ? (
          <div style={{ fontSize: 14, color: "var(--color-ink-soft)" }}>
            We couldn&rsquo;t find any third-party sellers for this brand
            yet. Try again in a few seconds, or email
            steve@rollemanagementgroup.com.
          </div>
        ) : (
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--color-muted)", fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                <th style={{ padding: "8px 6px" }}>Seller</th>
                <th style={{ padding: "8px 6px", textAlign: "right" }}>Share</th>
                <th style={{ padding: "8px 6px", textAlign: "right" }}>ASINs</th>
                <th style={{ padding: "8px 6px" }}>Classification</th>
              </tr>
            </thead>
            <tbody>
              {props.sellers.map((s) => {
                const locked = isAmazonRow(s);
                const bucket = props.picks[s.id] ?? "reseller";
                return (
                  <tr key={s.id} style={{ borderTop: "1px solid var(--color-rule)" }}>
                    <td style={{ padding: "8px 6px" }}>
                      <div style={{ fontWeight: 500 }}>
                        {s.seller_name || "—"}
                      </div>
                      {s.classification_reason && (
                        <div style={{ fontSize: 11, color: "var(--color-muted)", marginTop: 2 }}>
                          {s.classification_reason}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "8px 6px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {fmtPct(s.share_pct)}
                    </td>
                    <td style={{ padding: "8px 6px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {typeof s.asins_won === "number" ? s.asins_won : "—"}
                    </td>
                    <td style={{ padding: "8px 6px" }}>
                      <select
                        value={bucket}
                        disabled={locked || props.loading}
                        onChange={(e) =>
                          props.setPick(s.id, e.target.value as ClassificationBucket)
                        }
                        style={{ fontSize: 13, padding: "4px 6px" }}
                      >
                        <option value="brand_owned">Brand-owned</option>
                        <option value="authorized">Authorized</option>
                        <option value="amazon">Amazon</option>
                        <option value="reseller">Reseller</option>
                      </select>
                      {locked && (
                        <span style={{ marginLeft: 6, fontSize: 11, color: "var(--color-muted)" }}>
                          locked
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div
        style={{
          marginTop: 14,
          padding: "10px 12px",
          background: "#faf7f1",
          border: "1px solid var(--color-rule)",
          borderRadius: 2,
          fontSize: 12,
          color: "var(--color-ink-soft)",
          display: "flex",
          flexWrap: "wrap",
          gap: "6px 18px",
        }}
      >
        <span>
          Brand-owned <strong>{fmtPct(props.totals.brand_owned_pct)}</strong>
        </span>
        <span>
          Authorized <strong>{fmtPct(props.totals.authorized_pct)}</strong>
        </span>
        <span>
          Amazon <strong>{fmtPct(props.totals.amazon_pct)}</strong>
        </span>
        <span>
          Reseller <strong>{fmtPct(props.totals.reseller_pct)}</strong>
        </span>
      </div>

      <div style={{ marginTop: 18, display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
        <button
          type="button"
          className="m-btn"
          onClick={props.onBack}
          disabled={props.loading}
          style={{ background: "transparent", color: "var(--color-ink)", border: "1px solid var(--color-rule)" }}
        >
          ← Back
        </button>
        <button
          type="button"
          className="m-btn submit"
          onClick={props.onContinue}
          disabled={props.loading || !props.allClassified || !props.sellers || props.sellers.length === 0}
        >
          {props.loading ? "Saving…" : "Continue →"}
        </button>
      </div>
      {!props.allClassified && props.sellers && props.sellers.length > 0 && (
        <p style={{ marginTop: 8, fontSize: 12, color: "var(--color-muted)" }}>
          Classify every seller above to continue.
        </p>
      )}
    </div>
  );
}

interface Step3Props {
  contactName: string;
  setContactName: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  phone: string;
  setPhone: (v: string) => void;
  website: string;
  setWebsite: (v: string) => void;
  revenueBand: string;
  setRevenueBand: (v: string) => void;
  role: string;
  setRole: (v: string) => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
  loading: boolean;
  turnstileSiteKey: string;
  turnstileEl: React.RefObject<HTMLDivElement>;
  turnstileToken: string | null;
}

function Step3(props: Step3Props) {
  const captchaReady = !props.turnstileSiteKey || !!props.turnstileToken;
  const ready =
    props.contactName.trim() &&
    props.email.trim() &&
    props.phone.trim() &&
    props.website.trim() &&
    props.revenueBand.trim();
  return (
    <form onSubmit={props.onSubmit}>
      <div className="eyebrow">Step 3 of 4</div>
      <h3
        style={{
          marginTop: 8,
          fontFamily: "var(--font-fraunces), Georgia, serif",
          fontSize: "1.5rem",
          fontWeight: 400,
          letterSpacing: "-0.02em",
          color: "var(--color-ink)",
          lineHeight: 1.2,
        }}
      >
        Where should we send the report?
      </h3>
      <p style={{ marginTop: 10, color: "var(--color-ink-soft)", lineHeight: 1.6, fontSize: 14 }}>
        Steve will be cc&rsquo;d so he can follow up with you personally
        once the audit lands.
      </p>

      <div className="m-grid-2" style={{ gap: 18 }}>
        <div className="field">
          <label htmlFor="contact_name">Your name *</label>
          <input
            id="contact_name"
            required
            maxLength={200}
            autoComplete="name"
            value={props.contactName}
            onChange={(e) => props.setContactName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="email">Work email *</label>
          <input
            id="email"
            type="email"
            required
            maxLength={320}
            autoComplete="email"
            placeholder="you@yourbrand.com"
            value={props.email}
            onChange={(e) => props.setEmail(e.target.value)}
          />
          <div className="field-help">
            We block free-mail providers (gmail, yahoo, etc).
          </div>
        </div>
      </div>
      <div className="m-grid-2" style={{ gap: 18 }}>
        <div className="field">
          <label htmlFor="phone">Phone *</label>
          <input
            id="phone"
            type="tel"
            required
            maxLength={40}
            autoComplete="tel"
            value={props.phone}
            onChange={(e) => props.setPhone(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="website">Company website *</label>
          <input
            id="website"
            type="text"
            required
            maxLength={400}
            autoComplete="url"
            placeholder="yourbrand.com"
            value={props.website}
            onChange={(e) => props.setWebsite(e.target.value)}
          />
        </div>
      </div>
      <div className="m-grid-2" style={{ gap: 18 }}>
        <div className="field">
          <label htmlFor="revenue_band">Approx. Amazon annual revenue *</label>
          <select
            id="revenue_band"
            required
            value={props.revenueBand}
            onChange={(e) => props.setRevenueBand(e.target.value)}
          >
            <option value="">Select…</option>
            {REVENUE_BANDS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="role">Your role</label>
          <select
            id="role"
            value={props.role}
            onChange={(e) => props.setRole(e.target.value)}
          >
            <option value="">Select…</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      </div>

      {props.turnstileSiteKey ? (
        <div className="field" style={{ marginTop: 8 }}>
          <div ref={props.turnstileEl} />
        </div>
      ) : null}

      <div style={{ marginTop: 14, display: "flex", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
        <button
          type="button"
          className="m-btn"
          onClick={props.onBack}
          disabled={props.loading}
          style={{ background: "transparent", color: "var(--color-ink)", border: "1px solid var(--color-rule)" }}
        >
          ← Back
        </button>
        <button
          type="submit"
          className="m-btn submit"
          disabled={props.loading || !ready || !captchaReady}
        >
          {props.loading ? "Submitting…" : "Run my audit →"}
        </button>
      </div>
    </form>
  );
}

function Step4({ brandName, email }: { brandName: string; email: string }) {
  return (
    <div>
      <div className="eyebrow">Done</div>
      <h3
        style={{
          marginTop: 8,
          fontFamily: "var(--font-fraunces), Georgia, serif",
          fontSize: "1.7rem",
          fontWeight: 400,
          letterSpacing: "-0.02em",
          color: "var(--color-ink)",
          lineHeight: 1.2,
        }}
      >
        Your audit is being prepared.
      </h3>
      <p style={{ marginTop: 18, color: "var(--color-ink-soft)", lineHeight: 1.7 }}>
        We&rsquo;re generating the Channel Ownership Audit for{" "}
        <strong>{brandName}</strong> right now. We&rsquo;ll email it to{" "}
        <strong>{email}</strong> in roughly 10&ndash;20 minutes &mdash; Steve
        will be cc&rsquo;d on the message so he can follow up with you
        personally.
      </p>
      <p style={{ marginTop: 14, fontSize: 13, color: "var(--color-muted)" }}>
        Don&rsquo;t see it? Check spam, or write to
        steve@rollemanagementgroup.com.
      </p>
    </div>
  );
}
