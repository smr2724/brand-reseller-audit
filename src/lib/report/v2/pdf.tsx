/**
 * Phase 42 — v2 audit report PDF.
 *
 * Mirrors the live HTML report (`web.tsx`) section-for-section so the
 * downloadable PDF matches what the prospect just saw on the public
 * page. Three layout modes flow off the persisted classification
 * snapshot, identical to the web renderer:
 *
 *   - "tight"        : Phase 41a short benchmark layout (10 sections).
 *   - "legacy-diy"   : older diy_fit reports without a snapshot.
 *   - "opportunity"  : Phase 40 executive long layout (14 sections).
 *
 * All economics math runs through `computeLegionEconomics` /
 * `computeBenchmarkEconomics` — never inlined here.
 */
/* eslint-disable jsx-a11y/alt-text */
import React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import type { BrandEnrichmentBundle } from "@/lib/enrichment";
import type { BrandForReport } from "@/lib/report/narrative";
import {
  computeBenchmarkEconomics,
  computeLegionEconomics,
  type LegionOutputs,
} from "@/lib/math/legion-economics";
import {
  confidenceForBusinessValue,
  confidenceForProfitRecapture,
  confidenceForRevenue,
  confidenceForSellerControl,
  deriveSnapshot,
  lookupClassification,
  type ConfidenceLabel,
  type DerivedSnapshot,
  type SellerClassificationSnapshotEntry,
} from "./snapshot-derive";
import { findResellerByName, pickHook } from "./hooks";
import {
  DEFAULT_ASSUMPTIONS,
  type CxAuditAsinScore,
  type DiyStep,
  type NarrativeV2,
  type ReportAssumptions,
  type ResellerRow,
} from "./types";
import { DIVERSIFIED_HOSPITALITY_CASE_STUDY } from "./case-studies";

// =====================================================================
// Palette + base styles (cream paper for print)
// =====================================================================

const P = {
  ink: "#0B1220",
  paper: "#F7F5F0",
  card: "#FFFFFF",
  cardAlt: "#F1ECDF",
  gold: "#C9A96A",
  goldSoft: "#D8B878",
  goldFaint: "#F4ECD4",
  muted: "#4B5563",
  rule: "#D6D3CB",
  red: "#B5483D",
  green: "#3F8F62",
  blueAmazon: "#2563EB",
  warnBg: "#FBE9D6",
  goodBg: "#E8F2EB",
};

const styles = StyleSheet.create({
  page: {
    backgroundColor: P.paper,
    color: P.ink,
    paddingTop: 48,
    paddingBottom: 56,
    paddingHorizontal: 48,
    fontFamily: "Helvetica",
    fontSize: 11,
    lineHeight: 1.45,
  },
  // Headings
  eyebrow: {
    fontSize: 9, letterSpacing: 1.4, textTransform: "uppercase",
    color: P.gold, marginBottom: 6, fontFamily: "Helvetica-Bold",
  },
  source: {
    fontSize: 8, color: P.muted, marginBottom: 12,
    textTransform: "uppercase", letterSpacing: 0.6,
  },
  h1: { fontFamily: "Helvetica-Bold", fontSize: 24, lineHeight: 1.18, marginBottom: 14, color: P.ink },
  h2: { fontFamily: "Helvetica-Bold", fontSize: 18, marginBottom: 8, color: P.ink },
  h3: { fontFamily: "Helvetica-Bold", fontSize: 12, marginBottom: 4, color: P.ink },
  body: { fontSize: 11, color: P.ink, marginBottom: 8 },
  bold: { fontFamily: "Helvetica-Bold" },
  small: { fontSize: 9, color: P.muted },
  smallInk: { fontSize: 9, color: P.ink },
  goldRule: { height: 2, width: 36, backgroundColor: P.gold, marginBottom: 12 },
  prose: { fontSize: 11, color: P.ink, marginBottom: 10, lineHeight: 1.55 },
  proseCallout: {
    backgroundColor: "#F1ECDF",
    borderLeftWidth: 2, borderLeftColor: P.gold,
    padding: 10, marginVertical: 8, fontSize: 11, color: P.ink, lineHeight: 1.55,
  },
  footer: {
    position: "absolute", bottom: 28, left: 48, right: 48,
    flexDirection: "row", justifyContent: "space-between",
    fontSize: 8, color: P.muted,
    borderTopWidth: 0.5, borderTopColor: P.rule, paddingTop: 6,
  },

  // Section + headers
  sectionHead: { marginBottom: 16 },

  // KPIs
  kpiRow: { flexDirection: "row", marginHorizontal: -4, marginVertical: 8 },
  kpi: {
    flex: 1, marginHorizontal: 4, padding: 12,
    borderWidth: 0.5, borderColor: P.rule, borderRadius: 4, backgroundColor: P.card,
  },
  kpiNum: { fontFamily: "Helvetica-Bold", fontSize: 16, color: P.gold, marginBottom: 4 },
  kpiLbl: { fontSize: 9, marginTop: 4, color: P.ink },
  kpiSub: { fontSize: 8, marginTop: 2, color: P.muted },
  kpiConf: { marginTop: 6 },

  // Confidence pill
  pill: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 2, paddingHorizontal: 6,
    borderRadius: 8, alignSelf: "flex-start",
    fontSize: 7, fontFamily: "Helvetica-Bold",
  },
  pillDot: { width: 6, height: 6, borderRadius: 3, marginRight: 4 },

  // Bars (reseller list)
  bar: { flexDirection: "row", alignItems: "center", marginBottom: 6, fontSize: 10 },
  barRank: { width: 16, color: P.gold, fontFamily: "Helvetica-Bold" },
  barName: { width: 130, color: P.ink, fontSize: 9 },
  barTrack: { flex: 1, height: 8, backgroundColor: P.rule, marginHorizontal: 6, borderRadius: 2 },
  barFill: { height: 8, backgroundColor: P.gold, borderRadius: 2 },
  barFillGood: { backgroundColor: P.green },
  barVal: { width: 38, textAlign: "right", color: P.goldSoft, fontSize: 9 },
  barAsins: { width: 60, textAlign: "right", color: P.muted, fontSize: 8 },

  // Generic table
  table: { borderTopWidth: 0.5, borderTopColor: P.rule, marginVertical: 8 },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 0.5, borderBottomColor: P.rule,
    paddingVertical: 5,
  },
  tableHead: { color: P.muted, fontSize: 8, textTransform: "uppercase", letterSpacing: 0.6, fontFamily: "Helvetica-Bold" },
  tableCell: { fontSize: 10, color: P.ink, paddingHorizontal: 4 },
  tableCellNum: { fontSize: 10, color: P.goldSoft, paddingHorizontal: 4, textAlign: "right" },

  // Cards
  card: {
    backgroundColor: P.card, borderWidth: 0.5, borderColor: P.rule,
    padding: 12, marginVertical: 6, borderRadius: 4,
  },
  factGrid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -4 },
  fact: { width: "33%", padding: 4 },
  factLbl: { fontSize: 8, color: P.muted, textTransform: "uppercase", letterSpacing: 0.6 },
  factVal: { fontSize: 10, color: P.ink, fontFamily: "Helvetica-Bold", marginTop: 2 },

  // Channel cards (for cards row in channel-control / tight buybox)
  channelGrid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -4 },
  channelCard: {
    width: "33%",
    padding: 4,
  },
  channelCardInner: {
    backgroundColor: P.card, borderWidth: 0.5, borderColor: P.rule,
    borderRadius: 4, padding: 10,
  },
  channelCardGood: { borderLeftWidth: 3, borderLeftColor: P.green },
  channelCardWarn: { borderLeftWidth: 3, borderLeftColor: P.red },
  channelCardLbl: { fontSize: 8, color: P.muted, textTransform: "uppercase", letterSpacing: 0.6 },
  channelCardVal: { fontSize: 14, color: P.ink, fontFamily: "Helvetica-Bold", marginTop: 4 },
  channelCardSub: { fontSize: 8, color: P.muted, marginTop: 2 },

  // Buy-box bar (4-bucket horizontal)
  bbBar: {
    flexDirection: "row", height: 22, borderRadius: 3,
    overflow: "hidden",
    marginVertical: 8,
    backgroundColor: P.rule,
  },
  bbSeg: { justifyContent: "center", alignItems: "center", paddingHorizontal: 4 },
  bbSegBrand: { backgroundColor: P.green },
  bbSegAuthorized: { backgroundColor: P.goldSoft },
  bbSegAmazon: { backgroundColor: P.blueAmazon },
  bbSegReseller: { backgroundColor: P.red },
  bbSegEmpty: { backgroundColor: P.rule },
  bbSegLabel: { fontSize: 7, color: "#FFFFFF", fontFamily: "Helvetica-Bold" },
  bbLegendRow: {
    flexDirection: "row", flexWrap: "wrap", marginTop: 4,
  },
  bbLegendItem: {
    flexDirection: "row", alignItems: "center",
    marginRight: 14, marginBottom: 4, fontSize: 8,
  },
  bbLegendSwatch: { width: 10, height: 10, borderRadius: 2, marginRight: 4 },
  bbNote: { fontSize: 8, color: P.muted, marginTop: 4 },

  // Step / framework cards
  stepRow: { flexDirection: "row", marginHorizontal: -4, marginVertical: 6, flexWrap: "wrap" },
  stepCard: {
    width: "33%", padding: 4,
  },
  stepCardInner: {
    backgroundColor: P.card, borderWidth: 0.5, borderColor: P.rule,
    borderRadius: 4, padding: 10,
  },
  stepNum: { fontSize: 8, color: P.gold, textTransform: "uppercase", letterSpacing: 0.8, fontFamily: "Helvetica-Bold" },
  stepTitle: { fontSize: 11, color: P.ink, fontFamily: "Helvetica-Bold", marginTop: 4, marginBottom: 4 },
  stepBody: { fontSize: 9, color: P.ink, lineHeight: 1.5 },

  // Bullets
  bulletRow: { flexDirection: "row", marginBottom: 4 },
  bulletDot: { width: 8, fontSize: 11, color: P.ink, lineHeight: 1.5 },
  bulletText: { flex: 1, fontSize: 10, color: P.ink, lineHeight: 1.5 },

  // Hero block
  heroValueLine: { fontSize: 12, color: P.ink, lineHeight: 1.55, marginBottom: 14 },

  // SellerInitialBadge
  initialBadge: {
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: P.gold, color: "#FFFFFF",
    fontSize: 8, fontFamily: "Helvetica-Bold",
    textAlign: "center",
    marginRight: 6,
  },
  checklistRow: {
    flexDirection: "row", alignItems: "center", marginBottom: 4,
  },

  // Bridge body (financial)
  bridgeRow: {
    flexDirection: "row",
    borderBottomWidth: 0.5, borderBottomColor: P.rule,
    paddingVertical: 6,
  },
  bridgeRowTotal: { backgroundColor: P.goldFaint },
  bridgeColLabel: { flex: 3, paddingHorizontal: 4, fontSize: 10, color: P.ink },
  bridgeColValue: { flex: 1.2, paddingHorizontal: 4, fontSize: 10, color: P.ink, textAlign: "right", fontFamily: "Helvetica-Bold" },
  bridgeColNote: { flex: 3, paddingHorizontal: 4, fontSize: 8, color: P.muted },
  bridgeColConf: { flex: 1.2, paddingHorizontal: 4, alignItems: "flex-end" },

  // Banner
  bannerGood: {
    backgroundColor: P.goodBg,
    borderLeftWidth: 3, borderLeftColor: P.green,
    padding: 10, marginVertical: 8, fontSize: 10, color: P.ink,
  },
  bannerWarn: {
    backgroundColor: P.warnBg,
    borderLeftWidth: 3, borderLeftColor: P.gold,
    padding: 10, marginVertical: 8, fontSize: 10, color: P.ink,
  },
});

// =====================================================================
// Forbidden-language scrub (Phase 40 — applies to PDF too)
// =====================================================================

function sanitizeForbidden(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input);
  const replacements: [RegExp, string][] = [
    [/\bunauthorized importers?\b/gi, "third-party seller"],
    [/\bconfirmed unauthorized sellers?\b/gi, "third-party seller (authorization unknown)"],
    [/\btermination lists?\b/gi, "channel transition plan"],
    [/\bterminate\b/gi, "transition"],
    [/\bunauthorized resellers?\b/gi, "third-party seller (authorization unknown)"],
    [/\bdozens of brands\b/gi, "reseller-fragmented catalogs"],
    [
      /we only get paid if we add profit/gi,
      "engagements are structured around the size of the opportunity",
    ],
    [/the report sells the result;? this call just opens the door\.?/gi, ""],
    [
      /every number,?\s*every assumption/gi,
      "every line in the bridge is shown with its source",
    ],
  ];
  for (const [re, rep] of replacements) s = s.replace(re, rep);
  return s.trim();
}

// =====================================================================
// Helpers
// =====================================================================

function moneyFmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "— not measured";
  return `$${Math.round(Number(n)).toLocaleString("en-US")}`;
}

