/* eslint-disable jsx-a11y/alt-text */
import React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Font,
  renderToBuffer,
} from "@react-pdf/renderer";
import type { BrandForReport, NarrativeOutput } from "./narrative";

// =====================================================================
// Fonts — Fraunces (display serif) + Inter (body sans).
// Loaded lazily so build doesn't fetch fonts at import time.
// =====================================================================
let fontsRegistered = false;
function ensureFonts() {
  if (fontsRegistered) return;
  try {
    Font.register({
      family: "Inter",
      fonts: [
        { src: "https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.ttf", fontWeight: 400 },
        { src: "https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.ttf", fontWeight: 500 },
        { src: "https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.ttf", fontWeight: 700 },
      ],
    });
    Font.register({
      family: "Fraunces",
      fonts: [
        { src: "https://fonts.gstatic.com/s/fraunces/v37/6NUh8FyLNQOQZAnv9bYEvHvIwn-zbpJvSp4.ttf", fontWeight: 400 },
        { src: "https://fonts.gstatic.com/s/fraunces/v37/6NUh8FyLNQOQZAnv9bYEvHvIwn-zbpJvSp4.ttf", fontWeight: 600 },
      ],
    });
    fontsRegistered = true;
  } catch {
    // Font registration is best-effort — fall back to Helvetica if it fails.
  }
}

// =====================================================================
// Palette — Operator: near-black ink, paper off-white, gold accent.
// =====================================================================
const PALETTE = {
  ink: "#0B1220",
  paper: "#F7F5F0",
  gold: "#D4B36A",
  rule: "#1F2937",
  muted: "#4B5563",
  softRule: "#D6D3CB",
};

const styles = StyleSheet.create({
  page: {
    backgroundColor: PALETTE.paper,
    color: PALETTE.ink,
    paddingTop: 56,
    paddingBottom: 56,
    paddingHorizontal: 56,
    fontFamily: "Helvetica",
    fontSize: 11,
    lineHeight: 1.5,
  },
  pageBody: { fontFamily: "Helvetica" },
  h1: {
    fontFamily: "Helvetica-Bold",
    fontSize: 32,
    lineHeight: 1.15,
    marginBottom: 12,
    color: PALETTE.ink,
  },
  h2: {
    fontFamily: "Helvetica-Bold",
    fontSize: 22,
    lineHeight: 1.2,
    marginBottom: 14,
    color: PALETTE.ink,
  },
  h3: {
    fontFamily: "Helvetica-Bold",
    fontSize: 14,
    marginBottom: 6,
    color: PALETTE.ink,
  },
  eyebrow: {
    fontSize: 9,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: PALETTE.muted,
    marginBottom: 8,
  },
  body: { fontSize: 11, color: PALETTE.ink, marginBottom: 8 },
  small: { fontSize: 9, color: PALETTE.muted },
  goldRule: {
    height: 3,
    width: 48,
    backgroundColor: PALETTE.gold,
    marginBottom: 18,
  },
  footer: {
    position: "absolute",
    bottom: 28,
    left: 56,
    right: 56,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 8,
    color: PALETTE.muted,
    borderTopWidth: 0.5,
    borderTopColor: PALETTE.softRule,
    paddingTop: 6,
  },
  // Cover-specific
  coverFrame: {
    flex: 1,
    justifyContent: "space-between",
  },
  coverTopBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  coverBrandMark: {
    fontFamily: "Helvetica-Bold",
    fontSize: 12,
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  coverGold: { color: PALETTE.gold },
  coverHeadline: {
    fontFamily: "Helvetica-Bold",
    fontSize: 44,
    lineHeight: 1.1,
    marginBottom: 24,
  },
  coverSubhead: {
    fontSize: 14,
    color: PALETTE.muted,
    marginBottom: 6,
  },
  // Card / pullquote
  card: {
    backgroundColor: "#FFFFFF",
    borderWidth: 0.5,
    borderColor: PALETTE.softRule,
    padding: 16,
    marginBottom: 14,
    borderRadius: 4,
  },
  pullquote: {
    fontStyle: "italic",
    fontSize: 13,
    color: PALETTE.ink,
    marginBottom: 6,
    lineHeight: 1.4,
  },
  attribution: { fontSize: 9, color: PALETTE.muted },
  // Stat grid
  statGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginHorizontal: -6,
    marginBottom: 14,
  },
  statCell: {
    width: "50%",
    paddingHorizontal: 6,
    marginBottom: 12,
  },
  statLabel: {
    fontSize: 8,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: PALETTE.muted,
    marginBottom: 3,
  },
  statValue: {
    fontFamily: "Helvetica-Bold",
    fontSize: 16,
    color: PALETTE.ink,
  },
  // Bullets
  bulletRow: {
    flexDirection: "row",
    marginBottom: 6,
  },
  bulletDot: {
    width: 10,
    color: PALETTE.gold,
    fontFamily: "Helvetica-Bold",
  },
  bulletText: { flex: 1, fontSize: 11, color: PALETTE.ink },
  // Steps
  stepRow: {
    flexDirection: "row",
    marginBottom: 12,
  },
  stepNum: {
    width: 28,
    fontFamily: "Helvetica-Bold",
    fontSize: 18,
    color: PALETTE.gold,
  },
  stepBody: { flex: 1 },
  stepTitle: { fontFamily: "Helvetica-Bold", fontSize: 12, marginBottom: 2 },
  stepDesc: { fontSize: 10.5, color: PALETTE.ink },
});

