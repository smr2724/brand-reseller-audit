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
    // Phase 55 — strip stray markdown bold markers from LLM output.
    // PDF renderer doesn't process markdown either; same behavior as web.
    [/(\S)\*\*(\S)/g, "$1 **$2"],
    [/(\S)\*\*(\s)/g, "$1**$2"],
    [/\*\*([^*]+?)\*\*/g, "$1"],
    [/  +/g, " "],
  ];
  for (const [re, rep] of replacements) s = s.replace(re, rep);
  return s.trim();
}

// Phase 55 — Dossier-specific sanitizer. The reseller dossier is
// FORENSIC, not prescriptive. Mirror of web.tsx so PDF + web stay
// symmetric. If the LLM recommends MAP enforcement, an in-house team,
// or otherwise contradicts RCG's pitch, we strip the paragraph and
// fall back to a hardcoded forensic line.
const PDF_DOSSIER_FORBIDDEN_PHRASES: RegExp[] = [
  /\bMAP (?:policy|policies|enforcement|program)\b/gi,
  /\bMinimum Advertised Price\b/gi,
  /\b(?:enforce|enforcing) (?:a |an )?MAP\b/gi,
  /\b(?:build|develop|establish|stand up) (?:a |an )?in[- ]house team\b/gi,
  /\bin[- ]house team\b/gi,
  /\bdistribut(?:or|ion) (?:agreement|terms?|controls?)\b/gi,
  /\bwholesale (?:agreement|terms?)\b/gi,
  /\bcease[- ]and[- ]desist\b/gi,
  /\b(?:vital|crucial|essential|best[- ]in[- ]class|stakeholder|ecosystem|synergy)\b/gi,
  /\bleverag(?:e|ing|ed)\b/gi,
  /\bbuy them out\b/gi,
  /\b(?:transition them off|transition off the listings)\b/gi,
];

function sanitizeDossierProse(
  input: string | null | undefined,
  fallback: { sellerName: string; sharePct: number | null; asinsWon: number | null },
): string {
  if (!input) return "";
  let s = sanitizeForbidden(String(input));
  let tripped = false;
  for (const re of PDF_DOSSIER_FORBIDDEN_PHRASES) {
    if (re.test(s)) {
      tripped = true;
      re.lastIndex = 0;
    }
  }
  if (tripped) {
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn("[v2/pdf] dossier prose tripped forbidden-phrase sanitizer; falling back to forensic line.");
    }
    const share = fallback.sharePct != null ? `${Math.round(fallback.sharePct * 100)}%` : null;
    if (share && fallback.asinsWon != null && fallback.asinsWon > 0) {
      return `${fallback.sellerName} controls ${share} of the buy box across ${fallback.asinsWon} ASINs.`;
    }
    if (share) return `${fallback.sellerName} controls ${share} of the buy box.`;
    if (fallback.asinsWon != null && fallback.asinsWon > 0) {
      return `${fallback.sellerName} wins the buy box on ${fallback.asinsWon} ASINs.`;
    }
    return "";
  }
  return s;
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
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Amazon Channel Ownership Audit</Text>
      <View style={styles.goldRule} />
      <Text style={styles.smallInk}>Prepared for {brand.name}</Text>
      <Text style={styles.small}>
        {longDate(narrative.generated_at)} · By Rolle Consulting Group
      </Text>
      <Text style={[styles.h1, { marginTop: 16 }]}>{headline}</Text>

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

// Phase 58 — ChannelControlPage removed entirely. The persuasive
// argument it carried lives in the new Reseller Reality consolidation
// page above.

// Phase 58 — CustomerExperiencePage removed entirely.

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
        eyebrow="Top Products"
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
      {/* Phase 58 — "What's broken right now" block removed across all
          modes that previously rendered it. */}
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

// ====================================================================
// Phase 58 — Reseller Reality (consolidation prose)
//
// Persuasion centerpiece for `reseller_controlled` mode. Verbatim copy
// approved by the user — do not paraphrase, shorten, or "improve" it.
// Mirrors `SectionResellerRealityConsolidation` in web.tsx: standalone
// "Then we did the math." beat, bold Phase 1 / Phase 2, italicized
// closing questions.
// ====================================================================