function pctFmt(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `${(Number(n) * 100).toFixed(digits)}%`;
}

function volFmt(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function unitsFmt(
  monthly: number | null | undefined,
  ttm: number | null | undefined,
): string {
  const hasMonthly = monthly != null && Number.isFinite(monthly);
  const hasTtm = ttm != null && Number.isFinite(ttm);
  if (!hasMonthly && !hasTtm) return "— not measured";
  const monthlyVal = hasMonthly
    ? (monthly as number)
    : ((ttm as number) / 12);
  const annualVal = hasTtm
    ? (ttm as number)
    : ((monthly as number) * 12);
  const monthlyLabel = Math.round(monthlyVal).toLocaleString("en-US");
  const annualLabel = Math.round(annualVal).toLocaleString("en-US");
  return `${monthlyLabel}/mo (~${annualLabel}/yr)`;
}

function paragraphs(md: string | null | undefined): string[] {
  if (!md) return [];
  return md.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
}

function longDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "long", day: "numeric", year: "numeric",
    });
  } catch {
    return "—";
  }
}

const AMAZON_SELLER_ID_RE = /^A[A-Z0-9]{12,13}$/;
function isAmazonSellerId(s: string | null | undefined): boolean {
  return !!s && AMAZON_SELLER_ID_RE.test(s.trim());
}
function friendlySellerName(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  if (!n) return "Unknown 3P seller";
  if (isAmazonSellerId(n)) return `Unknown 3P seller (ID: ${n})`;
  return n;
}
function sellerInitial(name: string): string {
  const cleaned = name.replace(/^Unknown 3P seller(?:\s*\(ID:.*\))?$/i, "").trim();
  const source = cleaned || name;
  const ch = source.replace(/[^A-Za-z0-9]/g, "").charAt(0);
  return ch ? ch.toUpperCase() : "?";
}

const COUNTRY_NAMES: Record<string, string> = {
  US: "United States", GB: "United Kingdom", UK: "United Kingdom",
  CA: "Canada", DE: "Germany", FR: "France", IT: "Italy", ES: "Spain",
  JP: "Japan", AU: "Australia", MX: "Mexico", CN: "China", IN: "India",
  BR: "Brazil", NL: "Netherlands", PL: "Poland", SE: "Sweden", TR: "Turkey",
  AE: "United Arab Emirates", SG: "Singapore", HK: "Hong Kong",
  TW: "Taiwan", KR: "South Korea",
};
function prettyCountry(c: string | null | undefined): string | null {
  if (!c) return null;
  const k = c.trim().toUpperCase();
  if (!k) return null;
  return COUNTRY_NAMES[k] ?? k;
}

function pickTopReseller(
  narrative: NarrativeV2,
  derived: DerivedSnapshot,
): string | null {
  const sellers = narrative.reseller_reality.top_sellers ?? [];
  for (const s of sellers) {
    const cls = lookupClassification(derived, s);
    if (cls === "reseller" || (cls == null && s.is_brand_controlled === false)) {
      return friendlySellerName(s.seller_name);
    }
  }
  return null;
}

function pickTopResellerShare(
  narrative: NarrativeV2,
  derived: DerivedSnapshot,
): number | null {
  const sellers = narrative.reseller_reality.top_sellers ?? [];
  for (const s of sellers) {
    const cls = lookupClassification(derived, s);
    if (cls === "reseller" || (cls == null && s.is_brand_controlled === false)) {
      return s.share_pct ?? null;
    }
  }
  return null;
}

// Mirror of web.tsx sanitizer for math notes — strip the appended
// "Revenue note: …" block which the LegionMathSection renders separately.
function cleanMathNotes(notes: string | null | undefined): string {
  if (!notes) return "";
  return String(notes).replace(/\n*Revenue note:[\s\S]*$/, "").trim();
}

// =====================================================================
// Reusable primitives
// =====================================================================

function PageFooter({ label, brandName }: { label: string; brandName: string }) {
  return (
    <View style={styles.footer} fixed>
      <Text>Channel Ownership Audit · Rolle Consulting Group · {brandName}</Text>
      <Text>{label}</Text>
    </View>
  );
}

function SectionHead({
  eyebrow,
  title,
  source,
}: {
  eyebrow: string;
  title: string;
  source?: string;
}) {
  return (
    <View style={styles.sectionHead}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.h2}>{title}</Text>
      <View style={[styles.goldRule, { marginTop: 4, marginBottom: 8 }]} />
      {source && <Text style={styles.source}>{source}</Text>}
    </View>
  );
}

function ConfidencePill({ level }: { level: ConfidenceLabel }) {
  const tone = level === "High"
    ? { bg: "#E8F2EB", fg: "#205A38" }
    : level === "Medium"
      ? { bg: "#FAF1DD", fg: "#7A5A1B" }
      : level === "Low"
        ? { bg: "#FBE5E0", fg: "#823127" }
        : { bg: "#EFEBDF", fg: "#5A4D2D" };
  return (
    <View style={[styles.pill, { backgroundColor: tone.bg }]}>
      <View style={[styles.pillDot, { backgroundColor: tone.fg }]} />
      <Text style={{ color: tone.fg, fontSize: 7, fontFamily: "Helvetica-Bold" }}>
        {level} confidence
      </Text>
    </View>
  );
}

function BigStat({
  label,
  value,
  sub,
  confidence,
}: {
  label: string;
  value: string;
  sub?: string;
  confidence?: ConfidenceLabel;
}) {
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiNum}>{value}</Text>
      <Text style={styles.kpiLbl}>{label}</Text>
      {sub && <Text style={styles.kpiSub}>{sub}</Text>}
      {confidence && (
        <View style={styles.kpiConf}>
          <ConfidencePill level={confidence} />
        </View>
      )}
    </View>
  );
}

function ChannelCard({
  label,
  value,
  sub,
  tone,
  confidence,
}: {
  label: string;
  value: string;
  sub?: string | null;
  tone?: "good" | "warn";
  confidence?: ConfidenceLabel;
}) {
  const innerStyle =
    tone === "good"
      ? [styles.channelCardInner, styles.channelCardGood]
      : tone === "warn"
        ? [styles.channelCardInner, styles.channelCardWarn]
        : styles.channelCardInner;
  return (
    <View style={styles.channelCard}>
      <View style={innerStyle}>
        <Text style={styles.channelCardLbl}>{label}</Text>
        <Text style={styles.channelCardVal}>{value}</Text>
        {sub ? <Text style={styles.channelCardSub}>{sub}</Text> : null}
        {confidence && (
          <View style={{ marginTop: 6 }}>
            <ConfidencePill level={confidence} />
          </View>
        )}
      </View>
    </View>
  );
}

function BulletList({ items }: { items: React.ReactNode[] }) {
  return (
    <View>
      {items.map((it, i) => (
        <View key={i} style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>{it}</Text>
        </View>
      ))}
    </View>
  );
}

function ResellerBar({
  row,
  maxShare,
  good,
}: {
  row: ResellerRow;
  maxShare: number;
  good?: boolean;
}) {
  const pct = row.share_pct ?? 0;
  const widthPct = Math.max(2, Math.round((pct / maxShare) * 100));
  const name = friendlySellerName(row.seller_name);
  return (
    <View style={styles.bar}>
      <Text style={styles.barRank}>{row.rank}.</Text>
      <Text style={styles.barName}>{name.slice(0, 30)}</Text>
      <View style={styles.barTrack}>
        <View
          style={good
            ? [styles.barFill, styles.barFillGood, { width: `${widthPct}%` }]
            : [styles.barFill, { width: `${widthPct}%` }]}
        />
      </View>
      <Text style={styles.barVal}>
        {row.share_pct != null ? `${Math.round(row.share_pct * 100)}%` : "—"}
      </Text>
      <Text style={styles.barAsins}>
        {row.asins_won != null ? `${row.asins_won} ASINs` : ""}
      </Text>
    </View>
  );
}

function BuyBoxPanel({
  derived,
  legacyPct,
}: {
  derived: DerivedSnapshot;
  legacyPct: number | null;
}) {
  const { brand_owned, authorized, amazon, reseller } = derived.shares;
  const fmt = (n: number) => `${Math.round(n * 100)}%`;
  const widthFor = (n: number) => Math.max(0, Math.min(100, n * 100));
  const total = brand_owned + authorized + amazon + reseller;
  const note = derived.shares.has_snapshot
    ? "Source: Keepa buy-box share split across your seller classifications."
    : legacyPct != null
      ? "Source: Keepa · brand-controlled share derived from seller-name overlap (legacy heuristic). Re-classify sellers for an exact 4-bucket split."
      : "Source: Keepa · share of buy-box wins on the audited ASINs.";
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={[styles.h3, { marginBottom: 6 }]}>
        Buy-box ownership over the last 90 days
      </Text>
      {total > 0 ? (
        <View style={styles.bbBar}>
          {brand_owned > 0 && (
            <View style={[styles.bbSeg, styles.bbSegBrand, { width: `${widthFor(brand_owned)}%` }]}>
              {brand_owned >= 0.08 && (
                <Text style={styles.bbSegLabel}>{fmt(brand_owned)} brand</Text>
              )}
            </View>
          )}
          {authorized > 0 && (
            <View style={[styles.bbSeg, styles.bbSegAuthorized, { width: `${widthFor(authorized)}%` }]}>
              {authorized >= 0.08 && (
                <Text style={styles.bbSegLabel}>{fmt(authorized)} auth.</Text>
              )}
            </View>
          )}
          {amazon > 0 && (
            <View style={[styles.bbSeg, styles.bbSegAmazon, { width: `${widthFor(amazon)}%` }]}>
              {amazon >= 0.08 && (
                <Text style={styles.bbSegLabel}>{fmt(amazon)} Amzn</Text>
              )}
            </View>
          )}
          {reseller > 0 && (
            <View style={[styles.bbSeg, styles.bbSegReseller, { width: `${widthFor(reseller)}%` }]}>
              {reseller >= 0.08 && (
                <Text style={styles.bbSegLabel}>{fmt(reseller)} reseller</Text>
              )}
            </View>
          )}
        </View>
      ) : (
        <View style={[styles.bbBar]}>
          <View style={[styles.bbSeg, styles.bbSegEmpty, { width: "100%" }]}>
            <Text style={[styles.bbSegLabel, { color: P.muted }]}>— not measured</Text>
          </View>
        </View>
      )}
      <View style={styles.bbLegendRow}>
        <View style={styles.bbLegendItem}>
          <View style={[styles.bbLegendSwatch, { backgroundColor: P.green }]} />
          <Text>Brand-owned {fmt(brand_owned)}</Text>
        </View>
        <View style={styles.bbLegendItem}>
          <View style={[styles.bbLegendSwatch, { backgroundColor: P.goldSoft }]} />
          <Text>Authorized {fmt(authorized)}</Text>
        </View>
        <View style={styles.bbLegendItem}>
          <View style={[styles.bbLegendSwatch, { backgroundColor: P.blueAmazon }]} />
          <Text>Amazon {fmt(amazon)}</Text>
        </View>
        <View style={styles.bbLegendItem}>
          <View style={[styles.bbLegendSwatch, { backgroundColor: P.red }]} />
          <Text>Reseller {fmt(reseller)}</Text>
        </View>
      </View>
      <Text style={styles.bbNote}>{note}</Text>
    </View>
  );
}

function SellerInitialBadge({ name }: { name: string }) {
  const initial = sellerInitial(name);
  return (
    <View style={styles.checklistRow}>
      <Text style={styles.initialBadge}>{initial}</Text>
      <Text style={[styles.body, { marginBottom: 0, fontSize: 10 }]}>{name}</Text>
    </View>
  );
}

// =====================================================================
// Hero copy renderers (mirror web.tsx)
// =====================================================================

function renderHeroHeadline(args: {
  brandName: string;
  revenue: number | null;
  brandControlledPct: number;
}): string {
  if (args.revenue != null) {
    return `${args.brandName} may already have a ${moneyFmt(args.revenue)} Amazon channel — but based on our audit, ${args.brandControlledPct}% of the buy box appears to be brand-controlled.`;
  }
  return `${args.brandName} appears to have a meaningful Amazon channel — but based on our audit, ${args.brandControlledPct}% of the buy box appears to be brand-controlled.`;
}

function renderHeroSubheadline(args: {
  brandName: string;
  auditScope: NarrativeV2["audit_scope"] | null;
  topReseller: string | null;
  topResellerSharePct: number | null;
}): string {
  const totalAsins = args.auditScope?.asins_found_total ?? null;
  const includedAsins = args.auditScope?.asins_included_count ?? null;
  const reseller = args.topReseller;
  const resellerShare =
    args.topResellerSharePct != null
      ? `${Math.round(args.topResellerSharePct * 100)}%`
      : null;
  if (totalAsins != null && includedAsins != null && reseller && resellerShare) {
    return `Our analysis found ${totalAsins.toLocaleString("en-US")} ASINs associated with ${args.brandName}, with ${includedAsins.toLocaleString("en-US")} included in this audit. Across those listings, third-party sellers appear to control the Amazon channel, including ${reseller}, which accounts for roughly ${resellerShare} of observed buy-box activity.`;
  }
  if (reseller && resellerShare) {
    return `Across the audited listings, third-party sellers appear to control the Amazon channel, including ${reseller}, which accounts for roughly ${resellerShare} of observed buy-box activity.`;
  }
  return `Across the audited listings, third-party sellers appear to be involved in the Amazon channel for ${args.brandName}.`;
}

