/**
 * Phase 6.7 — Public branded report page at /r/[token].
 *
 * Two report shapes share this URL:
 *   1. Brand-audit reports (Phase 5+)  — render the rich PublicReportView.
 *   2. Phase-1 supplier-share reports — render a simple legacy layout.
 *
 * Both are public (token is the secret). No auth, no mutations beyond a
 * best-effort view-count bump. Uses the service-role client because the
 * row's RLS policy requires the report owner; the token-in-URL is the
 * authorization model here.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { freshSignedUrl } from "@/lib/report/storage";
import { getBrandEnrichmentBundle } from "@/lib/enrichment";
import { PublicReportView, type PublicReportBrand, type PublicReportRow } from "@/lib/report/public-renderer";
import type { NarrativeOutput } from "@/lib/report/narrative";
import { PublicReportV2 } from "@/lib/report/v2/web";
import type { NarrativeV2 } from "@/lib/report/v2/types";
import AuditProgress from "@/components/marketing/AuditProgress";
import { logReportView } from "@/lib/report/view-log";

// ISR: the report row is largely immutable once `status='completed'`, but
// enrichment (Keepa / DataForSEO) can refresh underneath it. 5 minutes is
// plenty fresh for a recipient reading the audit; we still re-fetch on
// each cache miss anyway because the page is rendered on the server.
export const revalidate = 300;

interface PageProps {
  params: { token: string };
}

// ---------------------------- metadata ----------------------------

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const fallback: Metadata = {
    title: "Channel Ownership Audit — Rolle Consulting Group",
    description: "Channel ownership audit by Rolle Consulting Group.",
    robots: { index: false, follow: false },
  };

  const admin = createSupabaseAdminClient();
  if (!admin) return fallback;

  const { data: report } = await admin
    .from("reports")
    .select("brand_id, narrative_json")
    .eq("token", params.token)
    .maybeSingle();
  if (!report) return fallback;

  let brandName: string | null = null;
  if (report.brand_id) {
    const { data: b } = await admin.from("brands").select("name").eq("id", report.brand_id).maybeSingle();
    brandName = b?.name ?? null;
  }

  const rawNarrative = report.narrative_json as
    | (NarrativeOutput & { version?: number })
    | NarrativeV2
    | null;
  const isV2 = !!rawNarrative && (rawNarrative as NarrativeV2).version === 2;
  const description = isV2
    ? ((rawNarrative as NarrativeV2).cover.headline.slice(0, 320) ||
        "Channel ownership audit by Rolle Consulting Group.")
    : firstSentence((rawNarrative as NarrativeOutput | null)?.reseller_reality_md) ||
      "Channel ownership audit by Rolle Consulting Group.";
  const title = brandName
    ? `${brandName} — Channel Ownership Audit by Rolle Consulting Group`
    : "Channel Ownership Audit — Rolle Consulting Group";

  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: {
      title,
      description,
      type: "article",
      // TODO Phase 6.7+: replace with a real branded OG image asset.
      images: [{ url: "/og-default.png" }],
    },
  };
}

// ---------------------------- page ----------------------------

export default async function ReportPage({ params }: PageProps) {
  const admin = createSupabaseAdminClient();
  if (!admin) return notFound();

  // Phase 40 — pull seller_classifications + four *_share_pct columns.
  // We graceful-degrade when the columns aren't present (legacy DBs that
  // haven't run migration 0038): retry the query with just the legacy
  // columns. Old reports without snapshot data still render via the
  // legacy keepa_brand_controlled_pct fallback in the renderer.
  type ReportRow = {
    id: string;
    token: string | null;
    status: string;
    error_message: string | null;
    brand_id: string | null;
    supplier_id: string | null;
    opportunity_id: string | null;
    pdf_storage_path: string | null;
    narrative_json: unknown;
    report_assumptions: unknown;
    generated_at: string | null;
    created_at: string;
    views: number | null;
    seller_classifications?: unknown;
    brand_owned_share_pct?: number | null;
    authorized_share_pct?: number | null;
    amazon_share_pct?: number | null;
    reseller_share_pct?: number | null;
  };
  let report: ReportRow | null = null;
  {
    const { data, error } = await admin
      .from("reports")
      .select(
        "id, token, status, error_message, brand_id, supplier_id, opportunity_id, pdf_storage_path, narrative_json, report_assumptions, generated_at, created_at, views, seller_classifications, brand_owned_share_pct, authorized_share_pct, amazon_share_pct, reseller_share_pct"
      )
      .eq("token", params.token)
      .maybeSingle();
    if (error && /column .* does not exist|seller_classifications|share_pct/i.test(error.message ?? "")) {
      const retry = await admin
        .from("reports")
        .select(
          "id, token, status, error_message, brand_id, supplier_id, opportunity_id, pdf_storage_path, narrative_json, report_assumptions, generated_at, created_at, views"
        )
        .eq("token", params.token)
        .maybeSingle();
      report = (retry.data as ReportRow | null) ?? null;
    } else {
      report = (data as ReportRow | null) ?? null;
    }
  }

  if (!report) return notFound();

  // Phase 53 — per-visit log + gated counter bump.
  //
  // INSERT into report_views always (best-effort), capturing IP / UA /
  // geo. Then bump `reports.views` only for genuine customer visits —
  // not for steve@'s authenticated sessions and not for bot crawlers /
  // link unfurlers. A logging failure must never break page render.
  try {
    const visit = await logReportView(admin, report.id);
    if (visit.isCustomerView) {
      try {
        await admin
          .from("reports")
          .update({
            views: (report.views ?? 0) + 1,
            last_viewed_at: new Date().toISOString(),
          })
          .eq("id", report.id);
      } catch (e) {
        console.error("[/r/[token]] counter bump failed:", e);
      }
    }
  } catch (e) {
    console.error("[/r/[token]] view log failed:", e);
  }

  // ---- generating / failed / not_a_fit states (brand-audit only) ----
  if (report.brand_id && report.status === "generating") {
    return <GeneratingState token={report.token ?? ""} />;
  }
  if (report.brand_id && report.status === "failed") {
    return <FailedState message={report.error_message ?? null} />;
  }
  if (report.brand_id && report.status === "not_a_fit") {
    const n = report.narrative_json as
      | (NotAFitNarrative & { kind?: string })
      | null;
    return <NotAFitState narrative={n ?? null} />;
  }

  // ---- brand-audit (Phase 5+) ----
  if (report.brand_id) {
    // Math framework v4: RCG fee / new_profit / additional_profit /
    // seven_x_multiple_value are no longer rendered on the v2 page —
    // the math is recomputed live via `LegionMathSection` from
    // `report.report_assumptions`. We still pull the legacy fields for
    // the v1 fallback below (legacy reports keep their old layout).
    const { data: brand } = await admin
      .from("brands")
      .select(
        "id, name, category, est_monthly_revenue, trailing_12_months, avg_sellers, avg_fba_sellers, dominant_seller_name, dominant_seller_country, dominant_seller_sales_pct, has_storefront, total_products, current_profit, additional_profit, new_profit, rcg_fees, seven_x_multiple_value"
      )
      .eq("id", report.brand_id)
      .maybeSingle();
    if (!brand) return notFound();

    let bundle = null;
    try {
      bundle = await getBrandEnrichmentBundle(admin, brand.id);
    } catch (e) {
      console.warn("[/r/[token]] enrichment bundle fetch failed:", e);
    }

    let pdfUrl: string | null = null;
    if (report.status === "completed" && report.pdf_storage_path) {
      try {
        pdfUrl = await freshSignedUrl(report.pdf_storage_path);
      } catch (e) {
        console.warn("[/r/[token]] signed url failed:", e);
      }
    }

    // Phase 8 — v2 narratives ship with `version: 2`. Anything else
    // (including null) falls through to the v1 renderer so legacy
    // reports keep working.
    const rawNarrative = report.narrative_json as
      | (NarrativeOutput & { version?: number })
      | NarrativeV2
      | null;
    if (rawNarrative && (rawNarrative as NarrativeV2).version === 2) {
      const assumptions =
        (report.report_assumptions as
          | import("@/lib/report/v2/types").ReportAssumptions
          | null
          | undefined) ?? null;
      const snapshot = (() => {
        const raw = report!.seller_classifications;
        return Array.isArray(raw)
          ? (raw as import("@/lib/report/v2/snapshot-derive").SellerClassificationSnapshotEntry[])
          : null;
      })();
      return (
        <PublicReportV2
          narrative={rawNarrative as NarrativeV2}
          brand={brand as { id: string; name: string; category: string | null; est_monthly_revenue: number | null }}
          bundle={bundle}
          pdfUrl={pdfUrl}
          reportToken={report.token!}
          assumptions={assumptions}
          classificationSnapshot={snapshot}
          shareCols={{
            brand_owned: report.brand_owned_share_pct ?? null,
            authorized: report.authorized_share_pct ?? null,
            amazon: report.amazon_share_pct ?? null,
            reseller: report.reseller_share_pct ?? null,
          }}
        />
      );
    }

    const reportRow: PublicReportRow = {
      id: report.id,
      token: report.token!,
      generated_at: report.generated_at ?? null,
      created_at: report.created_at,
      status: report.status,
      pdf_storage_path: report.pdf_storage_path ?? null,
      narrative_json: (rawNarrative as NarrativeOutput | null) ?? null,
    };
    const brandRow: PublicReportBrand = brand as PublicReportBrand;

    return <PublicReportView report={reportRow} brand={brandRow} bundle={bundle} pdfUrl={pdfUrl} />;
  }

  // ---- legacy Phase-1 supplier-share ----
  if (report.supplier_id && report.opportunity_id) {
    const { data: supplier } = await admin
      .from("suppliers")
      .select("id, company_name")
      .eq("id", report.supplier_id)
      .maybeSingle();
    if (!supplier) return notFound();
    return <LegacySupplierShare supplierName={supplier.company_name} />;
  }

  return notFound();
}

// ---------------------------- helper components ----------------------------

function GeneratingState({ token }: { token: string }) {
  return (
    <div style={shellStyle}>
      <div style={panelStyle}>
        <AuditProgress token={token} />
      </div>
    </div>
  );
}

interface NotAFitNarrative {
  kind?: string;
  reason?: string;
  brand_name?: string;
  headline?: string;
  explainer?: string;
  amazon_1p_share?: number | null;
  cta?: {
    headline?: string;
    primary_cta_url?: string | null;
    primary_cta_label?: string;
    secondary_email?: string;
  };
}

function NotAFitState({ narrative }: { narrative: NotAFitNarrative | null }) {
  const headline =
    narrative?.headline ??
    "Amazon is your top seller — that's a different conversation.";
  const explainer =
    narrative?.explainer ??
    "When Amazon itself is the channel — not third-party resellers riding on top of it — the playbook changes. " +
      "RCG's reseller-removal motion captures margin from outside resellers; here, that margin is already inside an Amazon 1P (Vendor Central) relationship. " +
      "We can still help: the conversation shifts to Vendor vs Seller Central tradeoffs, terms negotiation, and protecting unit economics under 1P.";
  const ctaLabel = narrative?.cta?.primary_cta_label ?? "Book a strategy call";
  const ctaUrl =
    narrative?.cta?.primary_cta_url ||
    "https://calendly.com/steve-rollemanagementgroup/intro";
  const email =
    narrative?.cta?.secondary_email ?? "steve@rollemanagementgroup.com";
  const sharePct =
    narrative?.amazon_1p_share != null
      ? `${Math.round(narrative.amazon_1p_share * 100)}%`
      : null;

  return (
    <div style={shellStyle}>
      <div style={panelStyle}>
        <div style={pillStyle}>Rolle Consulting Group</div>
        <h1 style={h1Style}>{headline}</h1>
        {sharePct && (
          <p style={metaStyle}>
            Amazon Retail (ATVPDKIKX0DER) holds {sharePct} of buy boxes on this brand.
          </p>
        )}
        <p style={pStyle}>{explainer}</p>
        <p style={pStyle}>
          <a href={ctaUrl} style={ctaButtonStyle}>
            {ctaLabel} →
          </a>
        </p>
        <p style={contactStyle}>
          Or reply directly to{" "}
          <a href={`mailto:${email}`} style={linkStyle}>
            {email}
          </a>
          <br />
          Steve Rolle, Founder · Rolle Consulting Group
        </p>
      </div>
    </div>
  );
}

function FailedState({ message }: { message: string | null }) {
  return (
    <div style={shellStyle}>
      <div style={panelStyle}>
        <div style={pillFailStyle}>Report unavailable</div>
        <h1 style={h1Style}>This audit isn&apos;t available right now.</h1>
        <p style={pStyle}>
          Something went wrong while preparing it. Reach out to{" "}
          <a href="mailto:steve@rollemanagementgroup.com" style={linkStyle}>
            steve@rollemanagementgroup.com
          </a>{" "}
          and we&apos;ll get a fresh copy over to you.
        </p>
        {message && <p style={metaStyle}>Reference: {message}</p>}
      </div>
    </div>
  );
}

function LegacySupplierShare({ supplierName }: { supplierName: string }) {
  return (
    <div style={shellStyle}>
      <div style={panelStyle}>
        <div style={pillStyle}>Rolle Consulting Group</div>
        <h1 style={h1Style}>Brief prepared for {supplierName}</h1>
        <p style={pStyle}>
          Thanks for opening this. The full version of this brief is being delivered
          personally — please reply to the email this link came in on, or reach out
          directly:
        </p>
        <p style={contactStyle}>
          <a href="mailto:steve@rollemanagementgroup.com" style={linkStyle}>
            steve@rollemanagementgroup.com
          </a>
          <br />
          Steve Rolle, Founder · Rolle Consulting Group
        </p>
        <Link href="/" style={linkStyle}>
          More on how we work →
        </Link>
      </div>
    </div>
  );
}

// ---- shared inline styles for the lightweight state pages ----
const shellStyle: React.CSSProperties = {
  margin: 0,
  minHeight: "100vh",
  background: "#0b0b0d",
  color: "#f2f2f3",
  fontFamily: "Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
};
const panelStyle: React.CSSProperties = {
  maxWidth: 560,
  width: "100%",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 12,
  background: "#111114",
  padding: "32px 28px",
};
const pillStyle: React.CSSProperties = {
  display: "inline-block",
  fontSize: 11,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "#c9a96a",
  fontWeight: 600,
  marginBottom: 12,
};
const pillFailStyle: React.CSSProperties = { ...pillStyle, color: "#fb923c" };
const h1Style: React.CSSProperties = {
  fontSize: 26,
  lineHeight: 1.2,
  margin: "0 0 12px",
  fontWeight: 600,
};
const pStyle: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1.6,
  color: "#9b9ba3",
  margin: "0 0 12px",
};
const metaStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#6b6b73",
  margin: "8px 0 0",
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
};
const contactStyle: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1.7,
  color: "#f2f2f3",
  margin: "16px 0 16px",
};
const linkStyle: React.CSSProperties = { color: "#c9a96a", textDecoration: "none" };
const ctaButtonStyle: React.CSSProperties = {
  display: "inline-block",
  marginTop: 12,
  padding: "10px 20px",
  background: "#c9a96a",
  color: "#0b0b0d",
  textDecoration: "none",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 14,
};

function firstSentence(md: string | null | undefined): string {
  if (!md) return "";
  const s = md.replace(/\s+/g, " ").trim();
  const m = s.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : s).slice(0, 320);
}