function ResellerRealityConsolidationPage({ brand }: { brand: BrandForReport }) {
  return (
    <Page size="LETTER" style={styles.page} wrap>
      <SectionHead
        eyebrow="Reseller Reality"
        title="The question isn't whether your resellers are authorized — it's whether your channel is consolidated."
      />
      <Text style={styles.prose}>
        You may already have authorized resellers on Amazon — and you may believe your network is healthy. That belief is reasonable. Most brand owners in your revenue range hold it. None of what we&apos;re about to say is meant to take that away from you.
      </Text>
      <Text style={styles.prose}>
        What we&apos;ve learned is that the question isn&apos;t whether your resellers are{" "}
        <Text style={{ fontFamily: "Helvetica-Oblique" }}>authorized</Text>. It&apos;s whether your channel is{" "}
        <Text style={{ fontFamily: "Helvetica-Oblique" }}>consolidated</Text>. A fragmented seller base — even an authorized one — caps how aggressively the brand itself can invest in the channel. Pricing gets noisy. Listings get edited by people who don&apos;t own the P&amp;L. Advertising dollars compete with sellers who have no incentive to grow the catalog beyond their bestsellers. The brand ends up underwriting an ecosystem instead of running one.
      </Text>
      <Text style={styles.prose}>
        This usually isn&apos;t visible until a brand starts pushing past $5M in revenue. Below that, the math works. Above that, the cracks start showing — and most brand owners assume they&apos;re hitting a ceiling that&apos;s about the product, the category, or the algorithm. It&apos;s almost never any of those things.
      </Text>
      <Text style={styles.prose}>
        The clearest example we have is Diversified Hospitality. When we took over their Amazon channel, we assumed — like they did — that their existing reseller network was their growth engine. They had authorized partners. Sales were steady. Nothing looked broken.
      </Text>
      <Text style={styles.prose}>Then we did the math.</Text>
      <Text style={styles.prose}>
        The resellers weren&apos;t holding the brand back from $2M to $3M. They were holding the brand back from $2M to $10M. Once we consolidated control — pricing, listings, advertising, inventory positioning, all of it under one cohesive strategy owned by the brand — the channel grew more than 5x. That growth didn&apos;t come from removing bad actors. It came from removing fragmentation. The brand finally had one P&amp;L, one voice, one strategy on Amazon. That&apos;s when the real number showed up.
      </Text>
      <Text style={styles.prose}>
        We think of this as two phases.{" "}
        <Text style={styles.bold}>Phase 1 is consolidation</Text>: bringing the channel back under the brand&apos;s direct control so the economics stop leaking and the strategy stops competing with itself.{" "}
        <Text style={styles.bold}>Phase 2 is growth</Text>: running that consolidated channel like a real business, with a dedicated Chief Amazon Officer function, full P&amp;L ownership, and the kind of compounding investment that only makes sense once the brand controls every lever.
      </Text>
      <Text style={styles.prose}>
        If you walk away from this report thinking your reseller network is fine, that&apos;s a fair conclusion to reach. Most brand owners do — until they see what the consolidated version of their own channel looks like. The question we&apos;d leave you with isn&apos;t{" "}
        <Text style={{ fontFamily: "Helvetica-Oblique" }}>&ldquo;are my resellers a problem?&rdquo;</Text> It&apos;s{" "}
        <Text style={{ fontFamily: "Helvetica-Oblique" }}>&ldquo;how much growth am I leaving on the table because nobody owns the whole picture?&rdquo;</Text>
      </Text>
      <PageFooter label="Reseller Reality" brandName={brand.name} />
    </Page>
  );
}

// Phase 58 — ResellerDossierPage removed entirely. The "Did You
// Authorize These Sellers?" and "Top ASINs they win" sub-sections were
// two of the five removed sections.

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