function renderValueLine(args: {
  profit: number | null;
  value: number | null;
  ebitdaMultiple: string;
}): string {
  if (args.profit != null && args.value != null) {
    return `Based on conservative marketplace estimates, bringing this channel under brand control could create approximately ${moneyFmt(args.profit)} in annual profit recapture and up to ${moneyFmt(args.value)} in business value at a ${args.ebitdaMultiple}× EBITDA multiple.`;
  }
  return `Based on conservative marketplace estimates, bringing this channel under brand control could create meaningful annual profit recapture and business value — see the financial bridge below.`;
}

// =====================================================================
// Opportunity (long) layout pages
// =====================================================================

function HeroPage({
  narrative,
  brand,
  derived,
  revenue,
  profit,
  value,
  ebitdaMultiple,
  confRevenue,
  confSellerControl,
  confProfit,
  confValue,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
  derived: DerivedSnapshot;
  revenue: number | null;
  profit: number | null;
  value: number | null;
  ebitdaMultiple: string;
  confRevenue: ConfidenceLabel;
  confSellerControl: ConfidenceLabel;
  confProfit: ConfidenceLabel;
  confValue: ConfidenceLabel;
}) {
  const brandPct = Math.round(derived.non_reseller_share * 100);
  const headline = renderHeroHeadline({ brandName: brand.name, revenue, brandControlledPct: brandPct });
  const subheadline = renderHeroSubheadline({
    brandName: brand.name,
    auditScope: narrative.audit_scope ?? null,
    topReseller: pickTopReseller(narrative, derived),
    topResellerSharePct: pickTopResellerShare(narrative, derived),
  });
  const valueLine = renderValueLine({ profit, value, ebitdaMultiple });
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Amazon Channel Ownership Audit</Text>
      <View style={styles.goldRule} />
      <Text style={styles.smallInk}>Prepared for {brand.name}</Text>
      <Text style={styles.small}>
        {longDate(narrative.generated_at)} · By Rolle Consulting Group
      </Text>
      <Text style={[styles.h1, { marginTop: 16 }]}>{headline}</Text>
      <Text style={styles.prose}>{subheadline}</Text>
      <Text style={styles.heroValueLine}>{valueLine}</Text>

      <View style={styles.kpiRow}>
        <BigStat
          label="Estimated annual Amazon revenue"
          value={revenue != null ? moneyFmt(revenue) : "— not measured"}
          sub="Based on available marketplace data"
          confidence={confRevenue}
        />
        <BigStat
          label="Estimated annual profit recapture"
          value={profit != null ? moneyFmt(profit) : "— not measured"}
          sub="Directional estimate · transparent bridge below"
          confidence={confProfit}
        />
        <BigStat
          label={`Estimated business value lift (${ebitdaMultiple}× EBITDA)`}
          value={value != null ? moneyFmt(value) : "— not measured"}
          sub="Assumption-based · pressure-tested on a call"
          confidence={confValue}
        />
      </View>

      <View style={[styles.card, { marginTop: 8 }]}>
        <Text style={styles.channelCardLbl}>Brand-controlled buy box</Text>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4 }}>
          <Text style={[styles.kpiNum, { marginBottom: 0, marginRight: 10 }]}>{brandPct}%</Text>
          <ConfidencePill level={confSellerControl} />
        </View>
      </View>

      <PageFooter label="Hero" brandName={brand.name} />
    </Page>
  );
}

function ExecutiveSummaryPage({
  narrative,
  brand,
  derived,
  revenue,
  profit,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
  derived: DerivedSnapshot;
  revenue: number | null;
  profit: number | null;
}) {
  const scope = narrative.audit_scope ?? null;
  const brandPct = Math.round(derived.non_reseller_share * 100);
  const resellerPct = Math.round(derived.reseller_share * 100);
  const top = pickTopReseller(narrative, derived);
  const topShare = pickTopResellerShare(narrative, derived);
  const bullets: React.ReactNode[] = [];
  if (revenue != null) {
    bullets.push(
      <Text style={styles.bulletText}>
        Estimated Amazon revenue found: <Text style={styles.bold}>{moneyFmt(revenue)}</Text> per year
      </Text>,
    );
  }
  if (scope?.asins_included_count != null) {
    bullets.push(
      <Text style={styles.bulletText}>
        ASINs analyzed: <Text style={styles.bold}>{scope.asins_included_count.toLocaleString("en-US")}</Text>
        {scope.asins_found_total ? ` of ${scope.asins_found_total.toLocaleString("en-US")} found` : ""}
      </Text>,
    );
  }
  bullets.push(
    <Text style={styles.bulletText}>
      Brand-controlled buy box: <Text style={styles.bold}>{brandPct}%</Text>
    </Text>,
  );
  bullets.push(
    <Text style={styles.bulletText}>
      Third-party / reseller-controlled buy box: <Text style={styles.bold}>{resellerPct}%</Text>
    </Text>,
  );
  if (top && topShare != null) {
    bullets.push(
      <Text style={styles.bulletText}>
        Top reseller: <Text style={styles.bold}>{top}</Text> with approximately <Text style={styles.bold}>{Math.round(topShare * 100)}%</Text> observed buy-box share
      </Text>,
    );
  }
  if (profit != null) {
    bullets.push(
      <Text style={styles.bulletText}>
        Estimated annual profit recapture: <Text style={styles.bold}>{moneyFmt(profit)}</Text>
      </Text>,
    );
  }
  bullets.push(
    <Text style={styles.bulletText}>
      Primary issue: margin leakage + customer experience control
    </Text>,
  );
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead eyebrow="Executive Summary" title={`What we found for ${brand.name}`} />
      <View style={styles.card}>
        <BulletList items={bullets} />
        <Text style={[styles.proseCallout, { marginTop: 10 }]}>
          This is worth a 15-minute review if these sellers are not intentionally authorized to operate your Amazon channel.
        </Text>
      </View>
      <PageFooter label="Executive Summary" brandName={brand.name} />
    </Page>
  );
}

function ChannelControlPage({
  narrative,
  brand,
  bundle,
  derived,
  confSellerControl,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
  bundle: BrandEnrichmentBundle | null;
  derived: DerivedSnapshot;
  confSellerControl: ConfidenceLabel;
}) {
  const sellers = narrative.reseller_reality.top_sellers ?? [];
  const top = pickTopReseller(narrative, derived);
  const topShare = pickTopResellerShare(narrative, derived);
  const sellerCount = bundle?.keepa?.unique_seller_count ?? sellers.length ?? null;
  const asinsWithReseller = sellers
    .filter((s) => {
      const cls = lookupClassification(derived, s);
      return cls === "reseller" || (cls == null && s.is_brand_controlled === false);
    })
    .reduce((sum, s) => sum + (s.asins_won ?? 0), 0);
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead
        eyebrow="The Channel Control Problem"
        title="Your Amazon channel appears to be controlled by resellers"
      />
      <Text style={styles.prose}>
        Amazon may already be a meaningful channel for {brand.name}. The problem is that the channel does not appear to be operated by {brand.name} directly.
      </Text>
      <Text style={styles.proseCallout}>
        <Text style={styles.bold}>You may already have a meaningful Amazon business. The issue is that someone else appears to be operating it.</Text>
      </Text>

      <View style={styles.channelGrid}>
        <ChannelCard
          label="Brand-controlled buy box"
          value={`${Math.round(derived.non_reseller_share * 100)}%`}
          tone="good"
          confidence={confSellerControl}
        />
        <ChannelCard
          label="Reseller-controlled buy box"
          value={`${Math.round(derived.reseller_share * 100)}%`}
          tone="warn"
          confidence={confSellerControl}
        />
        <ChannelCard
          label="Top reseller"
          value={top ?? "— not measured"}
          sub={
            topShare != null
              ? `~${Math.round(topShare * 100)}% buy-box share`
              : null
          }
        />
        <ChannelCard
          label="Observed sellers"
          value={sellerCount != null ? String(sellerCount) : "— not measured"}
        />
        <ChannelCard
          label="ASINs with reseller activity"
          value={asinsWithReseller > 0 ? String(asinsWithReseller) : "— not measured"}
        />
        <ChannelCard
          label="Brand-owned Amazon presence"
          value={derived.shares.brand_owned > 0 ? "Yes" : "Unknown"}
          sub="Confirm with your team"
        />
      </View>

      <BuyBoxPanel
        derived={derived}
        legacyPct={bundle?.keepa?.brand_controlled_pct ?? null}
      />

      <PageFooter label="Channel Control" brandName={brand.name} />
    </Page>
  );
}

function CustomerExperiencePage({ brand }: { brand: BrandForReport }) {
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead
        eyebrow="The Customer Experience Problem"
        title="It's not just margin — it's brand control"
      />
      <Text style={styles.prose}>
        This is not just a reseller margin problem. It is a brand control problem. When third-party sellers control the channel, they influence pricing, packaging, availability, listing quality, customer expectations, and the buying experience. They may benefit from the demand your brand created without investing in the long-term health of the brand.
      </Text>
      <Text style={styles.prose}>
        Resellers can sell product. But they rarely represent the brand the way the brand owner would.
      </Text>
      <View style={styles.card}>
        <Text style={styles.h3}>Typical customer experience risks when resellers control the channel</Text>
        <BulletList
          items={[
            "Inconsistent pricing across listings",
            "Inconsistent packaging and product configurations",
            "Outdated or incomplete listings",
            "Poor images, weak content, and missing A+ pages",
            "Inventory inconsistency and stock-outs",
            "Customer confusion about which listing is “official”",
            "Bad reviews caused by the wrong seller experience",
            "Lack of long-term brand investment from third parties",
          ]}
        />
      </View>
      <Text style={styles.proseCallout}>
        {DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.customerExperience} That is what allowed the Amazon channel to scale — relevant for {brand.name} too. ({DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.pdfReferenceLabel}.)
      </Text>
      <PageFooter label="Customer Experience" brandName={brand.name} />
    </Page>
  );
}

function TopProductsPage({
  narrative,
  brand,
  maxCards,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
  maxCards: number;
}) {
  const cx = narrative.cx_audit;
  const sorted = cx.asin_scores
    .slice()
    .sort((a, b) => (b.ttm_revenue ?? -1) - (a.ttm_revenue ?? -1))
    .slice(0, maxCards);
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead
        eyebrow="Evidence Snapshot · Top Marketplace Signals"
        title="Where the demand sits — and what each listing looks like"
        source="Keepa /product · BSR + price · 365-day avg"
      />
      {sorted.length > 0 ? (
        <Text style={styles.proseCallout}>
          The top {sorted.length} ASINs ranked by estimated TTM revenue. Per-ASIN economics, listing health, and seller signals — full ASIN list lives in the methodology appendix.
        </Text>
      ) : (
        <Text style={styles.body}>Top product economics — not measured this run.</Text>
      )}
      {sorted.map((a) => (
        <AsinScoreRow key={a.asin} score={a} />
      ))}
      {cx.whats_broken.length > 0 && (
        <View style={[styles.card, { marginTop: 10 }]}>
          <Text style={styles.h3}>What&apos;s broken right now</Text>
          <BulletList items={cx.whats_broken.map((c, i) => <Text key={i} style={styles.bulletText}>{c}</Text>)} />
        </View>
      )}
      <Text style={[styles.small, { marginTop: 8 }]}>
        Per-ASIN revenue and units are directional estimates from Keepa BSR + buy-box price (365-day avg). Replace with seller&apos;s actual TTM during diligence.
      </Text>
      <PageFooter label="Top Products" brandName={brand.name} />
    </Page>
  );
}