// =====================================================================
// Section components
// =====================================================================

function PageFooter({ pageLabel }: { pageLabel: string }) {
  return (
    <View style={styles.footer} fixed>
      <Text>Channel Ownership Audit · Rolle Consulting Group</Text>
      <Text>{pageLabel}</Text>
    </View>
  );
}

function Cover({ brand, dateStr }: { brand: BrandForReport; dateStr: string }) {
  return (
    <Page size="LETTER" style={styles.page}>
      <View style={styles.coverFrame}>
        <View style={styles.coverTopBar}>
          <Text style={styles.coverBrandMark}>
            <Text style={styles.coverGold}>R</Text>CG
          </Text>
          <Text style={styles.small}>Rolle Consulting Group</Text>
        </View>

        <View>
          <Text style={styles.eyebrow}>Channel Ownership Audit</Text>
          <View style={styles.goldRule} />
          <Text style={styles.coverHeadline}>{brand.name}</Text>
          <Text style={styles.coverSubhead}>Prepared for {brand.name}</Text>
          <Text style={styles.coverSubhead}>{dateStr}</Text>
        </View>

        <View>
          <Text style={styles.small}>Prepared by Rolle Consulting Group</Text>
          <Text style={styles.small}>steve@rollemanagementgroup.com</Text>
        </View>
      </View>
      <PageFooter pageLabel="Cover" />
    </Page>
  );
}

function ProblemPage() {
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Section 1 — The Problem</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>Your Amazon channel is likely being run by someone else.</Text>
      <Text style={styles.body}>
        You make a good product. You manage wholesale relationships. You ship in pallets and containers.
        But on the largest e-commerce platform in the world, your brand is being represented by people
        who don&apos;t care about it the way you do. Resellers aren&apos;t fixing your Amazon problem —
        resellers are the problem.
      </Text>

      <Text style={styles.h3}>1. Customer Experience</Text>
      <Text style={styles.body}>
        When resellers handle your brand, customers face inconsistent pricing, off-brand packaging, and
        subpar service. A bad review from one repackaged unit hurts every future sale you make.
      </Text>

      <Text style={styles.h3}>2. Profit Leakage</Text>
      <Text style={styles.body}>
        Resellers pocket the margin that should be yours. They&apos;re middlemen capturing the retail spread
        on top of your brand, your customers, and your reputation.
      </Text>

      <Text style={styles.h3}>3. Missed Growth</Text>
      <Text style={styles.body}>
        Resellers don&apos;t invest in your brand. They don&apos;t optimize listings, don&apos;t run meaningful
        advertising, don&apos;t care about long-term positioning. They take the easy wins and move on.
      </Text>
      <PageFooter pageLabel="1 / 8" />
    </Page>
  );
}