// Phase 58 — SafeTransitionPage removed; the transition narrative is
// folded into the Five-Step Framework page.

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
                      {DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.frameworkStep4}
                    </Text>
                  </View>
                )}
                {/* Phase 59 — Step 5 "Team model" callout removed per spec. */}
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
              {/* Phase 59 — Step 5 "Team model" callout removed per spec. */}
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
  // Phase 55 — appositive guard mirror of web.tsx.
  const appositivePatterns = names.map(
    (n) =>
      new RegExp(
        `(your brand|the brand|${escape(n)})\\s*,\\s*${escape(n)}\\s*,\\s*`,
        "gi",
      ),
  );
  return (input: string) => {
    if (!input) return input ?? "";
    let out = input;
    for (const re of constructPatterns) out = out.replace(re, "third-party resellers");
    for (const re of appositivePatterns) out = out.replace(re, "$1 ");
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
        title="How Diversified Hospitality doubled its Amazon profit at flat revenue by taking the channel back from resellers"
      />
      <Text style={styles.prose}>
        When RCG took over Diversified Hospitality&apos;s Amazon channel, customer experience metrics improved immediately. Amazon sales stayed at roughly $2M before and after the transition — and Diversified Hospitality&apos;s profit on those sales doubled in that same period by being the one selling them. They didn&apos;t lose a single customer. They didn&apos;t add one either. The entire profit lift came from removing the reseller layer and letting the brand keep the margin that was already there.
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
          "Amazon became a brand-controlled profit center",
          "Customer experience became more consistent",
          "Cash flow improved significantly because Amazon paid faster than reseller terms",
          "Diversified paid down more than $5 million in accounts payable across the capture period",
          "The increased profitability materially improved the underlying business",
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

      {cs.sections.whyThisMatters.paragraphs &&
        cs.sections.whyThisMatters.paragraphs.length > 0 && (
          <>
            <Text style={[styles.h3, { marginTop: 10 }]}>
              Why This Matters for Your Brand
            </Text>
            {cs.sections.whyThisMatters.paragraphs.map((p, i) => (
              <Text key={`w-p-${i}`} style={styles.prose}>
                {p}
              </Text>
            ))}
          </>
        )}

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
        eyebrow="Why Steve Rolle / RCG"
        title="Operator-led, not agency"
      />
      <Text style={styles.prose}>
        {DIVERSIFIED_HOSPITALITY_CASE_STUDY.snippets.whySteveBio}
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
      <PageFooter label="Why Steve / RCG" brandName={brand.name} />
    </Page>
  );
}

// =====================================================================
// Phase 54 — Phase 2 / fractional Chief Amazon Officer page.
// Renders only in opportunity mode, between Five-Step Framework and
// Why Steve Rolle.
// =====================================================================