function AsinScoreRow({ score }: { score: CxAuditAsinScore }) {
  const groupSize = score.variation_group_size ?? 1;
  const isVariation = groupSize >= 2;
  return (
    <View style={[styles.card, { marginVertical: 4 }]}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={[styles.bold, { color: P.gold, fontSize: 11, marginRight: 8 }]}>
          {score.asin}
        </Text>
        {isVariation && (
          <Text style={{ fontSize: 8, color: P.muted }}>
            Variation · 1 of {groupSize}
          </Text>
        )}
      </View>
      {score.title && (
        <Text style={[styles.body, { fontSize: 10, marginTop: 2, marginBottom: 4 }]}>
          {score.title.slice(0, 90)}
        </Text>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        <Text style={[styles.smallInk, { width: "33%", marginBottom: 2 }]}>
          <Text style={styles.small}>Revenue: </Text>
          {score.ttm_revenue != null ? `${moneyFmt(score.ttm_revenue)}/yr` : "— not measured"}
        </Text>
        <Text style={[styles.smallInk, { width: "33%", marginBottom: 2 }]}>
          <Text style={styles.small}>Units sold: </Text>
          {unitsFmt(score.monthly_units, score.ttm_units)}
        </Text>
        {score.buy_box_price != null && (
          <Text style={[styles.smallInk, { width: "33%", marginBottom: 2 }]}>
            <Text style={styles.small}>Buy-box price: </Text>
            ${score.buy_box_price.toFixed(2)}
          </Text>
        )}
        {score.score != null && (
          <Text style={[styles.smallInk, { width: "33%", marginBottom: 2 }]}>
            <Text style={styles.small}>Listing health: </Text>
            {score.score}/100
          </Text>
        )}
        {score.rating != null && (
          <Text style={[styles.smallInk, { width: "33%", marginBottom: 2 }]}>
            <Text style={styles.small}>Rating: </Text>
            {score.rating.toFixed(1)}
          </Text>
        )}
        {score.reviews != null && (
          <Text style={[styles.smallInk, { width: "33%", marginBottom: 2 }]}>
            <Text style={styles.small}>Reviews: </Text>
            {score.reviews.toLocaleString("en-US")}
          </Text>
        )}
      </View>
    </View>
  );
}

function ResellerRealityPage({
  narrative,
  brand,
  bundle,
  derived,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
  bundle: BrandEnrichmentBundle | null;
  derived: DerivedSnapshot;
}) {
  const r = narrative.reseller_reality;
  const sellers = r.top_sellers;
  const resellerRows: ResellerRow[] = [];
  const brandControlledRows: ResellerRow[] = [];
  for (const s of sellers) {
    const cls = lookupClassification(derived, s);
    if (cls === "reseller") {
      resellerRows.push(s);
    } else if (cls === "brand_owned" || cls === "authorized" || cls === "amazon") {
      brandControlledRows.push(s);
    } else if (cls == null) {
      if (s.is_brand_controlled === true) brandControlledRows.push(s);
      else resellerRows.push(s);
    }
  }
  const maxResellerShare =
    resellerRows.reduce((m, s) => Math.max(m, s.share_pct ?? 0), 0) || 1;
  const maxBrandShare =
    brandControlledRows.reduce((m, s) => Math.max(m, s.share_pct ?? 0), 0) || 1;
  const tone: "tight" | "strong" | "default" = derived.is_tight_channel
    ? "tight"
    : derived.is_strongly_controlled
      ? "strong"
      : "default";
  // Phase 47 — Module 3 hooks (PDF parity).
  const antiAmazonHook = pickHook(
    narrative.qualification,
    "anti_amazon_policy_violation",
    derived.is_tight_channel,
  );
  const dominantHook = pickHook(
    narrative.qualification,
    "dominant_single_reseller",
    derived.is_tight_channel,
  );
  const dominantSeller = dominantHook
    ? findResellerByName(dominantHook, sellers)
    : null;
  const dominantSellerSafe = dominantHook && dominantSeller ? dominantHook : null;
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead
        eyebrow="Reseller Reality"
        title="Who actually sells your brand on Amazon"
        source="Keepa · 90-day window · classification confirmed by you"
      />
      {antiAmazonHook && (
        <View style={styles.bannerWarn}>
          <Text>
            <Text style={styles.bold}>Your stated policy:</Text> {antiAmazonHook.hook_text}
          </Text>
          {antiAmazonHook.evidence ? (
            <Text style={[styles.small, { marginTop: 4 }]}>{antiAmazonHook.evidence}</Text>
          ) : null}
        </View>
      )}
      {dominantSellerSafe && dominantSeller && (
        <View style={styles.bannerWarn}>
          <Text>
            <Text style={styles.bold}>One reseller dominates the channel:</Text>{" "}
            {dominantSeller.seller_name}
            {dominantSeller.share_pct != null
              ? ` — ${Math.round(dominantSeller.share_pct * 100)}% of buy-box share.`
              : "."}
          </Text>
          <Text style={[styles.small, { marginTop: 4 }]}>{dominantSellerSafe.hook_text}</Text>
        </View>
      )}
      {sellers.length === 0 ? (
        <Text style={styles.body}>{r.note ?? "Reseller landscape — not measured this run."}</Text>
      ) : (
        <>
          {tone === "tight" && (
            <View style={styles.bannerGood}>
              <Text>
                <Text style={styles.bold}>Tight channel detected.</Text> Based on your classification, you appear to already control this channel. The estimated reseller leakage is small, and there may be limited recovery opportunity here. We&apos;d still want to confirm your authorization on the remaining sellers below.
              </Text>
            </View>
          )}
          {tone === "strong" && !derived.is_tight_channel && (
            <View style={styles.bannerWarn}>
              <Text>
                <Text style={styles.bold}>This channel may already be tightly controlled.</Text> Brand-controlled, authorized, and Amazon retail together appear to account for {Math.round(derived.non_reseller_share * 100)}% of buy-box activity — there may be limited recoverable revenue from reseller removal here. Worth pressure-testing on a short call.
              </Text>
            </View>
          )}

          {brandControlledRows.length > 0 && (
            <View style={[styles.card, { marginTop: 8 }]}>
              <Text style={styles.h3}>Sellers you&apos;ve identified as brand-controlled</Text>
              <Text style={[styles.small, { marginBottom: 8 }]}>
                These are the sellers you&apos;ve confirmed represent the brand. They appear in this section so the channel-control picture stays accurate.
              </Text>
              {brandControlledRows.map((s, i) => (
                <ResellerBar
                  key={`bc-${s.seller_name}-${i}`}
                  row={s}
                  maxShare={maxBrandShare}
                  good
                />
              ))}
            </View>
          )}

          {resellerRows.length > 0 ? (
            <View style={[styles.card, { marginTop: 8 }]}>
              <Text style={styles.h3}>Third-party sellers (authorization unknown)</Text>
              {resellerRows.map((s, i) => (
                <ResellerBar
                  key={`r-${s.seller_name}-${i}`}
                  row={s}
                  maxShare={maxResellerShare}
                />
              ))}
              {r.one_liner && <Text style={[styles.body, { marginTop: 6 }]}>{sanitizeForbidden(r.one_liner)}</Text>}
            </View>
          ) : (
            <Text style={styles.body}>
              No third-party reseller activity to investigate based on your classifications.
            </Text>
          )}

          <BuyBoxPanel
            derived={derived}
            legacyPct={bundle?.keepa?.brand_controlled_pct ?? null}
          />
        </>
      )}
      <PageFooter label="Reseller Reality" brandName={brand.name} />
    </Page>
  );
}

function ResellerDossierPage({
  narrative,
  brand,
  derived,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
  derived: DerivedSnapshot;
}) {
  const d = narrative.reseller_dossier;
  const dossierIsReseller = (() => {
    if (!d) return false;
    const synthetic: ResellerRow = {
      rank: 0,
      seller_name: d.seller_name,
      share_pct: d.share_pct ?? null,
      asins_won: d.asins_won ?? null,
      is_fba: d.is_fba ?? null,
      country: d.country ?? null,
    };
    const cls = lookupClassification(derived, synthetic);
    if (cls === "reseller") return true;
    if (cls == null) return true;
    return false;
  })();
  const filteredDossier = dossierIsReseller ? d : null;
  const friendly = filteredDossier ? friendlySellerName(filteredDossier.seller_name) : null;
  const resellerSellers = (narrative.reseller_reality.top_sellers ?? []).filter((s) => {
    const cls = lookupClassification(derived, s);
    if (cls === "reseller") return true;
    if (cls == null && s.is_brand_controlled === false) return true;
    return false;
  });
  // Phase 47 — Module 3 hook: geographic_diversion (PDF parity).
  const geoHook = pickHook(
    narrative.qualification,
    "geographic_diversion",
    derived.is_tight_channel,
  );
  const intlResellers = geoHook
    ? resellerSellers.filter((s) => {
        const c = (s.country ?? "").trim().toUpperCase();
        return c && c !== "US" && c !== "USA" && c !== "UNITED STATES";
      })
    : [];
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead
        eyebrow="Did You Authorize These Sellers?"
        title={filteredDossier ? `Inside ${friendly}` : "Reseller dossier"}
        source="Keepa · seller profile · filtered to your reseller classifications"
      />
      {geoHook && (
        <View style={styles.bannerWarn}>
          <Text>
            <Text style={styles.bold}>Geographic diversion:</Text> {geoHook.hook_text}
          </Text>
          {intlResellers.length > 0 && (
            <View style={{ marginTop: 4 }}>
              {intlResellers.slice(0, 6).map((s, i) => (
                <Text key={`geo-${i}`} style={styles.small}>
                  • {s.seller_name}
                  {s.country ? ` — ${s.country}` : ""}
                </Text>
              ))}
            </View>
          )}
          {geoHook.evidence ? (
            <Text style={[styles.small, { marginTop: 4 }]}>{geoHook.evidence}</Text>
          ) : null}
        </View>
      )}
      {filteredDossier ? (
        <>
          <View style={styles.factGrid}>
            <View style={styles.fact}>
              <Text style={styles.factLbl}>Seller name</Text>
              <Text style={styles.factVal}>{friendly ?? filteredDossier.seller_name}</Text>
            </View>
            <View style={styles.fact}>
              <Text style={styles.factLbl}>Marketplace ID</Text>
              <Text style={styles.factVal}>{filteredDossier.seller_id ?? "— not measured"}</Text>
            </View>
            <View style={styles.fact}>
              <Text style={styles.factLbl}>Country</Text>
              <Text style={styles.factVal}>{prettyCountry(filteredDossier.country) ?? "— not measured"}</Text>
            </View>
            <View style={styles.fact}>
              <Text style={styles.factLbl}>Buy-box share</Text>
              <Text style={styles.factVal}>{pctFmt(filteredDossier.share_pct)}</Text>
            </View>
            <View style={styles.fact}>
              <Text style={styles.factLbl}>ASINs won</Text>
              <Text style={styles.factVal}>{filteredDossier.asins_won != null ? String(filteredDossier.asins_won) : "— not measured"}</Text>
            </View>
            <View style={styles.fact}>
              <Text style={styles.factLbl}>Fulfilment</Text>
              <Text style={styles.factVal}>{filteredDossier.fulfilment_mix}</Text>
            </View>
            <View style={styles.fact}>
              <Text style={styles.factLbl}>Authorization status</Text>
              <Text style={styles.factVal}>Authorization unknown — confirm with your team</Text>
            </View>
          </View>
          {filteredDossier.top_asins.length > 0 && (
            <View style={[styles.card, { marginTop: 6 }]}>
              <Text style={styles.h3}>Top ASINs they win</Text>
              {filteredDossier.top_asins.map((a) => (
                <Text key={a.asin} style={[styles.body, { fontSize: 9, marginBottom: 2 }]}>
                  <Text style={[styles.bold, { color: P.gold }]}>{a.asin}</Text>{"  "}
                  {a.title ? a.title.slice(0, 80) : "— not measured"}
                  {a.buy_box_price != null ? `  ·  $${Number(a.buy_box_price).toFixed(2)}` : ""}
                </Text>
              ))}
            </View>
          )}
          {filteredDossier.risk_profile && (
            <View style={styles.proseCallout}>
              {paragraphs(sanitizeForbidden(filteredDossier.risk_profile)).map((p, i) => (
                <Text key={i} style={{ marginBottom: 4 }}>{p}</Text>
              ))}
            </View>
          )}
          {resellerSellers.length > 0 && (
            <View style={[styles.card, { marginTop: 8 }]}>
              <Text style={styles.h3}>Sellers to confirm authorization on</Text>
              {resellerSellers.slice(0, 8).map((s, i) => (
                <SellerInitialBadge key={`auth-${i}`} name={friendlySellerName(s.seller_name)} />
              ))}
              <Text style={[styles.small, { marginTop: 6 }]}>
                Authorization status should be confirmed with your team. We&apos;ll review which sellers are authorized, which relationships matter, and which accounts should be transitioned, restricted, or monitored.
              </Text>
            </View>
          )}
        </>
      ) : derived.is_tight_channel ? (
        <Text style={styles.body}>
          No third-party reseller activity to investigate based on your classifications. The channel appears tightly brand-controlled.
        </Text>
      ) : resellerSellers.length === 0 ? (
        <Text style={styles.body}>
          No third-party reseller activity to investigate based on your classifications.
        </Text>
      ) : (
        <>
          <Text style={styles.prose}>
            The dominant share is held by sellers you&apos;ve classified as brand-controlled. Below are the third-party sellers we&apos;d still recommend confirming authorization on:
          </Text>
          <View style={styles.card}>
            {resellerSellers.slice(0, 8).map((s, i) => (
              <SellerInitialBadge key={`auth2-${i}`} name={friendlySellerName(s.seller_name)} />
            ))}
            <Text style={[styles.small, { marginTop: 6 }]}>
              Authorization status should be confirmed with your team.
            </Text>
          </View>
        </>
      )}
      <PageFooter label="Reseller Dossier" brandName={brand.name} />
    </Page>
  );
}