function FootprintPage({
  brand,
  callouts,
}: {
  brand: BrandForReport;
  callouts: string[];
}) {
  const stats: { label: string; value: string }[] = [
    { label: "Brand Score", value: numFmt(brand.brand_score, 2) },
    { label: "Est Monthly Revenue", value: moneyFmt(brand.est_monthly_revenue) },
    { label: "Trailing 12-Month Revenue", value: moneyFmt(brand.trailing_12_months) },
    { label: "Total Products", value: numFmt(brand.total_products) },
    { label: "Avg Sellers / ASIN", value: numFmt(brand.avg_sellers, 1) },
    { label: "Avg FBA Sellers / ASIN", value: numFmt(brand.avg_fba_sellers, 1) },
    {
      label: "Dominant Seller Share",
      value:
        brand.dominant_seller_sales_pct == null
          ? "—"
          : `${Math.round(Number(brand.dominant_seller_sales_pct))}%`,
    },
    {
      label: "Dominant Seller",
      value:
        brand.dominant_seller_name
          ? `${brand.dominant_seller_name}${brand.dominant_seller_country ? ` · ${brand.dominant_seller_country}` : ""}`
          : "—",
    },
    {
      label: "Brand Storefront",
      value: brand.has_storefront == null ? "—" : brand.has_storefront ? "Yes" : "No",
    },
    {
      label: "Monthly Growth",
      value: brand.monthly_growth_pct == null ? "—" : `${numFmt(brand.monthly_growth_pct, 1)}%`,
    },
  ];

  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Section 2 — Your Amazon Footprint</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>What we see on Amazon for {brand.name}</Text>
      <Text style={styles.body}>
        These signals come from public Amazon data and SmartScout. They describe how your brand is
        currently being represented on the platform — who is selling, how much, and from where.
      </Text>

      <View style={styles.statGrid}>
        {stats.map((s, i) => (
          <View key={i} style={styles.statCell}>
            <Text style={styles.statLabel}>{s.label}</Text>
            <Text style={styles.statValue}>{s.value}</Text>
          </View>
        ))}
      </View>

      {callouts.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.h3}>What stands out</Text>
          {callouts.map((c, i) => (
            <View key={i} style={styles.bulletRow}>
              <Text style={styles.bulletDot}>•</Text>
              <Text style={styles.bulletText}>{c}</Text>
            </View>
          ))}
        </View>
      )}
      <PageFooter pageLabel="2 / 8" />
    </Page>
  );
}

function ResellerRealityPage({ brand, narrative }: { brand: BrandForReport; narrative: NarrativeOutput }) {
  const paragraphs = splitParagraphs(narrative.reseller_reality_md);
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Section 3 — The Reseller Reality</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>Whose channel is it, really?</Text>
      {paragraphs.map((p, i) => (
        <Text key={i} style={styles.body}>
          {p}
        </Text>
      ))}
      <Text style={styles.small}>
        Signals referenced above come from public Amazon data for {brand.name}.
      </Text>
      <PageFooter pageLabel="3 / 8" />
    </Page>
  );
}

