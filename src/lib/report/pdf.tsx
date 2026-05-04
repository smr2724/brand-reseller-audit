/* eslint-disable jsx-a11y/alt-text */
import React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Font,
  Svg,
  Rect,
  Line,
  Circle,
  renderToBuffer,
} from "@react-pdf/renderer";
import type { BrandForReport, NarrativeOutput } from "./narrative";
import type { BrandEnrichmentBundle } from "@/lib/enrichment";

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
// Palette
// =====================================================================
const PALETTE = {
  ink: "#0B1220",
  paper: "#F7F5F0",
  gold: "#D4B36A",
  rule: "#1F2937",
  muted: "#4B5563",
  softRule: "#D6D3CB",
  blue: "#3B6EA5",
  red: "#B5483D",
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
  h1: { fontFamily: "Helvetica-Bold", fontSize: 32, lineHeight: 1.15, marginBottom: 12, color: PALETTE.ink },
  h2: { fontFamily: "Helvetica-Bold", fontSize: 22, lineHeight: 1.2, marginBottom: 14, color: PALETTE.ink },
  h3: { fontFamily: "Helvetica-Bold", fontSize: 14, marginBottom: 6, color: PALETTE.ink },
  eyebrow: { fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", color: PALETTE.muted, marginBottom: 8 },
  body: { fontSize: 11, color: PALETTE.ink, marginBottom: 8 },
  small: { fontSize: 9, color: PALETTE.muted },
  goldRule: { height: 3, width: 48, backgroundColor: PALETTE.gold, marginBottom: 18 },
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
  coverFrame: { flex: 1, justifyContent: "space-between" },
  coverTopBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  coverBrandMark: { fontFamily: "Helvetica-Bold", fontSize: 12, letterSpacing: 2, textTransform: "uppercase" },
  coverGold: { color: PALETTE.gold },
  coverHeadline: { fontFamily: "Helvetica-Bold", fontSize: 44, lineHeight: 1.1, marginBottom: 24 },
  coverSubhead: { fontSize: 14, color: PALETTE.muted, marginBottom: 6 },
  card: {
    backgroundColor: "#FFFFFF",
    borderWidth: 0.5,
    borderColor: PALETTE.softRule,
    padding: 16,
    marginBottom: 14,
    borderRadius: 4,
  },
  pullquote: { fontStyle: "italic", fontSize: 13, color: PALETTE.ink, marginBottom: 6, lineHeight: 1.4 },
  attribution: { fontSize: 9, color: PALETTE.muted },
  statGrid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -6, marginBottom: 14 },
  statCell: { width: "50%", paddingHorizontal: 6, marginBottom: 12 },
  statLabel: {
    fontSize: 8, letterSpacing: 1.2, textTransform: "uppercase",
    color: PALETTE.muted, marginBottom: 3,
  },
  statValue: { fontFamily: "Helvetica-Bold", fontSize: 16, color: PALETTE.ink },
  bulletRow: { flexDirection: "row", marginBottom: 6 },
  bulletDot: { width: 10, color: PALETTE.gold, fontFamily: "Helvetica-Bold" },
  bulletText: { flex: 1, fontSize: 11, color: PALETTE.ink },
  stepRow: { flexDirection: "row", marginBottom: 12 },
  stepNum: { width: 28, fontFamily: "Helvetica-Bold", fontSize: 18, color: PALETTE.gold },
  stepBody: { flex: 1 },
  stepTitle: { fontFamily: "Helvetica-Bold", fontSize: 12, marginBottom: 2 },
  stepDesc: { fontSize: 10.5, color: PALETTE.ink },
  twoCol: { flexDirection: "row", gap: 12 },
  col: { flex: 1 },
});