function PhaseTwoPage({ brand }: { brand: BrandForReport }) {
  return (
    <Page size="LETTER" style={styles.page} wrap>
      <SectionHead
        eyebrow="Phase 2"
        title="What comes next, once capture is complete"
      />
      <Text style={styles.prose}>
        Phase 1 is about taking control of what&apos;s already yours — recovering the margin sitting in someone else&apos;s pocket on demand you already generate. That&apos;s what this report has covered.
      </Text>
      <Text style={styles.prose}>
        Phase 2 is a different question entirely.
      </Text>
      <Text style={styles.prose}>
        Once your channel is brand-controlled and the leakage is closed, the question shifts from &ldquo;how do we stop the bleeding&rdquo; to &ldquo;how do we compound this into a meaningful business.&rdquo; That&apos;s where most brands stall — not because the team isn&apos;t capable, but because the Amazon growth playbook is a moving target. The right agency this year is the wrong one next year. The right team structure at $5M is the wrong one at $15M. The experiments that compound aren&apos;t the ones that look obvious from the outside.
      </Text>
      <Text style={styles.prose}>
        Phase 2 is where Rolle Consulting steps in as your fractional Chief Amazon Officer — orchestrating the agencies, strategists, and team scaling that turn a controlled channel into a compounding one. We&apos;ve already done the trial-and-error on which partners deliver, which experiments are worth the spend, and how to scale the team without scaling overhead ahead of the revenue.
      </Text>
      <Text style={styles.prose}>
        Phase 2 is a separate engagement that begins after Phase 1 capture stabilizes. We&apos;ll walk through what that looks like for {brand.name} once Phase 1 is on track.
      </Text>
      <PageFooter label="Phase 2 — What comes next" brandName={brand.name} />
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
      <Text style={styles.prose}>
        If Phase 1 lands, we&apos;ll talk about Phase 2 — running the controlled channel as a fractional CAO engagement — as a separate conversation.
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

      {/* Phase 58 — Variation handling methodology moved here from
          mid-report (where it sat next to the top-products grid). */}
      <View style={styles.card}>
        <Text style={styles.h3}>Methodology · Variation handling</Text>
        <Text style={{ fontSize: 10, lineHeight: 1.5, color: P.ink }}>
          Some ASINs in this brand share a parent listing with sibling
          variations (e.g. a 4-pack and a 12-pack of the same product).
          Amazon&apos;s sales rank is often shared across variations, which
          causes raw third-party sales estimators to over-count sales on
          inactive variations. We attribute group-level sales to each
          variation using a combined signal:{" "}
          <Text style={styles.bold}>recent review activity (last 90 days)</Text>{" "}
          plus{" "}
          <Text style={styles.bold}>
            Buy Box win frequency (how often each variation actually held
            the Buy Box recently)
          </Text>
          . When some siblings have Buy Box history and others don&apos;t, the
          absence of Buy Box activity is itself evidence the listing hasn&apos;t
          been selling — those variations correctly receive minimal
          attributed sales.{" "}
          <Text style={styles.bold}>
            These per-ASIN sales numbers are estimates derived from Keepa
            rank, review, and Buy Box data, not direct sales reporting.
          </Text>
        </Text>
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

// Phase 56 — Segment 4 soft-lead opener (opportunity_softlead mode).
function SoftLeadPage({
  brand,
  derived,
}: {
  brand: BrandForReport;
  derived: DerivedSnapshot;
}) {
  const brandOwnedPct = Math.round((derived.shares?.brand_owned ?? 0) * 100);
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead eyebrow="You're doing well" title="Brand-controlled, with a leakage gap to close" />
      <Text style={styles.prose}>
        {brand.name}, you control a meaningful share of your Amazon channel
        yourself — roughly {brandOwnedPct}% brand-owned today. That puts you
        ahead of most. The remaining slice is where unauthorized resellers are
        still costing you in leakage. Close that gap and you control 100% of
        sales, profit on existing demand doubles, and you&apos;re set up for
        Phase 2 growth.
      </Text>
      <PageFooter label="Soft Lead" brandName={brand.name} />
    </Page>
  );
}

// Phase 56 — Segment 2 (authorized_network_healthy) callout. Soft,
// consultative, mirrors web.tsx SectionAuthorizedResellersCap.
function AuthorizedResellersCapPage() {
  return (
    <Page size="LETTER" style={styles.page}>
      <SectionHead
        eyebrow="Authorized networks"
        title="Why even authorized resellers cap your growth"
      />
      <Text style={styles.prose}>
        Authorized resellers can be excellent partners. They hold inventory,
        they extend reach, and they often grew with your brand. None of that is
        going away.
      </Text>
      <Text style={styles.prose}>
        But there&apos;s a quieter cost that becomes visible at scale: a
        fragmented seller base — even an authorized one — caps how aggressively
        the brand itself can invest in the channel. Each reseller sets their
        own pricing posture. Each one decides their own inventory cadence.
        Each one shapes a piece of the customer experience the brand owner
        doesn&apos;t control.
      </Text>
      <Text style={styles.prose}>
        That fragmentation isn&apos;t a problem at $1M, $2M, or even $5M of
        Amazon revenue. It becomes the bottleneck somewhere between $5M and
        $10M, when the brand wants to invest seriously in advertising,
        content, and listing optimization — and discovers that those
        investments compound only when 100% of the buy box is brand-controlled.
      </Text>
      <Text style={styles.prose}>
        Diversified Hospitality went through exactly this. Authorized
        distributors were &ldquo;helping&rdquo; until we ran the numbers.
        Phase 1 brought all sales under brand control — profit doubled on the
        same revenue base. Phase 2 then took the channel from $2M to $10M+
        per year. None of that compounding was possible while the channel was
        fragmented across resellers, even authorized ones.
      </Text>
      <Text style={styles.prose}>
        We&apos;re not telling you your distributor network is bad.
        We&apos;re telling you it&apos;s the layer between where you are now
        and where Phase 2 can take you.
      </Text>
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
  derived,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
  derived?: DerivedSnapshot;
}) {
  const c = narrative.cta;
  const pct =
    (derived && derived.shares.has_snapshot
      ? derived.non_reseller_share
      : narrative.brand_controlled_pct) ?? null;
  const brandControlledPct =
    pct != null ? Math.round(Math.max(0, Math.min(1, pct)) * 100) : null;
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>What comes next</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h2}>
        You&apos;ve done more than most brands ever do. Here&apos;s what comes next.
      </Text>
      <Text style={styles.prose}>
        Your snapshot shows roughly {brandControlledPct != null ? `${brandControlledPct}%` : "most"} of buy-box wins running through brand-controlled entities — that puts you ahead of 80%+ of the brands we audit. Genuine credit for that; most owners never get there.
      </Text>
      <Text style={styles.prose}>
        The path from where you are to a channel that compounds at the rate Amazon allows is shorter than for most brands — but it isn&apos;t zero. There&apos;s a distinction that matters before growth investment starts paying back at full strength: complete sales control is different from majority sales control. Authorized resellers — even the ones operating in good faith — fragment how the channel can be invested in. Each one sets its own pricing posture, its own inventory cadence, its own customer experience. None of them are positioned to invest in the brand the way the brand owner can. Before Phase 2 capital and strategy can compound, the channel needs to be running at 100% — not 95%, not 90%.
      </Text>
      <Text style={styles.prose}>
        For brands in your position, Phase 1 is shorter and lighter than the typical engagement. The work is finishing what you started: closing the residual gap, transitioning the remaining authorized sellers under terms that respect the relationships you&apos;ve built, and putting the operational scaffolding in place so Phase 2 has a clean foundation. Brands in this position typically clear Phase 1 quickly.
      </Text>
      <Text style={styles.prose}>
        Phase 2 is where the next chapter starts — and that&apos;s a conversation we&apos;d genuinely like to have with you.
      </Text>
      <View style={[styles.card, { marginTop: 12 }]}>
        {c.primary_cta_url && (
          <Text style={[styles.body, { color: P.gold }]}>
            Schedule a 15-minute review with Steve → {c.primary_cta_url}
          </Text>
        )}
        <Text style={[styles.body, { color: P.muted, marginTop: 4 }]}>{c.secondary_email}</Text>
      </View>
      <PageFooter label="What comes next" brandName={brand.name} />
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

  // Phase 56 — segment-driven routing (Edge F). Mirrors web.tsx.
  const segment = narrative.qualification?.segment ?? null;
  const segmentSays = (() => {
    switch (segment) {
      case "authorized_network_healthy":
        return "tight" as const;
      case "brand_managed_with_leakage":
        return "opportunity_softlead" as const;
      case "reseller_controlled":
      case "mixed_control":
        return "opportunity" as const;
      default:
        return null;
    }
  })();
  const isTightShort =
    segmentSays === "tight" ||
    (segmentSays == null && derived.is_tight_channel);
  const isSoftLead = segmentSays === "opportunity_softlead";
  const isLegacyDiy =
    segmentSays == null &&
    !isTightShort &&
    narrative.report_mode === "diy_fit";

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
        {segment === "authorized_network_healthy" && (
          <AuthorizedResellersCapPage />
        )}
        <DiyStepsPage narrative={narrative} brand={brand} />
        <DiyFooterCtaPage narrative={narrative} brand={brand} derived={derived} />
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
        {/* Phase 58 — ResellerDossierPage removed; "Did You Authorize
            These Sellers?" / "Top ASINs They Win" gone in all modes. */}
        <TopProductsPage narrative={narrative} brand={brand} maxCards={10} />
        <DiyStepsPage narrative={narrative} brand={brand} />
        <DiyFooterCtaPage narrative={narrative} brand={brand} derived={derived} />
        <MethodologyPage narrative={narrative} brand={brand} />
        <DisclaimerPage brand={brand} />
      </Document>
    );
  }

  // Phase 58 — opportunity-mode ordering:
  //   Hero → Exec Summary → Reseller Reality (new consolidation prose
  //   for reseller_controlled; existing data-led page for other segments)
  //   → Financial Opportunity → Five-Step Framework → Phase 2 →
  //   Diversified case study → Why Steve / RCG → CTA → Methodology.
  // The Channel Control, Top Products (Evidence Snapshot), CX, Safe
  // Transition, and Reseller Dossier pages were dropped.
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
      {isSoftLead && <SoftLeadPage brand={brand} derived={derived} />}
      <ExecutiveSummaryPage
        narrative={narrative}
        brand={brand}
        derived={derived}
        revenue={revenueValue}
        profit={profitOpportunity}
      />
      {segment === "reseller_controlled" ? (
        <ResellerRealityConsolidationPage brand={brand} />
      ) : (
        <ResellerRealityPage
          narrative={narrative}
          brand={brand}
          bundle={bundle ?? null}
          derived={derived}
        />
      )}
      <FinancialBridgePage
        narrative={narrative}
        brand={brand}
        derived={derived}
        revenue={revenueValue}
        out={legionOut}
        assumptions={a}
        revenueBadge={revenueBadge}
      />
      <FrameworkPage narrative={narrative} brand={brand} derived={derived} />
      <PhaseTwoPage brand={brand} />
      <CaseStudyDiversifiedHospitalityPage brand={brand} />
      <WhySteveRollePage brand={brand} />
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