function OpportunityPage({ brand, narrative }: { brand: BrandForReport; narrative: NarrativeOutput }) {
  const paragraphs = splitParagraphs(narrative.opportunity_narrative_md);

  const haveOverlay =
    brand.current_profit != null ||
    brand.additional_profit != null ||
    brand.new_profit != null;

  const numberRows: { label: string; value: string }[] = haveOverlay
    ? [
        { label: "Current per-unit profit", value: moneyFmt(brand.current_profit) },
        { label: "Illustrative additional profit", value: moneyFmt(brand.additional_profit) },
        { label: "Illustrative RCG fee (50%)", value: moneyFmt(brand.rcg_fees) },
        { label: "Illustrative new per-unit profit", value: moneyFmt(brand.new_profit) },
        { label: "Illustrative 7× multiple value", value: moneyFmt(brand.seven_x_multiple_value) },
      ]
    : [
        { label: "Wholesale-to-reseller profit (illustrative)", value: "$11.48 / unit" },
        { label: "Direct-on-Amazon profit (illustrative)", value: "$24.00 / unit" },
        { label: "Per-unit upside (illustrative)", value: "≈ $12.52 / unit" },
        { label: "RCG fee", value: "50% of additional first-year profit" },
        { label: "Upfront cost", value: "None" },
      ];

  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Section 4 — The Opportunity</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>The math, hedged but real.</Text>
      {paragraphs.map((p, i) => (
        <Text key={i} style={styles.body}>
          {p}
        </Text>
      ))}

      <View style={styles.card}>
        <Text style={styles.h3}>{haveOverlay ? "From the model we built for you" : "Illustrative example"}</Text>
        {numberRows.map((r, i) => (
          <View
            key={i}
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              borderBottomWidth: i === numberRows.length - 1 ? 0 : 0.5,
              borderBottomColor: PALETTE.softRule,
              paddingVertical: 5,
            }}
          >
            <Text style={{ fontSize: 10.5, color: PALETTE.muted }}>{r.label}</Text>
            <Text style={{ fontSize: 11, fontFamily: "Helvetica-Bold" }}>{r.value}</Text>
          </View>
        ))}
        <Text style={[styles.small, { marginTop: 8 }]}>
          {haveOverlay
            ? "All numbers above are illustrative and based on the working model we built for your brand. We re-derive the model on your actual unit economics during onboarding."
            : "These figures are illustrative — drawn from the operators we work with, not from your specific unit economics. We rebuild the model on your numbers during onboarding before any decision is made."}
        </Text>
      </View>
      <PageFooter pageLabel="4 / 8" />
    </Page>
  );
}

function FiveStepPage() {
  const steps = [
    {
      title: "Identify the Opportunity",
      desc:
        "Audit current Amazon presence, demand signals, and reseller activity. Map the listings that already work to the SKUs you produce.",
    },
    {
      title: "Set Up Your Amazon Account",
      desc:
        "Create or optimize the seller account. Align SKUs with what resellers proved works on the platform. Get listings clean, on-brand, and yours.",
    },
    {
      title: "Protect the Brand",
      desc:
        "Brand Registry, monitoring tools, enforcement SOPs. Update wholesale agreements to prohibit reselling on Amazon.",
    },
    {
      title: "Transition to In-House",
      desc:
        "Take over listings. Stock FBA. Give existing resellers a respectful sell-out window. Avoid retaliation, preserve wholesale relationships that matter.",
    },
    {
      title: "Build and Train a Team",
      desc:
        "1–2 US-based team members plus offshore support. Customized training and ongoing support so you own the operation, not us.",
    },
  ];
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Section 5 — Our 5-Step Path</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>How we take you from reseller-run to brand-owned.</Text>
      {steps.map((s, i) => (
        <View key={i} style={styles.stepRow}>
          <Text style={styles.stepNum}>{i + 1}</Text>
          <View style={styles.stepBody}>
            <Text style={styles.stepTitle}>{s.title}</Text>
            <Text style={styles.stepDesc}>{s.desc}</Text>
          </View>
        </View>
      ))}
      <PageFooter pageLabel="5 / 8" />
    </Page>
  );
}

function CaseStudyPage() {
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Section 6 — Case Study</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>Diversified Hospitality Solutions</Text>
      <Text style={styles.body}>
        For years DHS relied on a reseller network. On the surface it looked like volume — underneath,
        pricing was inconsistent, packaging was off-brand, and one reseller alone was earning $1.2M in
        net income in a single year while DHS was waiting 60–90 days to get paid.
      </Text>
      <Text style={styles.body}>
        DHS halted Amazon reseller sales. Updated distribution agreements to prohibit reselling on
        Amazon. Took over listings. Stocked their own FBA inventory.
      </Text>

      <View style={styles.card}>
        <Text style={styles.h3}>Results</Text>
        <View style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>Amazon revenue: $8.34M (2022) → $9.02M (2023).</Text>
        </View>
        <View style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>$5M+ in accounts payable paid down within 24 months.</Text>
        </View>
        <View style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>Enterprise valuation roughly doubled.</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.pullquote}>
          “We didn&apos;t need to find new customers. We just needed to stop letting other people own the
          ones we already had.”
        </Text>
        <Text style={styles.attribution}>Representative; not a literal quote.</Text>
      </View>
      <PageFooter pageLabel="6 / 8" />
    </Page>
  );
}