function FinancialBridgePage({
  narrative,
  brand,
  derived,
  revenue,
  out,
  assumptions,
  revenueBadge,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
  derived: DerivedSnapshot;
  revenue: number | null;
  out: LegionOutputs;
  assumptions: ReportAssumptions;
  revenueBadge: "actual" | "estimate" | "confirmed" | null;
}) {
  const haveRev = revenue != null && revenue > 0;
  const brandControlledPct = derived.shares.has_snapshot
    ? derived.non_reseller_share
    : narrative.brand_controlled_pct ?? null;
  const recoverableShare =
    brandControlledPct != null
      ? Math.max(0, Math.min(1, 1 - brandControlledPct))
      : 1;
  const revConf: ConfidenceLabel =
    revenueBadge === "confirmed" || revenueBadge === "actual" ? "High" : "Medium";
  const profitConf: ConfidenceLabel =
    revenueBadge === "confirmed" || revenueBadge === "actual" ? "High" : "Medium";
  const cleanedNotes = cleanMathNotes(narrative.math.notes ?? "");

  type BridgeRowDef = {
    label: string;
    value: string;
    note: string;
    conf: ConfidenceLabel;
    total?: boolean;
  };
  const rows: BridgeRowDef[] = [
    {
      label: "TTM Amazon revenue",
      value: haveRev ? moneyFmt(revenue!) : "— not measured",
      note:
        revenueBadge === "confirmed"
          ? "Confirmed by user"
          : revenueBadge === "actual"
            ? "From your records"
            : "Keepa-based estimate",
      conf: revConf,
    },
    {
      label: "× Recoverable share of buy-box",
      value: pctFmt(recoverableShare, 1),
      note:
        brandControlledPct != null && brandControlledPct > 0
          ? `1 − brand-owned / authorized / Amazon (${pctFmt(brandControlledPct, 1)})`
          : "1 − brand-owned − authorized − Amazon",
      conf: "High",
    },
    {
      label: "× Reseller net margin",
      value: pctFmt(assumptions.reseller_net_margin_pct, 1),
      note: "Net of Amazon fees, FBA, ads, returns, inbound shipping",
      conf: "Medium",
    },
    {
      label: "= Estimated annual profit recapture",
      value: haveRev ? moneyFmt(out.delta_profit) : "— not measured",
      note: "Δ profit per year — incremental EBITDA on the recoverable slice",
      conf: profitConf,
      total: true,
    },
    {
      label: `× ${assumptions.ebitda_multiple}× EBITDA multiple`,
      value: `${assumptions.ebitda_multiple}×`,
      note: "Lower-mid market private-business comparable; pressure-test on a call",
      conf: "Assumption-based",
    },
    {
      label: "= Estimated business value lift",
      value: haveRev ? moneyFmt(out.exit_lift) : "— not measured",
      note: "Multiple applied to incremental EBITDA",
      conf: "Assumption-based",
      total: true,
    },
  ];
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead
        eyebrow="Estimated Financial Opportunity"
        title="What the channel could be worth under brand control"
        source="Directional estimates · transparent line-by-line bridge"
      />
      <Text style={styles.prose}>
        These numbers are directional estimates designed to show whether the opportunity is large enough to justify deeper diligence. Each line in the bridge is shown with its source.
      </Text>

      <View style={styles.table}>
        <View style={[styles.tableRow, { backgroundColor: "#EFEBDF" }]}>
          <Text style={[styles.tableCell, styles.tableHead, { flex: 3 }]}>Line</Text>
          <Text style={[styles.tableCell, styles.tableHead, { flex: 1.2, textAlign: "right" }]}>Value</Text>
          <Text style={[styles.tableCell, styles.tableHead, { flex: 3 }]}>Source / Note</Text>
          <Text style={[styles.tableCell, styles.tableHead, { flex: 1.2, textAlign: "right" }]}>Confidence</Text>
        </View>
        {rows.map((r, i) => (
          <View
            key={i}
            style={r.total ? [styles.bridgeRow, styles.bridgeRowTotal] : [styles.bridgeRow]}
          >
            <Text style={styles.bridgeColLabel}>{r.label}</Text>
            <Text style={styles.bridgeColValue}>{r.value}</Text>
            <Text style={styles.bridgeColNote}>{r.note}</Text>
            <View style={styles.bridgeColConf}>
              <ConfidencePill level={r.conf} />
            </View>
          </View>
        ))}
      </View>

      <View style={[styles.card, { marginTop: 10 }]}>
        <Text style={styles.h3}>Assumptions</Text>
        <BulletList
          items={[
            <Text style={styles.bulletText} key="markup">
              Reseller markup: <Text style={styles.bold}>{pctFmt(assumptions.reseller_markup_pct, 0)}</Text>
            </Text>,
            <Text style={styles.bulletText} key="ship">
              Outbound shipping: <Text style={styles.bold}>{pctFmt(assumptions.outbound_shipping_pct, 1)}</Text>
              {" — "}
              brand pays: {assumptions.outbound_shipping_payer}
            </Text>,
            <Text style={styles.bulletText} key="netm">
              Reseller net margin: <Text style={styles.bold}>{pctFmt(assumptions.reseller_net_margin_pct, 1)}</Text>{" "}
              (post-Amazon fees, FBA, ads, returns, inbound)
            </Text>,
            <Text style={styles.bulletText} key="curm">
              Current manufacturer margin: <Text style={styles.bold}>{pctFmt(assumptions.current_profit_margin_pct, 1)}</Text>
            </Text>,
            <Text style={styles.bulletText} key="ebit">
              EBITDA multiple: <Text style={styles.bold}>{assumptions.ebitda_multiple}×</Text>
            </Text>,
            <Text style={styles.bulletText} key="lab">
              Labor / tools: <Text style={styles.bold}>{moneyFmt(out.labor_cost)}</Text>{" "}
              ({out.labor_tier.replace(/_/g, " ")})
            </Text>,
          ]}
        />
      </View>

      {cleanedNotes && <Text style={[styles.proseCallout]}>{sanitizeForbidden(cleanedNotes)}</Text>}

      <PageFooter label="Financial Opportunity" brandName={brand.name} />
    </Page>
  );
}

function SafeTransitionPage({ brand }: { brand: BrandForReport }) {
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead
        eyebrow="The Safe Path to Taking Control"
        title="How we reclaim the channel without blowing up wholesale"
      />
      <Text style={styles.prose}>
        The biggest objection to bringing Amazon under brand control is fear of disrupting wholesale relationships. The process below is strategic, careful, and respectful of the relationships that matter.
      </Text>
      <Text style={styles.proseCallout}>
        <Text style={styles.bold}>The goal is not to create a reseller war. The goal is to bring the Amazon customer experience under brand control in a way that protects the business.</Text>
      </Text>
      <View style={styles.card}>
        <BulletList
          items={[
            "Identify authorized vs. authorization-unknown sellers",
            "Review distributor and reseller terms",
            "Map which relationships matter to the broader business",
            "Create sell-through windows where needed",
            "Update future Amazon resale restrictions",
            "Prepare inventory before transitioning listings",
            "Avoid customer availability gaps",
            "Maintain important wholesale relationships where possible",
            "Transition Amazon toward brand-owned control over 6–12 months",
            "Monitor listings after transition",
          ]}
        />
      </View>
      <Text style={styles.small}>
        We&apos;ll confirm which sellers are authorized, which relationships matter, and which accounts should be transitioned, restricted, or monitored.
      </Text>
      <PageFooter label="Safe Transition" brandName={brand.name} />
    </Page>
  );
}