// =====================================================================
// Helpers
// =====================================================================
function moneyFmt(n: number | null | undefined): string {
  if (n == null || isNaN(Number(n))) return "—";
  return `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
function numFmt(n: number | null | undefined, decimals = 0): string {
  if (n == null || isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: decimals, minimumFractionDigits: 0 });
}
function pctFmt(n: number | null | undefined): string {
  if (n == null || !isFinite(Number(n))) return "—";
  return `${Math.round(Number(n) * 100)}%`;
}
function volumeFmt(n: number | null | undefined): string {
  if (n == null || !isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}
function splitParagraphs(md: string): string[] {
  if (!md) return [];
  return md.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
}
function shortDate(d: string | null | undefined): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "—";
  }
}

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
          <Text style={[styles.small, { marginTop: 4 }]}>
            Sources: Keepa (channel control) · DataForSEO (market demand) · SmartScout (footprint)
          </Text>
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
      <PageFooter pageLabel="1 / 11" />
    </Page>
  );
}

function FootprintPage({ brand, callouts }: { brand: BrandForReport; callouts: string[] }) {
  const stats: { label: string; value: string }[] = [
    { label: "Brand Score", value: numFmt(brand.brand_score, 2) },
    { label: "Est Monthly Revenue", value: moneyFmt(brand.est_monthly_revenue) },
    { label: "Trailing 12-Month Revenue", value: moneyFmt(brand.trailing_12_months) },
    { label: "Total Products", value: numFmt(brand.total_products) },
    { label: "Avg Sellers / ASIN", value: numFmt(brand.avg_sellers, 1) },
    { label: "Avg FBA Sellers / ASIN", value: numFmt(brand.avg_fba_sellers, 1) },
    {
      label: "Dominant Seller Share",
      value: brand.dominant_seller_sales_pct == null ? "—" : `${Math.round(Number(brand.dominant_seller_sales_pct))}%`,
    },
    {
      label: "Dominant Seller",
      value: brand.dominant_seller_name
        ? `${brand.dominant_seller_name}${brand.dominant_seller_country ? ` · ${brand.dominant_seller_country}` : ""}`
        : "—",
    },
    { label: "Brand Storefront", value: brand.has_storefront == null ? "—" : brand.has_storefront ? "Yes" : "No" },
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
      <PageFooter pageLabel="2 / 11" />
    </Page>
  );
}

// ---- Channel Health (Keepa) ----
function ChannelHealthPage({ bundle }: { bundle: BrandEnrichmentBundle | null }) {
  const k = bundle?.keepa;
  const sellers = (k?.sellers ?? []).slice(0, 6);

  const stats = [
    { label: "ASINs Tracked", value: numFmt(k?.asin_count ?? null) },
    { label: "Unique Sellers", value: numFmt(k?.unique_seller_count ?? null) },
    { label: "Brand-Controlled", value: pctFmt(k?.brand_controlled_pct ?? null) },
    { label: "Avg Offers / ASIN", value: numFmt(k?.avg_offers ?? null, 1) },
    { label: "Top Seller", value: k?.top_seller ?? "—" },
    { label: "Top Seller Share", value: pctFmt(k?.top_seller_share_pct ?? null) },
  ];

  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Section 3 — Channel Health (Keepa)</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>Who is winning the buy box on your listings?</Text>
      {!k || (k.asin_count ?? 0) === 0 ? (
        <Text style={styles.body}>
          We did not capture Keepa channel data for this snapshot. Re-run enrichment on the brand detail
          page and regenerate the report — channel-control claims in the rest of this document fall back
          to SmartScout footprint signals only.
        </Text>
      ) : (
        <>
          <Text style={styles.body}>
            Keepa observes seller counts, buy-box winners, and offer fragmentation across the catalog.
            High top-seller share with low brand-controlled buy-box wins is the headline of an unhealthy
            channel.
          </Text>
          <View style={styles.statGrid}>
            {stats.map((s, i) => (
              <View key={i} style={styles.statCell}>
                <Text style={styles.statLabel}>{s.label}</Text>
                <Text style={styles.statValue}>{s.value}</Text>
              </View>
            ))}
          </View>

          {sellers.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.h3}>Top buy-box winners</Text>
              <SellerShareChart sellers={sellers} brandName={bundle?.brandName ?? ""} />
              <View style={{ marginTop: 8 }}>
                {sellers.map((s, i) => (
                  <View
                    key={i}
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      paddingVertical: 4,
                      borderBottomWidth: i === sellers.length - 1 ? 0 : 0.5,
                      borderBottomColor: PALETTE.softRule,
                    }}
                  >
                    <Text style={{ fontSize: 10.5 }}>{s.seller_name ?? "Unknown 3P seller"}</Text>
                    <Text style={{ fontSize: 10.5, color: PALETTE.muted }}>
                      {pctFmt(s.share_pct ?? null)} · {s.asins_won ?? 0} ASINs
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          <Text style={styles.small}>
            Keepa freshness: {shortDate(k.last_enriched_at)}
          </Text>
        </>
      )}
      <PageFooter pageLabel="3 / 11" />
    </Page>
  );
}

function SellerShareChart({
  sellers,
  brandName,
}: {
  sellers: { seller_name: string | null; share_pct: number | null }[];
  brandName: string;
}) {
  const W = 460;
  const H = 64;
  const padding = 1;
  const total = sellers.reduce((a, s) => a + (s.share_pct ?? 0), 0) || 1;

  let cursor = 0;
  return (
    <Svg width={W} height={H}>
      <Rect x={0} y={0} width={W} height={H} fill="#F4F1EA" />
      {sellers.map((s, i) => {
        const w = ((s.share_pct ?? 0) / total) * (W - padding * 2);
        const x = padding + cursor;
        cursor += w;
        const isBrand = (s.seller_name ?? "").toLowerCase().includes(brandName.toLowerCase());
        const fill = isBrand ? PALETTE.gold : i === 0 ? PALETTE.red : PALETTE.blue;
        return <Rect key={i} x={x} y={padding} width={Math.max(0, w - 1)} height={H - padding * 2} fill={fill} />;
      })}
    </Svg>
  );
}

// ---- Market Demand (DataForSEO) ----
function MarketDemandPage({
  bundle,
  narrative,
}: {
  bundle: BrandEnrichmentBundle | null;
  narrative: NarrativeOutput;
}) {
  const d = bundle?.dataforseo;
  const paragraphs = splitParagraphs(narrative.market_demand_md);
  const hasData = (d?.branded_search_volume ?? 0) > 0 || (d?.top_keywords?.length ?? 0) > 0;

  const stats = [
    { label: "Branded Volume / mo", value: volumeFmt(d?.branded_search_volume ?? null) },
    { label: "Branded Trend", value: d?.branded_trend_pct == null ? "—" : `${(d.branded_trend_pct as number) > 0 ? "+" : ""}${Number(d.branded_trend_pct).toFixed(1)}%` },
    { label: "Top Keyword", value: d?.top_keywords?.[0]?.keyword ?? "—" },
    { label: "Competitors Tracked", value: numFmt(d?.competitor_brands?.length ?? 0) },
    { label: "Est Branded Traffic Value", value: moneyFmt(d?.organic_traffic_value ?? null) },
    { label: "Snapshot", value: shortDate(d?.captured_at) },
  ];

  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Section 4 — Market Demand (DataForSEO)</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>What is the market actually asking for?</Text>
      {paragraphs.map((p, i) => (
        <Text key={i} style={styles.body}>{p}</Text>
      ))}

      <View style={styles.statGrid}>
        {stats.map((s, i) => (
          <View key={i} style={styles.statCell}>
            <Text style={styles.statLabel}>{s.label}</Text>
            <Text style={styles.statValue}>{s.value}</Text>
          </View>
        ))}
      </View>

      {hasData && (d?.top_keywords?.length ?? 0) > 0 && (
        <View style={styles.card}>
          <Text style={styles.h3}>Top branded keywords</Text>
          {(d?.top_keywords ?? []).slice(0, 6).map((kw, i) => (
            <View
              key={i}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                paddingVertical: 4,
                borderBottomWidth: i === Math.min(5, (d?.top_keywords?.length ?? 0) - 1) ? 0 : 0.5,
                borderBottomColor: PALETTE.softRule,
              }}
            >
              <Text style={{ fontSize: 10.5 }}>{kw.keyword}</Text>
              <Text style={{ fontSize: 10.5, color: PALETTE.muted }}>{volumeFmt(kw.search_volume ?? null)}/mo</Text>
            </View>
          ))}
        </View>
      )}

      {hasData && (d?.competitor_brands?.length ?? 0) > 0 && (
        <View style={styles.card}>
          <Text style={styles.h3}>Competitors on branded SERPs</Text>
          {(d?.competitor_brands ?? []).slice(0, 5).map((c, i) => (
            <View
              key={i}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                paddingVertical: 4,
                borderBottomWidth: i === Math.min(4, (d?.competitor_brands?.length ?? 0) - 1) ? 0 : 0.5,
                borderBottomColor: PALETTE.softRule,
              }}
            >
              <Text style={{ fontSize: 10.5 }}>{c.brand}</Text>
              <Text style={{ fontSize: 10.5, color: PALETTE.muted }}>{pctFmt(c.share_of_serp)}</Text>
            </View>
          ))}
        </View>
      )}
      <PageFooter pageLabel="4 / 11" />
    </Page>
  );
}

// ---- The Gap ----
function TheGapPage({
  bundle,
  narrative,
}: {
  bundle: BrandEnrichmentBundle | null;
  narrative: NarrativeOutput;
}) {
  const k = bundle?.keepa;
  const d = bundle?.dataforseo;
  const paragraphs = splitParagraphs(narrative.the_gap_md);
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Section 5 — The Gap</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>Demand without ownership.</Text>
      {paragraphs.map((p, i) => (
        <Text key={i} style={styles.body}>{p}</Text>
      ))}
      <View style={styles.twoCol}>
        <View style={[styles.col, styles.card]}>
          <Text style={styles.statLabel}>Demand (DataForSEO)</Text>
          <Text style={styles.statValue}>{volumeFmt(d?.branded_search_volume ?? null)}/mo</Text>
          <Text style={styles.small}>
            Trend: {d?.branded_trend_pct == null ? "—" : `${(d.branded_trend_pct as number) > 0 ? "+" : ""}${Number(d.branded_trend_pct).toFixed(1)}%`}
          </Text>
        </View>
        <View style={[styles.col, styles.card]}>
          <Text style={styles.statLabel}>Brand-Controlled (Keepa)</Text>
          <Text style={styles.statValue}>{pctFmt(k?.brand_controlled_pct ?? null)}</Text>
          <Text style={styles.small}>Top seller: {k?.top_seller ?? "—"} ({pctFmt(k?.top_seller_share_pct ?? null)})</Text>
        </View>
      </View>
      <PageFooter pageLabel="5 / 11" />
    </Page>
  );
}

// ---- Opportunity Quadrant ----
function OpportunityQuadrantPage({ bundle }: { bundle: BrandEnrichmentBundle | null }) {
  const W = 460;
  const H = 320;
  const margin = 36;
  const x0 = margin;
  const y0 = H - margin;
  const x1 = W - margin;
  const y1 = margin;

  const k = bundle?.keepa;
  const d = bundle?.dataforseo;

  // x = demand (log-scaled volume, 0..1)
  const vol = Math.max(0, d?.branded_search_volume ?? 0);
  const demand = vol > 0 ? Math.min(1, Math.log10(1 + vol) / Math.log10(1 + 100_000)) : 0;
  // y = channel-control gap (1 - brand_controlled_pct), 0..1
  const ctrl = k?.brand_controlled_pct ?? 0;
  const gap = Math.max(0, Math.min(1, 1 - (ctrl ?? 0)));

  const px = x0 + demand * (x1 - x0);
  const py = y0 - gap * (y0 - y1);

  const midX = (x0 + x1) / 2;
  const midY = (y0 + y1) / 2;

  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Section 6 — Opportunity Quadrant</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>Where this brand lands on the matrix.</Text>
      <Text style={styles.body}>
        x-axis: branded search demand (DataForSEO, log-scaled). y-axis: channel-control gap (Keepa, share
        of buy boxes the brand does <Text style={{ fontFamily: "Helvetica-Bold" }}>not</Text> own).
        Higher and to the right = larger reclamation opportunity.
      </Text>
      <View style={styles.card}>
        <View style={{ position: "relative", width: W, height: H, alignSelf: "center" }}>
          <Svg width={W} height={H}>
            <Line x1={x0} y1={y0} x2={x1} y2={y0} strokeWidth={0.8} stroke={PALETTE.muted} />
            <Line x1={x0} y1={y0} x2={x0} y2={y1} strokeWidth={0.8} stroke={PALETTE.muted} />
            <Line x1={midX} y1={y0} x2={midX} y2={y1} strokeWidth={0.4} stroke={PALETTE.softRule} />
            <Line x1={x0} y1={midY} x2={x1} y2={midY} strokeWidth={0.4} stroke={PALETTE.softRule} />
            <Circle cx={px} cy={py} r={6} fill={PALETTE.gold} />
            <Circle cx={px} cy={py} r={10} fill="none" stroke={PALETTE.gold} strokeWidth={1} />
          </Svg>
          <View style={{ position: "absolute", top: y1 + 4, left: x0 + 6 }}>
            <Text style={{ fontSize: 9, color: PALETTE.muted }}>Recapture · low demand, big gap</Text>
          </View>
          <View style={{ position: "absolute", top: y1 + 4, left: midX + 6 }}>
            <Text style={{ fontSize: 9, color: PALETTE.muted }}>Defend · high demand, big gap</Text>
          </View>
          <View style={{ position: "absolute", top: y0 - 18, left: x0 + 6 }}>
            <Text style={{ fontSize: 9, color: PALETTE.muted }}>Educate · low demand, owned</Text>
          </View>
          <View style={{ position: "absolute", top: y0 - 18, left: midX + 6 }}>
            <Text style={{ fontSize: 9, color: PALETTE.muted }}>Partner · high demand, owned</Text>
          </View>
        </View>
        <Text style={[styles.small, { marginTop: 8 }]}>
          Brand position: demand {Math.round(demand * 100)} / 100, channel gap {Math.round(gap * 100)} / 100.
          Validation score: {bundle?.validationScore == null ? "—" : Math.round(bundle.validationScore)} / 100.
        </Text>
      </View>
      <PageFooter pageLabel="6 / 11" />
    </Page>
  );
}

// ---- Reseller Reality (existing) ----
function ResellerRealityPage({ brand, narrative }: { brand: BrandForReport; narrative: NarrativeOutput }) {
  const paragraphs = splitParagraphs(narrative.reseller_reality_md);
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Section 7 — The Reseller Reality</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>Whose channel is it, really?</Text>
      {paragraphs.map((p, i) => (
        <Text key={i} style={styles.body}>{p}</Text>
      ))}
      <Text style={styles.small}>
        Signals referenced above come from Keepa channel observations and SmartScout for {brand.name}.
      </Text>
      <PageFooter pageLabel="7 / 11" />
    </Page>
  );
}

// ---- Value Add Quantification ----
function ValueAddPage({
  brand,
  narrative,
  bundle,
}: {
  brand: BrandForReport;
  narrative: NarrativeOutput;
  bundle: BrandEnrichmentBundle | null;
}) {
  const paragraphs = splitParagraphs(narrative.value_add_md);
  const signals = bundle?.valueAddSignals ?? [];
  const haveOverlay =
    brand.current_profit != null || brand.additional_profit != null || brand.new_profit != null;

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
      <Text style={styles.eyebrow}>Section 8 — Value Add Quantification</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>The math, hedged but real.</Text>
      {paragraphs.map((p, i) => (
        <Text key={i} style={styles.body}>{p}</Text>
      ))}

      {signals.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.h3}>Signals driving the value add</Text>
          {signals.map((s, i) => (
            <View key={i} style={styles.bulletRow}>
              <Text style={styles.bulletDot}>•</Text>
              <Text style={styles.bulletText}>{s}</Text>
            </View>
          ))}
        </View>
      )}

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
            ? "Assumption: numbers above are illustrative and based on the working model we built for your brand. We re-derive the model on your actual unit economics during onboarding."
            : "Assumption: figures are illustrative — drawn from the operators we work with, not from your specific unit economics. We rebuild the model on your numbers during onboarding before any decision is made."}
        </Text>
      </View>
      <PageFooter pageLabel="8 / 11" />
    </Page>
  );
}

// ---- Five-step path (existing) ----
function FiveStepPage() {
  const steps = [
    { title: "Identify the Opportunity", desc: "Audit current Amazon presence, demand signals, and reseller activity. Map listings that already work to the SKUs you produce." },
    { title: "Set Up Your Amazon Account", desc: "Create or optimize the seller account. Align SKUs with what resellers proved works on the platform." },
    { title: "Protect the Brand", desc: "Brand Registry, monitoring tools, enforcement SOPs. Update wholesale agreements to prohibit reselling on Amazon." },
    { title: "Transition to In-House", desc: "Take over listings. Stock FBA. Give existing resellers a respectful sell-out window. Avoid retaliation, preserve wholesale relationships that matter." },
    { title: "Build and Train a Team", desc: "1–2 US-based team members plus offshore support. Customized training and ongoing support so you own the operation, not us." },
  ];
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Section 9 — Our 5-Step Path</Text>
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
      <PageFooter pageLabel="9 / 11" />
    </Page>
  );
}

function NextStepPage({ contactEmail }: { contactEmail: string }) {
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Section 10 — Next Step</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>Book your roadmap call.</Text>
      <Text style={styles.body}>
        No obligation. No pitch deck. We walk through this audit together, show you the model on your
        actual unit economics, and you decide whether the path makes sense for your business.
      </Text>
      <View style={styles.card}>
        <Text style={styles.h3}>Reach Steve directly</Text>
        <Text style={styles.body}>{contactEmail}</Text>
        <Text style={styles.small}>Reply with your reseller pricing and your goals — we&apos;ll send you a calendar link.</Text>
      </View>
      <View style={[styles.card, { backgroundColor: PALETTE.ink }]}>
        <Text style={[styles.h3, { color: PALETTE.paper }]}>Our terms</Text>
        <Text style={[styles.body, { color: PALETTE.paper }]}>50% of the additional first-year profit. No upfront cost.</Text>
        <Text style={{ fontSize: 9, color: PALETTE.gold }}>
          If we don&apos;t generate additional profit, we don&apos;t get paid.
        </Text>
      </View>
      <PageFooter pageLabel="10 / 11" />
    </Page>
  );
}

// ---- Methodology (data sources + freshness) ----
function MethodologyPage({
  bundle,
  generatedAt,
}: {
  bundle: BrandEnrichmentBundle | null;
  generatedAt: Date;
}) {
  const dateStr = generatedAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const sources = [
    {
      name: "Keepa",
      role: "Channel control — buy-box winners, seller counts, brand-controlled share, offer fragmentation across the catalog.",
      freshness: shortDate(bundle?.freshness?.keepa ?? null),
      present: !!bundle?.freshness?.keepa || (bundle?.keepa?.asin_count ?? 0) > 0,
    },
    {
      name: "DataForSEO",
      role: "Market demand — branded Amazon search volume, trend, top keywords, competitor SERP share.",
      freshness: shortDate(bundle?.freshness?.dataforseo ?? null),
      present: !!bundle?.freshness?.dataforseo || (bundle?.dataforseo?.top_keywords?.length ?? 0) > 0,
    },
    {
      name: "SmartScout",
      role: "Footprint baseline — brand score, monthly revenue estimate, dominant seller, storefront presence.",
      freshness: dateStr,
      present: true,
    },
  ];

  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Section 11 — Methodology &amp; Sources</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>Where every number in this report came from.</Text>
      <Text style={styles.body}>
        This audit combines three independent data sources. Each fact in the report is tied back to one
        of them — we do not mix or aggregate beyond what is shown here.
      </Text>
      <View style={styles.card}>
        {sources.map((s, i) => (
          <View key={s.name} style={{ paddingVertical: 8, borderBottomWidth: i === sources.length - 1 ? 0 : 0.5, borderBottomColor: PALETTE.softRule }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
              <Text style={styles.h3}>{s.name}</Text>
              <Text style={styles.small}>{s.present ? `Snapshot: ${s.freshness}` : "Not captured in this snapshot"}</Text>
            </View>
            <Text style={styles.body}>{s.role}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.small}>
        Validation score combines Keepa channel signals (45 pt envelope) with DataForSEO demand and
        competitive-pressure signals (35 + 20 pt envelopes). Numeric assumptions in the report are
        labeled &ldquo;Assumption&rdquo; or &ldquo;illustrative&rdquo; wherever the value is derived rather than
        observed.
      </Text>
      <PageFooter pageLabel="11 / 11" />
    </Page>
  );
}

// =====================================================================
// Top-level document
// =====================================================================
export interface AuditReportProps {
  brand: BrandForReport;
  narrative: NarrativeOutput;
  bundle: BrandEnrichmentBundle | null;
  contactEmail: string;
  generatedAt: Date;
}

export function AuditReport({ brand, narrative, bundle, contactEmail, generatedAt }: AuditReportProps) {
  const dateStr = generatedAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  return (
    <Document
      title={`Channel Ownership Audit — ${brand.name}`}
      author="Rolle Consulting Group"
      subject="Channel Ownership Audit"
    >
      <Cover brand={brand} dateStr={dateStr} />
      <ProblemPage />
      <FootprintPage brand={brand} callouts={narrative.footprint_callouts_md} />
      <ChannelHealthPage bundle={bundle} />
      <MarketDemandPage bundle={bundle} narrative={narrative} />
      <TheGapPage bundle={bundle} narrative={narrative} />
      <OpportunityQuadrantPage bundle={bundle} />
      <ResellerRealityPage brand={brand} narrative={narrative} />
      <ValueAddPage brand={brand} narrative={narrative} bundle={bundle} />
      <FiveStepPage />
      <NextStepPage contactEmail={contactEmail} />
      <MethodologyPage bundle={bundle} generatedAt={generatedAt} />
    </Document>
  );
}

export async function renderAuditPdf(props: AuditReportProps): Promise<Buffer> {
  ensureFonts();
  return renderToBuffer(<AuditReport {...props} />);
}