function NextStepPage({ contactEmail }: { contactEmail: string }) {
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Section 7 — Next Step</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>Book your roadmap call.</Text>
      <Text style={styles.body}>
        No obligation. No pitch deck. We walk through this audit together, show you the model on your
        actual unit economics, and you decide whether the path makes sense for your business. Even if we
        don&apos;t end up working together, you walk away with a clear picture of what your Amazon
        channel is worth and what it would take to reclaim it.
      </Text>

      <View style={styles.card}>
        <Text style={styles.h3}>Reach Steve directly</Text>
        <Text style={styles.body}>{contactEmail}</Text>
        <Text style={styles.small}>Reply with your reseller pricing and your goals — we&apos;ll send you a calendar link.</Text>
      </View>

      <View style={[styles.card, { backgroundColor: PALETTE.ink }]}>
        <Text style={[styles.h3, { color: PALETTE.paper }]}>Our terms</Text>
        <Text style={[styles.body, { color: PALETTE.paper }]}>
          50% of the additional first-year profit. No upfront cost.
        </Text>
        <Text style={{ fontSize: 9, color: PALETTE.gold }}>
          If we don&apos;t generate additional profit, we don&apos;t get paid.
        </Text>
      </View>
      <PageFooter pageLabel="7 / 8" />
    </Page>
  );
}

function ClosingPage({ brand }: { brand: BrandForReport }) {
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Section 8 — Closing</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>Take ownership of your channel.</Text>
      <Text style={styles.body}>
        Your brand deserves to thrive. Don&apos;t let resellers control your story, your reputation, or
        your profits. The demand for {brand.name} on Amazon is already there — the question is who is
        capturing it.
      </Text>
      <Text style={styles.body}>
        This document is a starting point, not a contract. The real work begins with a 30-minute
        conversation where we put your unit economics into the model and show you what the channel is
        actually worth in your hands.
      </Text>
      <View style={styles.card}>
        <Text style={styles.small}>
          Prepared by Rolle Consulting Group. All figures attributed to your brand are derived from
          publicly observable Amazon data. Illustrative figures are clearly labeled and should not be
          treated as forecasts.
        </Text>
      </View>
      <PageFooter pageLabel="8 / 8" />
    </Page>
  );
}

// =====================================================================
// Top-level document
// =====================================================================
export interface AuditReportProps {
  brand: BrandForReport;
  narrative: NarrativeOutput;
  contactEmail: string;
  generatedAt: Date;
}

export function AuditReport({ brand, narrative, contactEmail, generatedAt }: AuditReportProps) {
  const dateStr = generatedAt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  return (
    <Document
      title={`Channel Ownership Audit — ${brand.name}`}
      author="Rolle Consulting Group"
      subject="Channel Ownership Audit"
    >
      <Cover brand={brand} dateStr={dateStr} />
      <ProblemPage />
      <FootprintPage brand={brand} callouts={narrative.footprint_callouts_md} />
      <ResellerRealityPage brand={brand} narrative={narrative} />
      <OpportunityPage brand={brand} narrative={narrative} />
      <FiveStepPage />
      <CaseStudyPage />
      <NextStepPage contactEmail={contactEmail} />
      <ClosingPage brand={brand} />
    </Document>
  );
}

export async function renderAuditPdf(props: AuditReportProps): Promise<Buffer> {
  ensureFonts();
  return renderToBuffer(<AuditReport {...props} />);
}

// =====================================================================
// helpers
// =====================================================================
function moneyFmt(n: number | null | undefined): string {
  if (n == null || isNaN(Number(n))) return "—";
  return `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function numFmt(n: number | null | undefined, decimals = 0): string {
  if (n == null || isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("en-US", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: 0,
  });
}

function splitParagraphs(md: string): string[] {
  if (!md) return [];
  return md
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