function FrameworkPage({
  narrative,
  brand,
  derived,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
  derived: DerivedSnapshot;
}) {
  const p = narrative.plan;
  const steps = p.steps && p.steps.length === 5 ? p.steps : null;

  // Phase 46 — same render-time defense the web renderer uses. Compute
  // brand-controlled vs reseller buckets from the persisted snapshot
  // and (a) swap Step 4 for the empty-resellers reference body when no
  // reseller exists, (b) scrub any legacy narrative_json that names a
  // brand-controlled seller in a reseller context.
  const sellers = narrative.reseller_reality.top_sellers ?? [];
  const brandControlledNames = new Set<string>();
  let resellerCount = 0;
  for (const s of sellers) {
    const cls = lookupClassification(derived, s);
    if (cls === "reseller" || (cls == null && s.is_brand_controlled === false)) {
      resellerCount += 1;
    } else if (cls === "brand_owned" || cls === "authorized" || cls === "amazon") {
      const n = (s.seller_name ?? "").trim();
      if (n) brandControlledNames.add(n);
    } else if (cls == null && s.is_brand_controlled === true) {
      const n = (s.seller_name ?? "").trim();
      if (n) brandControlledNames.add(n);
    }
  }
  const hasResellers = resellerCount > 0;
  const scrubBrandOwnedNaming = makePlanCopySanitizerPdf(brandControlledNames);
  const introText = sanitizeForbidden(scrubBrandOwnedNaming(p.intro ?? ""));
  // Phase 47 — Module 3 hook: trademark_split (PDF parity).
  const trademarkHook = pickHook(
    narrative.qualification,
    "trademark_split",
    derived.is_tight_channel,
  );

  if (!hasResellers && steps) {
    return (
      <Page size="LETTER" style={styles.page}>
        <SectionHead
          eyebrow="6–12 Month Capture Plan"
          title="The Five-Step Framework"
        />
        <Text style={styles.prose}>
          Based on your classifications, the channel is already brand-controlled — there are no third-party resellers to transition off your listings today. The framework below is offered as a reference for protecting that position long-term.
        </Text>
        <View>
          {steps.map((s, i) => {
            const body =
              s.number === 4
                ? emptyResellerStep4BodyPdf()
                : sanitizeForbidden(scrubBrandOwnedNaming(s.body));
            return (
              <View key={s.number} style={[styles.card, { marginVertical: 4 }]}>
                <Text style={styles.stepNum}>Step {s.number}</Text>
                <Text style={styles.stepTitle}>{s.title}</Text>
                <Text style={styles.stepBody}>{body}</Text>
                {i === 3 && (
                  <View style={[styles.bannerWarn, { marginTop: 8, marginBottom: 0 }]}>
                    <Text style={styles.eyebrow}>Case study</Text>
                    <Text style={{ fontSize: 9, color: P.ink, lineHeight: 1.5 }}>
                      {DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.frameworkStep4} ({DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.pdfReferenceLabel}.)
                    </Text>
                  </View>
                )}
                {i === 4 && (
                  <View style={[styles.bannerWarn, { marginTop: 8, marginBottom: 0 }]}>
                    <Text style={styles.eyebrow}>Team model</Text>
                    <Text style={{ fontSize: 9, color: P.ink, lineHeight: 1.5 }}>
                      {DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.frameworkStep5} ({DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.pdfReferenceLabel}.)
                    </Text>
                  </View>
                )}
              </View>
            );
          })}
        </View>
        {p.closing && <Text style={[styles.prose, { marginTop: 12 }]}>{sanitizeForbidden(p.closing)}</Text>}
        <PageFooter label="Five-Step Framework" brandName={brand.name} />
      </Page>
    );
  }

  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead
        eyebrow="6–12 Month Capture Plan"
        title="The Five-Step Framework"
      />
      {introText && <Text style={styles.prose}>{introText}</Text>}
      {trademarkHook && (
        <View style={styles.bannerWarn}>
          <Text>
            <Text style={styles.bold}>Brand Registry enforcement complexity:</Text>{" "}
            {trademarkHook.hook_text}
          </Text>
          {trademarkHook.evidence ? (
            <Text style={[styles.small, { marginTop: 4 }]}>{trademarkHook.evidence}</Text>
          ) : null}
        </View>
      )}
      {steps ? (
        <View>
          {steps.map((s, i) => (
            <View key={s.number} style={[styles.card, { marginVertical: 4 }]}>
              <Text style={styles.stepNum}>Step {s.number}</Text>
              <Text style={styles.stepTitle}>{s.title}</Text>
              <Text style={styles.stepBody}>{sanitizeForbidden(scrubBrandOwnedNaming(s.body))}</Text>
              {i === 3 && (
                <View style={[styles.bannerWarn, { marginTop: 8, marginBottom: 0 }]}>
                  <Text style={styles.eyebrow}>Case study</Text>
                  <Text style={{ fontSize: 9, color: P.ink, lineHeight: 1.5 }}>
                    {DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.frameworkStep4} ({DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.pdfReferenceLabel}.)
                  </Text>
                </View>
              )}
              {i === 4 && (
                <View style={[styles.bannerWarn, { marginTop: 8, marginBottom: 0 }]}>
                  <Text style={styles.eyebrow}>Team model</Text>
                  <Text style={{ fontSize: 9, color: P.ink, lineHeight: 1.5 }}>
                    {DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.frameworkStep5} ({DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.pdfReferenceLabel}.)
                  </Text>
                </View>
              )}
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.stepRow}>
          {p.columns.map((col, i) => (
            <View key={i} style={styles.stepCard}>
              <View style={styles.stepCardInner}>
                <Text style={styles.stepNum}>{col.label}</Text>
                {col.bullets.map((b, j) => (
                  <Text key={j} style={[styles.stepBody, { marginTop: 4 }]}>• {scrubBrandOwnedNaming(b)}</Text>
                ))}
              </View>
            </View>
          ))}
        </View>
      )}
      {p.closing && <Text style={[styles.prose, { marginTop: 12 }]}>{sanitizeForbidden(p.closing)}</Text>}
      <PageFooter label="Five-Step Framework" brandName={brand.name} />
    </Page>
  );
}

function emptyResellerStep4BodyPdf(): string {
  return "Based on your classifications, the channel is already brand-controlled — there are no third-party resellers to transition off your listings today. The framework continues to apply as a protection plan: written distribution terms, MAP enforcement, and a monitored authorized-seller list keep new resellers from showing up six months from now.";
}

function makePlanCopySanitizerPdf(
  brandControlledNames: Set<string>,
): (input: string) => string {
  if (!brandControlledNames || brandControlledNames.size === 0) {
    return (s) => s ?? "";
  }
  const names = Array.from(brandControlledNames)
    .map((n) => n.trim())
    .filter((n) => n.length >= 3)
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return (s) => s ?? "";
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const constructPatterns = names.map(
    (n) =>
      new RegExp(
        `\\bresellers?\\s+(?:like|such as)\\s+${escape(n)}\\b(?:\\s*\\([^)]*\\))?`,
        "gi",
      ),
  );
  const barePatterns = names.map(
    (n) => new RegExp(`\\b${escape(n)}\\b(?:\\s*\\([^)]*\\d+%[^)]*\\))?`, "gi"),
  );
  return (input: string) => {
    if (!input) return input ?? "";
    let out = input;
    for (const re of constructPatterns) out = out.replace(re, "third-party resellers");
    for (const re of barePatterns) out = out.replace(re, "an authorized brand-controlled seller");
    return out;
  };
}

// =====================================================================
// Phase 44 — Diversified Hospitality case study (opportunity-only)
// Renders as a normal lower section. PDF has no collapsibles, so the
// full text always renders. Page uses `wrap` so long content breaks
// cleanly across pages with the standard footer on every page.
// =====================================================================

function CaseStudyDiversifiedHospitalityPage({
  brand,
}: {
  brand: BrandForReport;
}) {
  const cs = DIVERSIFIED_HOSPITALITY_CASE_STUDY;
  return (
    <Page size="LETTER" style={styles.page} wrap>
      <SectionHead
        eyebrow="Case Study"
        title="How Diversified Hospitality turned Amazon from a reseller-controlled channel into a $10M brand-owned revenue stream"
      />
      <Text style={[styles.prose, { fontStyle: "italic", color: P.muted }]}>
        Why we share this: when a brand owner takes Amazon back from
        resellers, the unlock is not just margin recapture — it is the
        ability to invest in listings, packaging, customer experience,
        and long-term channel strategy in a way resellers never will.
        That same shift is the opportunity in front of {brand.name}.
      </Text>
      <Text style={[styles.prose, { fontFamily: "Helvetica-Oblique" }]}>
        {cs.preface}
      </Text>

      <Text style={[styles.h3, { marginTop: 10 }]}>The Situation</Text>
      {cs.sections.situation.paragraphs?.map((p, i) => (
        <Text key={`s-p-${i}`} style={styles.prose}>
          {p}
        </Text>
      ))}
      {cs.sections.situation.bullets && (
        <BulletList items={cs.sections.situation.bullets} />
      )}
      {cs.sections.situation.tail?.map((p, i) => (
        <Text key={`s-t-${i}`} style={[styles.prose, { marginTop: 6 }]}>
          {p}
        </Text>
      ))}

      <Text style={[styles.h3, { marginTop: 10 }]}>The Decision</Text>
      {cs.sections.decision.paragraphs?.map((p, i) => (
        <Text key={`d-p-${i}`} style={styles.prose}>
          {p}
        </Text>
      ))}
      {cs.sections.decision.bullets && (
        <BulletList items={cs.sections.decision.bullets} />
      )}

      <Text style={[styles.h3, { marginTop: 10 }]}>The Execution</Text>
      <Text style={styles.prose}>{cs.sections.execution.lead}</Text>
      {cs.sections.execution.steps.map((step, i) => (
        <View key={`e-${i}`} style={{ marginBottom: 6 }} wrap={false}>
          <Text style={[styles.prose, { fontFamily: "Helvetica-Bold", marginBottom: 2 }]}>
            {i + 1}. {step.title}
          </Text>
          <Text style={[styles.prose, { marginBottom: 6 }]}>{step.body}</Text>
        </View>
      ))}

      <Text style={[styles.h3, { marginTop: 10 }]}>The Results</Text>
      {cs.sections.results.paragraphs?.map((p, i) => (
        <Text key={`r-p-${i}`} style={styles.prose}>
          {p}
        </Text>
      ))}
      {cs.sections.results.bullets && (
        <BulletList items={cs.sections.results.bullets} />
      )}
      {cs.sections.results.tail?.map((p, i) => (
        <Text key={`r-t-${i}`} style={[styles.prose, { marginTop: 6 }]}>
          {p}
        </Text>
      ))}
      <BulletList
        items={[
          "Amazon became a major profit center",
          "Customer experience became more consistent",
          "Cash flow improved significantly because Amazon paid faster than reseller terms",
          "Diversified paid down more than $5 million in accounts payable across 2022 and 2023",
          "The increased profitability materially improved the value of the business",
        ]}
      />

      <Text style={[styles.h3, { marginTop: 10 }]}>The Lesson</Text>
      {cs.sections.lesson.paragraphs?.map((p, i) => (
        <Text key={`l-p-${i}`} style={styles.prose}>
          {p}
        </Text>
      ))}
      {cs.sections.lesson.bullets && (
        <BulletList items={cs.sections.lesson.bullets} />
      )}
      {cs.sections.lesson.tail?.map((p, i) => (
        <Text key={`l-t-${i}`} style={[styles.prose, { marginTop: 6 }]}>
          {p}
        </Text>
      ))}

      <Text style={[styles.h3, { marginTop: 10 }]}>
        Why This Matters for Your Brand
      </Text>
      {cs.sections.whyThisMatters.paragraphs?.map((p, i) => (
        <Text key={`w-p-${i}`} style={styles.prose}>
          {p}
        </Text>
      ))}

      <View
        style={{
          marginTop: 14,
          paddingTop: 8,
          borderTopWidth: 1,
          borderTopColor: P.rule,
          borderStyle: "dashed",
        }}
      >
        <Text style={styles.small}>{cs.footnote}</Text>
      </View>

      <PageFooter label="Case Study · Diversified Hospitality" brandName={brand.name} />
    </Page>
  );
}

function WhySteveRollePage({ brand }: { brand: BrandForReport }) {
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead
        eyebrow="Why Steve Rolle / RMG"
        title="Operator-led, not agency"
      />
      <Text style={styles.prose}>
        {DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.whySteveBio} ({DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.pdfReferenceLabel}.)
      </Text>
      <Text style={styles.prose}>
        More recently, Steve helped <Text style={styles.bold}>Legion Chemicals</Text> grow from $0 to roughly a <Text style={styles.bold}>$1M ARR</Text> Amazon run rate in less than 10 months.
      </Text>
      <Text style={styles.prose}>
        We&apos;ve handled this process across reseller-fragmented catalogs and understand how to sequence the transition without disrupting core wholesale relationships.
      </Text>
      <Text style={styles.proseCallout}>
        The lesson was simple: when the brand owner controls the marketplace, the brand can invest in the channel in a way resellers never will.
      </Text>
      <View style={styles.card}>
        <BulletList
          items={[
            "Operator, not agency",
            "Brand owner, not theorist",
            "Channel strategist, not Amazon tactician",
            "Profit recovery, not ad management",
            "Safe transition, not reseller war",
          ]}
        />
      </View>
      <Text style={styles.small}>
        Engagements are structured around the size of the opportunity. In many cases, we combine a fixed implementation fee with performance-based upside tied to incremental profit. If the opportunity is not large enough to justify our involvement, we&apos;ll tell you.
      </Text>
      <PageFooter label="Why Steve / RMG" brandName={brand.name} />
    </Page>
  );
}

function CtaPage({
  narrative,
  brand,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
}) {
  const c = narrative.cta;
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Recommended Next Step</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>
        Schedule a 15-minute Amazon Channel Ownership Review with Steve.
      </Text>
      <Text style={styles.prose}>
        If these sellers are intentionally authorized to operate {brand.name}&apos;s Amazon channel, this may simply be a useful benchmark. If they are not, this could be a meaningful profit recapture and brand-control opportunity.
      </Text>
      <Text style={styles.prose}>
        On the call, we&apos;ll walk through the numbers, confirm which sellers are authorized, pressure-test the assumptions, and determine whether this is worth pursuing.
      </Text>
      <Text style={[styles.prose, { color: P.muted }]}>
        No pressure. The goal is to confirm whether the opportunity is real, whether the assumptions are fair, and whether taking control is worth exploring.
      </Text>

      <View style={[styles.card, { marginTop: 14 }]}>
        {c.primary_cta_url && (
          <Text style={[styles.body, { color: P.gold }]}>
            {c.primary_cta_label} → {c.primary_cta_url}
          </Text>
        )}
        <Text style={[styles.body, { color: P.gold, marginTop: 4 }]}>{c.secondary_email}</Text>
        {c.secondary_phone && <Text style={styles.small}>{c.secondary_phone}</Text>}
      </View>

      <PageFooter label="Recommended Next Step" brandName={brand.name} />
    </Page>
  );
}

function MethodologyPage({
  narrative,
  brand,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
}) {
  const scope = narrative.audit_scope ?? null;
  const keepaFresh = narrative.data_sources?.keepa_freshness ?? null;
  const dfsFresh = narrative.data_sources?.dataforseo_freshness ?? null;
  const auditWindow = `Trailing 12 months · ${longDate(keepaFresh)}`;
  const asinsFound = scope?.asins_found_total ?? null;
  const asinsIncluded = scope?.asins_included_count ?? null;
  const withBadge = scope?.asins_with_keepa_monthly_sold ?? 0;
  const exclusions = scope?.exclusion_breakdown ?? {
    rank_too_high: 0,
    out_of_stock: 0,
    no_buy_box_history: 0,
    variation_inactive_sibling: 0,
  };
  const exclusionBullets: React.ReactNode[] = [];
  if (exclusions.rank_too_high > 0) {
    exclusionBullets.push(
      <Text style={styles.bulletText}>
        <Text style={styles.bold}>Rank ceiling: </Text>
        {exclusions.rank_too_high} ASINs ranked above 500,000 in their category were excluded as low-velocity.
      </Text>,
    );
  }
  if (exclusions.out_of_stock > 0) {
    exclusionBullets.push(
      <Text style={styles.bulletText}>
        <Text style={styles.bold}>Out of stock: </Text>
        {exclusions.out_of_stock} ASINs flagged as out of stock by Amazon were excluded.
      </Text>,
    );
  }
  if (exclusions.no_buy_box_history > 0) {
    exclusionBullets.push(
      <Text style={styles.bulletText}>
        <Text style={styles.bold}>No buy-box history: </Text>
        {exclusions.no_buy_box_history} ASINs with no recorded buy-box winner in the trailing 90 days are kept in the catalog count but contribute zero attributed sales.
      </Text>,
    );
  }
  if (exclusions.variation_inactive_sibling > 0) {
    exclusionBullets.push(
      <Text style={styles.bulletText}>
        <Text style={styles.bold}>Variation siblings: </Text>
        {exclusions.variation_inactive_sibling} bulk-pack or parent-shell ASINs that share rank with an active sibling and have no independent buy-box wins receive zero attributed units to avoid double-counting.
      </Text>,
    );
  }
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead eyebrow="Audit Scope" title="Methodology & Audit Scope" />
      <View style={styles.kpiRow}>
        <View style={styles.kpi}>
          <Text style={[styles.kpiNum, { fontSize: 12 }]}>{brand.name}</Text>
          <Text style={styles.kpiLbl}>Brand</Text>
        </View>
        <View style={styles.kpi}>
          <Text style={styles.kpiNum}>
            {asinsFound != null ? asinsFound.toLocaleString("en-US") : "— not measured"}
          </Text>
          <Text style={styles.kpiLbl}>ASINs found on Amazon</Text>
        </View>
        <View style={styles.kpi}>
          <Text style={styles.kpiNum}>
            {asinsIncluded != null ? asinsIncluded.toLocaleString("en-US") : "— not measured"}
          </Text>
          <Text style={styles.kpiLbl}>ASINs included in this audit</Text>
        </View>
        <View style={styles.kpi}>
          <Text style={[styles.kpiNum, { fontSize: 11 }]}>{auditWindow}</Text>
          <Text style={styles.kpiLbl}>Audit window</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.h3}>Why these ASINs are included</Text>
        {exclusionBullets.length > 0 ? (
          <BulletList items={exclusionBullets} />
        ) : (
          <Text style={styles.body}>
            All ASINs Keepa returned for this brand had measurable sales activity in the trailing 90 days, so no listings were excluded from the catalog count.
          </Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.h3}>How we estimate units sold</Text>
        <BulletList
          items={[
            <Text style={styles.bulletText} key="bd">
              <Text style={styles.bold}>Primary source — Amazon&apos;s published purchase badge.</Text>{" "}
              When Amazon shows a &ldquo;100+ bought in past month&rdquo; or similar badge on the listing, we capture that value via Keepa&apos;s monthlySold field.{" "}
              <Text style={styles.bold}>{withBadge} of {asinsIncluded ?? 0} included ASINs have a published badge.</Text>
            </Text>,
            <Text style={styles.bulletText} key="bs">
              <Text style={styles.bold}>Fallback — BSR curve.</Text>{" "}
              For ASINs without a published badge, we estimate monthly units from the ASIN&apos;s category sales rank using a published-research BSR-to-units curve.
            </Text>,
            <Text style={styles.bulletText} key="va">
              <Text style={styles.bold}>Variation attribution.</Text>{" "}
              When sibling ASINs share a parent listing&apos;s sales rank, we split the parent&apos;s units across siblings using recent review activity (last 90 days) plus buy-box win frequency. Inactive siblings (pallets, dormant variations) receive zero.
            </Text>,
            <Text style={styles.bulletText} key="rf">
              <Text style={styles.bold}>Revenue formula.</Text>{" "}
              attributed monthly units × current buy-box price × 12 = trailing 12-month revenue estimate, summed across every included ASIN.
            </Text>,
          ]}
        />
      </View>

      <View style={styles.proseCallout}>
        <Text style={styles.h3}>About the &ldquo;100+ bought&rdquo; badge.</Text>
        <Text style={{ fontSize: 10, lineHeight: 1.5, color: P.ink }}>
          Amazon publishes monthly purchase badges in tiers (&ldquo;50+ bought&rdquo;, &ldquo;100+ bought&rdquo;, &ldquo;1,000+ bought&rdquo;). When we see &ldquo;100+ bought,&rdquo; our model records exactly <Text style={styles.bold}>100</Text> units — even though the true number could be 101, 199, or anything up to the next tier. <Text style={styles.bold}>We are deliberately conservative.</Text> A brand with many &ldquo;100+&rdquo; or &ldquo;1,000+&rdquo; badged ASINs may have meaningfully higher actual TTM revenue than this report shows. Replace these estimates with the seller&apos;s actual TTM during diligence.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.h3}>What this report does not do</Text>
        <BulletList
          items={[
            <Text style={styles.bulletText} key="s">
              This report does not adjust for <Text style={styles.bold}>seasonality</Text> — trailing 12-month revenue is treated as flat across the year.
            </Text>,
            <Text style={styles.bulletText} key="n">
              This report does not include <Text style={styles.bold}>non-Amazon channels</Text> (Walmart, Shopify, wholesale, retail).
            </Text>,
            <Text style={styles.bulletText} key="b">
              This report does not detect <Text style={styles.bold}>brand-name collisions</Text> — if a brand catalog umbrellas multiple sub-brands or a hijacked listing, those ASINs may still appear as included.
            </Text>,
            <Text style={styles.bulletText} key="d">
              This report does not include <Text style={styles.bold}>direct sales reporting</Text> — every per-ASIN unit number is a model estimate.
            </Text>,
          ]}
        />
      </View>

      <Text style={[styles.small, { marginTop: 8 }]}>
        Keepa snapshot · {longDate(keepaFresh)}  ·  DataForSEO snapshot · {longDate(dfsFresh)}  ·  Buy-box history window · 90 days
      </Text>

      <PageFooter label="Methodology Appendix" brandName={brand.name} />
    </Page>
  );
}

function DisclaimerPage({ brand }: { brand: BrandForReport }) {
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead eyebrow="Disclaimer" title="How to read this report" />
      <Text style={styles.prose}>
        Marketplace data is useful for identifying directional opportunity, but final economics require confirmation of COGS, wholesale pricing, authorized seller relationships, fulfillment costs, and current channel agreements.
      </Text>
      <Text style={styles.prose}>
        All revenue, profit, and margin estimates are directional and based on available marketplace data, third-party tools, and reasonable assumptions. Actual results depend on costs, pricing, inventory, reseller agreements, fulfillment method, Amazon fees, and execution.
      </Text>
      <PageFooter label="Disclaimer" brandName={brand.name} />
    </Page>
  );
}

// =====================================================================
// Tight (short benchmark) layout pages
// =====================================================================

function TightHeroPage({
  narrative,
  brand,
  derived,
  revenue,
  benchmark,
  ebitdaMultiple,
  currentMarginPct,
  confRevenue,
  confSellerControl,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
  derived: DerivedSnapshot;
  revenue: number | null;
  benchmark: { current_profit_annual: number; business_value: number } | null;
  ebitdaMultiple: number;
  currentMarginPct: number;
  confRevenue: ConfidenceLabel;
  confSellerControl: ConfidenceLabel;
}) {
  const brandPct = Math.round(derived.non_reseller_share * 100);
  const headline =
    revenue != null
      ? `${brand.name} runs an estimated ${moneyFmt(revenue)} Amazon channel — and based on your classifications, you control roughly ${brandPct}% of the buy box already.`
      : `${brand.name}, based on your classifications you already control roughly ${brandPct}% of your Amazon buy box.`;
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Channel Ownership Benchmark</Text>
      <View style={styles.goldRule} />
      <Text style={styles.smallInk}>Prepared for {brand.name}</Text>
      <Text style={styles.small}>
        {longDate(narrative.generated_at)} · By Rolle Consulting Group
      </Text>
      <Text style={[styles.h1, { marginTop: 16 }]}>{headline}</Text>
      <Text style={styles.prose}>
        These are the same numbers we&apos;d compute for a brand we engage with — shared as a benchmark since the channel appears to already be under your control. Below: the buy-box picture, the sellers you&apos;ve confirmed represent the brand, top products driving the revenue, and a small residual reseller table you can address with the 3-step playbook further down.
      </Text>

      <View style={[styles.card, { marginTop: 8 }]}>
        <Text style={styles.channelCardLbl}>Brand-controlled buy box</Text>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4 }}>
          <Text style={[styles.kpiNum, { marginBottom: 0, marginRight: 10 }]}>{brandPct}%</Text>
          <ConfidencePill level={confSellerControl} />
        </View>
      </View>

      {revenue != null && (
        <View style={[styles.kpiRow, { marginTop: 18 }]}>
          <BigStat
            label="Estimated annual Amazon revenue"
            value={moneyFmt(revenue)}
            sub="Based on available marketplace data"
            confidence={confRevenue}
          />
        </View>
      )}
      {revenue == null && (
        <Text style={[styles.small, { marginTop: 12 }]}>
          Revenue not measured this run. Margin / business value below default to {Math.round(currentMarginPct * 100)}% of revenue at a {ebitdaMultiple}× EBITDA multiple — pressure-test on a call.
        </Text>
      )}
      {benchmark == null && revenue != null && null}

      <PageFooter label="Hero" brandName={brand.name} />
    </Page>
  );
}

function TightBenchmarkCardsPage({
  brand,
  revenue,
  benchmark,
  ebitdaMultiple,
  currentMarginPct,
  confRevenue,
}: {
  brand: BrandForReport;
  revenue: number | null;
  benchmark: { current_profit_annual: number; business_value: number } | null;
  ebitdaMultiple: number;
  currentMarginPct: number;
  confRevenue: ConfidenceLabel;
}) {
  const marginPctLabel = `${Math.round(currentMarginPct * 100)}%`;
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead
        eyebrow="Benchmark Snapshot"
        title="The same numbers we'd compute for a brand we engage with"
        source={`Directional benchmark · ${marginPctLabel} margin · ${ebitdaMultiple}× EBITDA`}
      />
      <Text style={styles.prose}>
        These are the same numbers we&apos;d compute for a brand we engage with — shared as a benchmark since the channel is already under your control. They are directional estimates designed to size the business, not a recapture pitch.
      </Text>
      <View style={styles.kpiRow}>
        <BigStat
          label="Estimated annual Amazon revenue"
          value={revenue != null ? moneyFmt(revenue) : "— not measured"}
          sub="Based on available marketplace data"
          confidence={confRevenue}
        />
        <BigStat
          label={`Estimated annual profit at ${marginPctLabel} margin`}
          value={benchmark != null ? moneyFmt(benchmark.current_profit_annual) : "— not measured"}
          sub="Directional estimate · margin assumption shown above"
          confidence="Medium"
        />
        <BigStat
          label={`Estimated business value (${ebitdaMultiple}× EBITDA)`}
          value={benchmark != null ? moneyFmt(benchmark.business_value) : "— not measured"}
          sub="Assumption-based · pressure-tested on a call"
          confidence="Assumption-based"
        />
      </View>
      <PageFooter label="Benchmark Snapshot" brandName={brand.name} />
    </Page>
  );
}

function TightBuyBoxPage({
  brand,
  bundle,
  derived,
  confSellerControl,
}: {
  brand: BrandForReport;
  bundle: BrandEnrichmentBundle | null;
  derived: DerivedSnapshot;
  confSellerControl: ConfidenceLabel;
}) {
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead
        eyebrow="Buy-box ownership"
        title="Who actually wins the buy box on your listings"
        source="Keepa · 90-day window · split by your seller classifications"
      />
      <Text style={styles.prose}>
        The bar below splits the buy-box wins on the audited ASINs across the four buckets we track. For a tight channel like yours, the bar should read mostly brand-owned with a small residual reseller sliver.
      </Text>
      <View style={styles.channelGrid}>
        <ChannelCard
          label="Brand-controlled buy box"
          value={`${Math.round(derived.non_reseller_share * 100)}%`}
          tone="good"
          confidence={confSellerControl}
        />
        <ChannelCard
          label="Reseller-controlled buy box"
          value={`${Math.round(derived.reseller_share * 100)}%`}
          tone="warn"
          confidence={confSellerControl}
        />
      </View>
      <BuyBoxPanel
        derived={derived}
        legacyPct={bundle?.keepa?.brand_controlled_pct ?? null}
      />
      <PageFooter label="Buy-box ownership" brandName={brand.name} />
    </Page>
  );
}

function TightBrandControlledPage({
  narrative,
  brand,
  derived,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
  derived: DerivedSnapshot;
}) {
  const sellers = narrative.reseller_reality.top_sellers ?? [];
  const brandRows: ResellerRow[] = [];
  for (const s of sellers) {
    const cls = lookupClassification(derived, s);
    if (cls === "brand_owned" || cls === "authorized" || cls === "amazon") {
      brandRows.push(s);
    }
  }
  const maxShare = brandRows.reduce((m, s) => Math.max(m, s.share_pct ?? 0), 0) || 1;
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead
        eyebrow="Sellers you've identified as brand-controlled"
        title="The sellers carrying your buy-box share"
        source="Keepa · classifications confirmed by you"
      />
      {brandRows.length > 0 ? (
        <>
          <Text style={styles.prose}>
            These are the sellers you&apos;ve confirmed represent the brand. They appear here so the channel-control picture stays accurate — and so the residual reseller table below is a clean, scoped list.
          </Text>
          <View style={styles.card}>
            {brandRows.map((s, i) => (
              <ResellerBar
                key={`tbc-${s.seller_name}-${i}`}
                row={s}
                maxShare={maxShare}
                good
              />
            ))}
          </View>
        </>
      ) : (
        <Text style={styles.body}>
          No sellers were classified as brand-controlled in your snapshot. The buy-box bar above still reflects the persisted share columns.
        </Text>
      )}
      <PageFooter label="Sellers you control" brandName={brand.name} />
    </Page>
  );
}

function TightResidualResellersPage({
  narrative,
  brand,
  derived,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
  derived: DerivedSnapshot;
}) {
  const sellers = narrative.reseller_reality.top_sellers ?? [];
  const resellerRows: ResellerRow[] = [];
  for (const s of sellers) {
    const cls = lookupClassification(derived, s);
    if (cls === "reseller") resellerRows.push(s);
  }
  const residualPct = Math.round(derived.reseller_share * 100);
  const maxShare = resellerRows.reduce((m, s) => Math.max(m, s.share_pct ?? 0), 0) || 1;
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead
        eyebrow={`Residual third-party seller activity (~${residualPct}%)`}
        title="The small residual you can address yourself"
        source="Keepa · classifications confirmed by you"
      />
      {resellerRows.length > 0 ? (
        <>
          <Text style={styles.prose}>
            These are the third-party sellers in the residual reseller bucket. The combined share is small — small enough that the 3-step playbook below is usually enough to seal it without bringing anyone in.
          </Text>
          <View style={styles.card}>
            {resellerRows.map((s, i) => (
              <ResellerBar
                key={`tr-${s.seller_name}-${i}`}
                row={s}
                maxShare={maxShare}
              />
            ))}
          </View>
          <Text style={[styles.small, { marginTop: 8 }]}>
            Authorization status should be confirmed with your team before contacting any of these sellers.
          </Text>
        </>
      ) : (
        <Text style={styles.body}>
          No third-party reseller activity to investigate based on your classifications.
        </Text>
      )}
      <PageFooter label="Residual sellers" brandName={brand.name} />
    </Page>
  );
}

function defaultDiySteps(brandName: string): DiyStep[] {
  return [
    {
      number: 1,
      title: "Send a polite request to the reseller asking them to stop selling.",
      body:
        `Most small unauthorized resellers — especially LLCs that look like ${brandName}'s own family or DBA — will comply when contacted directly. ` +
        `A short note works: "Hi, we've noticed you're listing our products on Amazon. We don't have a wholesale agreement on file — could you confirm your source so we can make sure our distribution is clean?" ` +
        `Give them 14 days.`,
    },
    {
      number: 2,
      title: "If they don't comply, file an Amazon Brand Registry complaint.",
      body:
        "Brand Registry gives you takedown power for unauthorized listings and counterfeit claims. " +
        "It's the lever that converts a polite ask into an enforced outcome. " +
        "Most resellers de-list within a week of the first complaint hitting their account.",
    },
    {
      number: 3,
      title: "Tighten distribution with your existing wholesale customers.",
      body:
        "Add a Minimum Advertised Price (MAP) policy and no-resale clauses for new accounts. " +
        "For existing accounts, send a one-page distribution policy update (MAP, no Amazon resale, no transshipping) and ask for written acknowledgment. " +
        "This is what stops the next reseller showing up six months from now.",
    },
  ];
}

function DiyStepsPage({
  narrative,
  brand,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
}) {
  const steps =
    narrative.diy_steps && narrative.diy_steps.length > 0
      ? narrative.diy_steps
      : defaultDiySteps(brand.name);
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead
        eyebrow="3 steps to wrap this up yourself"
        title="How to seal the residual reseller leakage"
      />
      {steps.map((s) => (
        <View key={s.number} style={[styles.card, { marginVertical: 4 }]}>
          <Text style={styles.stepNum}>Step {s.number}</Text>
          <Text style={styles.stepTitle}>{sanitizeForbidden(s.title)}</Text>
          <Text style={styles.stepBody}>{sanitizeForbidden(s.body)}</Text>
        </View>
      ))}
      <Text style={[styles.prose, { marginTop: 12 }]}>
        Most brands at this stage close the residual leakage in 30–60 days using just these three moves. No agency needed.
      </Text>
      <PageFooter label="DIY playbook" brandName={brand.name} />
    </Page>
  );
}

function DiyFooterCtaPage({
  narrative,
  brand,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
}) {
  const c = narrative.cta;
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Want help later?</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>
        When you&apos;re ready to scale or want a hand executing on this, we&apos;re a click away.
      </Text>
      <Text style={styles.prose}>
        Most brands at {brand.name}&apos;s stage don&apos;t need a consultant — they just need a clean plan. If you&apos;d like a second pair of eyes later, the strategy call is free and we&apos;ll walk through whatever you&apos;re seeing.
      </Text>
      <View style={[styles.card, { marginTop: 12 }]}>
        {c.primary_cta_url && (
          <Text style={[styles.body, { color: P.gold }]}>
            Book a free strategy call → {c.primary_cta_url}
          </Text>
        )}
        <Text style={[styles.body, { color: P.muted, marginTop: 4 }]}>{c.secondary_email}</Text>
      </View>
      <PageFooter label="Want help later?" brandName={brand.name} />
    </Page>
  );
}

// =====================================================================
// Legacy DIY (Phase 24) layout pages
// =====================================================================

function LegacyDiyCoverPage({
  narrative,
  brand,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
}) {
  const pct = narrative.brand_controlled_pct ?? null;
  const pctLabel =
    pct != null ? `${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%` : "most";
  const headline =
    narrative.cover.headline ||
    `${brand.name}, you're already running a tight Amazon channel.`;
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Channel Ownership Recommendations</Text>
      <View style={styles.goldRule} />
      <Text style={styles.smallInk}>Prepared for {brand.name}</Text>
      <Text style={styles.small}>
        {longDate(narrative.generated_at)} · By Rolle Consulting Group
      </Text>
      <Text style={[styles.h1, { marginTop: 16 }]}>{headline}</Text>
      <View style={[styles.card, { marginTop: 8 }]}>
        <Text style={styles.kpiNum}>{pctLabel}</Text>
        <Text style={styles.kpiLbl}>
          You already control {pctLabel} of your own Amazon sales — that&apos;s strong.
        </Text>
        <Text style={styles.kpiSub}>Buy-box ownership across your top SKUs · Keepa</Text>
      </View>
      <Text style={styles.prose}>
        Below: who&apos;s left on your listings, what they&apos;re shipping, and three concrete steps to seal the leak yourself.
      </Text>
      <PageFooter label="The good news" brandName={brand.name} />
    </Page>
  );
}

// =====================================================================
// Document
// =====================================================================

export interface RenderAuditPdfV2Args {
  narrative: NarrativeV2;
  brand: BrandForReport;
  /** Phase 42 — same enrichment bundle the web renderer reads. Optional
   *  on legacy callers (the renderer falls back to narrative-only data). */
  bundle?: BrandEnrichmentBundle | null;
  /** Phase 42 — persisted ReportAssumptions (margins / multiple). Falls
   *  back to DEFAULT_ASSUMPTIONS when missing. */
  assumptions?: ReportAssumptions | null;
  /** Phase 42 — `reports.seller_classifications` jsonb. Drives the
   *  classification-aware buckets + tight-channel detection. */
  classificationSnapshot?: SellerClassificationSnapshotEntry[] | null;
  /** Phase 42 — four `*_share_pct` columns persisted on the report row. */
  shareCols?: {
    brand_owned: number | null;
    authorized: number | null;
    amazon: number | null;
    reseller: number | null;
  } | null;
}

function AuditV2Document({
  narrative,
  brand,
  bundle,
  assumptions,
  classificationSnapshot,
  shareCols,
}: Required<Pick<RenderAuditPdfV2Args, "narrative" | "brand">> &
  Pick<RenderAuditPdfV2Args, "bundle" | "assumptions" | "classificationSnapshot" | "shareCols">) {
  const a: ReportAssumptions = { ...DEFAULT_ASSUMPTIONS, ...(assumptions ?? {}) };

  const derived: DerivedSnapshot = deriveSnapshot({
    share_pcts: shareCols ?? {
      brand_owned: null, authorized: null, amazon: null, reseller: null,
    },
    snapshot: classificationSnapshot ?? null,
    legacyBrandControlledPct:
      bundle?.keepa?.brand_controlled_pct ??
      narrative.brand_controlled_pct ??
      null,
  });

  const isTightShort = derived.is_tight_channel;
  const isLegacyDiy = !isTightShort && narrative.report_mode === "diy_fit";

  const revenueLine = narrative.math.lines.find((l) => l.key === "revenue");
  const revenueValue =
    typeof revenueLine?.value === "number" ? revenueLine.value : null;
  const revenueBadge = revenueLine?.badge ?? null;

  const confRevenue = confidenceForRevenue(revenueBadge);
  const confSellerControl = confidenceForSellerControl(derived);
  const confProfit = confidenceForProfitRecapture(derived, revenueBadge);
  const confValue = confidenceForBusinessValue();

  // Tight-channel benchmark math (mirrors web.tsx).
  const benchmark =
    isTightShort && revenueValue != null
      ? computeBenchmarkEconomics({
          revenue: revenueValue,
          current_profit_margin_pct: a.current_profit_margin_pct,
          ebitda_multiple: a.ebitda_multiple,
        })
      : null;

  // Opportunity-mode legion math (mirrors LegionMathSection).
  const legionInputs = {
    revenue: revenueValue ?? 0,
    reseller_markup_pct: a.reseller_markup_pct,
    outbound_shipping_pct: a.outbound_shipping_pct,
    outbound_shipping_payer: a.outbound_shipping_payer,
    reseller_net_margin_pct: a.reseller_net_margin_pct,
    current_profit_margin_pct: a.current_profit_margin_pct,
    ebitda_multiple: a.ebitda_multiple,
    labor_cost_override: a.labor_cost_override,
    brand_controlled_pct: derived.shares.has_snapshot
      ? derived.non_reseller_share
      : narrative.brand_controlled_pct ?? null,
  };
  const legionOut: LegionOutputs = computeLegionEconomics(legionInputs);
  const profitOpportunity =
    revenueValue != null && revenueValue > 0 ? legionOut.delta_profit : null;
  const valueOpportunity =
    revenueValue != null && revenueValue > 0 ? legionOut.exit_lift : null;
  const ebitdaMultipleStr = String(a.ebitda_multiple);

  if (isTightShort) {
    return (
      <Document>
        <TightHeroPage
          narrative={narrative}
          brand={brand}
          derived={derived}
          revenue={revenueValue}
          benchmark={benchmark}
          ebitdaMultiple={a.ebitda_multiple}
          currentMarginPct={a.current_profit_margin_pct}
          confRevenue={confRevenue}
          confSellerControl={confSellerControl}
        />
        <TightBenchmarkCardsPage
          brand={brand}
          revenue={revenueValue}
          benchmark={benchmark}
          ebitdaMultiple={a.ebitda_multiple}
          currentMarginPct={a.current_profit_margin_pct}
          confRevenue={confRevenue}
        />
        <TightBuyBoxPage
          brand={brand}
          bundle={bundle ?? null}
          derived={derived}
          confSellerControl={confSellerControl}
        />
        <TightBrandControlledPage
          narrative={narrative}
          brand={brand}
          derived={derived}
        />
        <TopProductsPage narrative={narrative} brand={brand} maxCards={5} />
        <TightResidualResellersPage
          narrative={narrative}
          brand={brand}
          derived={derived}
        />
        <DiyStepsPage narrative={narrative} brand={brand} />
        <DiyFooterCtaPage narrative={narrative} brand={brand} />
        <MethodologyPage narrative={narrative} brand={brand} />
        <DisclaimerPage brand={brand} />
      </Document>
    );
  }

  if (isLegacyDiy) {
    return (
      <Document>
        <LegacyDiyCoverPage narrative={narrative} brand={brand} />
        <ResellerRealityPage
          narrative={narrative}
          brand={brand}
          bundle={bundle ?? null}
          derived={derived}
        />
        <ResellerDossierPage
          narrative={narrative}
          brand={brand}
          derived={derived}
        />
        <TopProductsPage narrative={narrative} brand={brand} maxCards={10} />
        <DiyStepsPage narrative={narrative} brand={brand} />
        <DiyFooterCtaPage narrative={narrative} brand={brand} />
        <MethodologyPage narrative={narrative} brand={brand} />
        <DisclaimerPage brand={brand} />
      </Document>
    );
  }

  return (
    <Document>
      <HeroPage
        narrative={narrative}
        brand={brand}
        derived={derived}
        revenue={revenueValue}
        profit={profitOpportunity}
        value={valueOpportunity}
        ebitdaMultiple={ebitdaMultipleStr}
        confRevenue={confRevenue}
        confSellerControl={confSellerControl}
        confProfit={confProfit}
        confValue={confValue}
      />
      <ExecutiveSummaryPage
        narrative={narrative}
        brand={brand}
        derived={derived}
        revenue={revenueValue}
        profit={profitOpportunity}
      />
      <ChannelControlPage
        narrative={narrative}
        brand={brand}
        bundle={bundle ?? null}
        derived={derived}
        confSellerControl={confSellerControl}
      />
      <CustomerExperiencePage brand={brand} />
      <TopProductsPage narrative={narrative} brand={brand} maxCards={10} />
      <ResellerRealityPage
        narrative={narrative}
        brand={brand}
        bundle={bundle ?? null}
        derived={derived}
      />
      <ResellerDossierPage
        narrative={narrative}
        brand={brand}
        derived={derived}
      />
      <FinancialBridgePage
        narrative={narrative}
        brand={brand}
        derived={derived}
        revenue={revenueValue}
        out={legionOut}
        assumptions={a}
        revenueBadge={revenueBadge}
      />
      <SafeTransitionPage brand={brand} />
      <FrameworkPage narrative={narrative} brand={brand} derived={derived} />
      <WhySteveRollePage brand={brand} />
      <CaseStudyDiversifiedHospitalityPage brand={brand} />
      <CtaPage narrative={narrative} brand={brand} />
      <MethodologyPage narrative={narrative} brand={brand} />
      <DisclaimerPage brand={brand} />
    </Document>
  );
}

export async function renderAuditPdfV2(args: RenderAuditPdfV2Args): Promise<Buffer> {
  const buf = await renderToBuffer(
    <AuditV2Document
      narrative={args.narrative}
      brand={args.brand}
      bundle={args.bundle ?? null}
      assumptions={args.assumptions ?? null}
      classificationSnapshot={args.classificationSnapshot ?? null}
      shareCols={args.shareCols ?? null}
    />,
  );
  return buf;
}
