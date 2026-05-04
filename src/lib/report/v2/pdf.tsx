/**
 * Phase 8 — v2 audit report PDF.
 *
 * Mirrors the 9 sections from web.tsx in a print-ready PDF using
 * @react-pdf/renderer. Single column, same RCG palette but on a cream
 * paper background for print. Math + benchmark are full-width tables.
 */
/* eslint-disable jsx-a11y/alt-text */
import React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Image,
  renderToBuffer,
} from "@react-pdf/renderer";
import type { NarrativeV2 } from "./types";
import type { BrandForReport } from "@/lib/report/narrative";

// --------------------------- palette ---------------------------
const P = {
  ink: "#0B1220",
  paper: "#F7F5F0",
  gold: "#C9A96A",
  goldSoft: "#D8B878",
  muted: "#4B5563",
  rule: "#D6D3CB",
  red: "#B5483D",
  green: "#3F8F62",
  white: "#FFFFFF",
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
  eyebrow: {
    fontSize: 9, letterSpacing: 1.4, textTransform: "uppercase",
    color: P.gold, marginBottom: 6, fontFamily: "Helvetica-Bold",
  },
  source: { fontSize: 8, color: P.muted, marginBottom: 12, textTransform: "uppercase", letterSpacing: 0.6 },
  h1: { fontFamily: "Helvetica-Bold", fontSize: 26, lineHeight: 1.15, marginBottom: 16, color: P.ink },
  h2: { fontFamily: "Helvetica-Bold", fontSize: 18, marginBottom: 6, color: P.ink },
  h3: { fontFamily: "Helvetica-Bold", fontSize: 12, marginBottom: 4, color: P.ink },
  body: { fontSize: 11, color: P.ink, marginBottom: 8 },
  small: { fontSize: 9, color: P.muted },
  goldRule: { height: 2, width: 36, backgroundColor: P.gold, marginBottom: 12 },
  footer: {
    position: "absolute", bottom: 28, left: 48, right: 48,
    flexDirection: "row", justifyContent: "space-between",
    fontSize: 8, color: P.muted,
    borderTopWidth: 0.5, borderTopColor: P.rule, paddingTop: 6,
  },
  // KPI grid
  kpiRow: { flexDirection: "row", marginHorizontal: -4, marginVertical: 8 },
  kpi: {
    flex: 1, marginHorizontal: 4, padding: 12,
    borderWidth: 0.5, borderColor: P.rule, borderRadius: 4, backgroundColor: P.white,
  },
  kpiNum: { fontFamily: "Helvetica-Bold", fontSize: 16, color: P.gold },
  kpiLbl: { fontSize: 9, marginTop: 4, color: P.ink },
  kpiSub: { fontSize: 8, marginTop: 2, color: P.muted },

  // Bars
  bar: {
    flexDirection: "row", alignItems: "center",
    marginBottom: 6, fontSize: 10,
  },
  barRank: { width: 16, color: P.gold, fontFamily: "Helvetica-Bold" },
  barName: { width: 130, color: P.ink },
  barTrack: { flex: 1, height: 8, backgroundColor: P.rule, marginHorizontal: 6, borderRadius: 2 },
  barFill: { height: 8, backgroundColor: P.gold, borderRadius: 2 },
  barVal: { width: 38, textAlign: "right", color: P.goldSoft },
  barAsins: { width: 50, textAlign: "right", color: P.muted, fontSize: 9 },

  // Tables
  table: { borderTopWidth: 0.5, borderTopColor: P.rule, marginVertical: 8 },
  tableRow: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: P.rule, paddingVertical: 5 },
  tableHead: { color: P.muted, fontSize: 8, textTransform: "uppercase", letterSpacing: 0.6, fontFamily: "Helvetica-Bold" },
  tableCell: { fontSize: 10, color: P.ink, paddingHorizontal: 4 },
  tableCellNum: { fontSize: 10, color: P.goldSoft, paddingHorizontal: 4, textAlign: "right" },

  // Plan columns
  planRow: { flexDirection: "row", marginHorizontal: -4 },
  planCol: {
    flex: 1, marginHorizontal: 4, padding: 12,
    borderWidth: 0.5, borderColor: P.rule, borderRadius: 4, backgroundColor: P.white,
  },
  planLabel: { fontSize: 8, color: P.gold, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6, fontFamily: "Helvetica-Bold" },
  planBullet: { fontSize: 9, marginBottom: 4, color: P.ink, lineHeight: 1.4 },

  // Misc
  callout: {
    backgroundColor: "#F1ECDF", borderLeftWidth: 2, borderLeftColor: P.gold,
    padding: 10, marginVertical: 8, fontSize: 10, color: P.ink,
  },
  card: {
    backgroundColor: P.white, borderWidth: 0.5, borderColor: P.rule,
    padding: 12, marginVertical: 6, borderRadius: 4,
  },
  factGrid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -4 },
  fact: { width: "33%", padding: 4 },
  factLbl: { fontSize: 8, color: P.muted, textTransform: "uppercase", letterSpacing: 0.6 },
  factVal: { fontSize: 11, color: P.ink, fontFamily: "Helvetica-Bold", marginTop: 2 },
});

function PageFooter({ label }: { label: string }) {
  return (
    <View style={styles.footer} fixed>
      <Text>Channel Ownership Audit · Rolle Consulting Group</Text>
      <Text>{label}</Text>
    </View>
  );
}

function paragraphs(md: string | null | undefined): string[] {
  if (!md) return [];
  return md.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
}

function moneyFmt(n: number | null): string {
  if (n == null) return "— not measured";
  return `$${Math.round(Number(n)).toLocaleString("en-US")}`;
}

function pctFmt(n: number | null): string {
  if (n == null) return "—";
  return `${Math.round(Number(n) * 100)}%`;
}

function volFmt(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Phase 36 — per-ASIN unit display matching Amazon's monthly badge:
 * "{monthly}/mo (~{annual}/yr)". Falls back to ttm-only when monthly
 * is missing (legacy narrative_json) and to monthly-only when ttm is
 * missing.
 */
function unitsFmt(
  monthly: number | null | undefined,
  ttm: number | null | undefined,
): string {
  const hasMonthly = monthly != null && Number.isFinite(monthly);
  const hasTtm = ttm != null && Number.isFinite(ttm);
  if (!hasMonthly && !hasTtm) return "—";
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

// =====================================================================
// Sections
// =====================================================================

function CoverPage({ narrative, brand }: { narrative: NarrativeV2; brand: BrandForReport }) {
  const c = narrative.cover;
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Channel Ownership Audit</Text>
      <View style={styles.goldRule} />
      <Text style={styles.h1}>{brand.name}</Text>
      <Text style={[styles.body, { fontSize: 13, marginBottom: 16 }]}>{c.headline}</Text>
      <Text style={styles.small}>
        Prepared by Rolle Consulting Group · {new Date(narrative.generated_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
      </Text>
      {c.kpis.length > 0 && (
        <View style={styles.kpiRow}>
          {c.kpis.map((k, i) => (
            <View key={i} style={styles.kpi}>
              <Text style={styles.kpiNum}>{k.value}</Text>
              <Text style={styles.kpiLbl}>{k.label}</Text>
              {k.sub && <Text style={styles.kpiSub}>{k.sub}</Text>}
            </View>
          ))}
        </View>
      )}
      <PageFooter label="Cover" />
    </Page>
  );
}

// Phase 35 — Methodology & Audit Scope (PDF page 2). Mirrors the web
// section (web.tsx → SectionMethodology) byte-for-byte: same wording,
// same structure. Always rendered, even when narrative.audit_scope is
// null on legacy reports — counts fall back to "— not measured".
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

  const longDate = (iso: string | null): string => {
    if (!iso) return "— not measured";
    try {
      return new Date(iso).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return "— not measured";
    }
  };

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

  const exclusionBullets: { key: string; text: React.ReactNode }[] = [];
  if (exclusions.rank_too_high > 0) {
    exclusionBullets.push({
      key: "rank",
      text: (
        <>
          <Text style={{ fontFamily: "Helvetica-Bold" }}>Rank ceiling: </Text>
          {exclusions.rank_too_high} ASINs ranked above 500,000 in their category were excluded as low-velocity.
        </>
      ),
    });
  }
  if (exclusions.out_of_stock > 0) {
    exclusionBullets.push({
      key: "oos",
      text: (
        <>
          <Text style={{ fontFamily: "Helvetica-Bold" }}>Out of stock: </Text>
          {exclusions.out_of_stock} ASINs flagged as out of stock by Amazon were excluded.
        </>
      ),
    });
  }
  if (exclusions.no_buy_box_history > 0) {
    exclusionBullets.push({
      key: "nobb",
      text: (
        <>
          <Text style={{ fontFamily: "Helvetica-Bold" }}>No buy-box history: </Text>
          {exclusions.no_buy_box_history} ASINs with no recorded buy-box winner in the trailing 90 days are kept in the catalog count but contribute zero attributed sales (we treat the absence of buy-box activity as evidence the listing did not sell).
        </>
      ),
    });
  }
  if (exclusions.variation_inactive_sibling > 0) {
    exclusionBullets.push({
      key: "var",
      text: (
        <>
          <Text style={{ fontFamily: "Helvetica-Bold" }}>Variation siblings: </Text>
          {exclusions.variation_inactive_sibling} bulk-pack or parent-shell ASINs that share rank with an active sibling and have no independent buy-box wins receive zero attributed units to avoid double-counting.
        </>
      ),
    });
  }

  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Audit Scope</Text>
      <Text style={styles.h2}>Methodology & Audit Scope</Text>
      <View style={[styles.goldRule, { marginTop: 4, marginBottom: 14 }]} />

      {/* 4-cell stat strip */}
      <View style={styles.kpiRow}>
        <View style={styles.kpi}>
          <Text style={styles.kpiNum}>{brand.name}</Text>
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

      {/* Why these ASINs are included */}
      <View style={styles.card}>
        <Text style={styles.h3}>Why these ASINs are included</Text>
        {exclusionBullets.length > 0 ? (
          exclusionBullets.map((b) => (
            <Text key={b.key} style={[styles.body, { marginBottom: 4 }]}>• {b.text}</Text>
          ))
        ) : (
          <Text style={[styles.body, { marginBottom: 0 }]}>
            All ASINs Keepa returned for this brand had measurable sales activity in the trailing 90 days, so no listings were excluded from the catalog count.
          </Text>
        )}
      </View>

      {/* How we estimate units sold */}
      <View style={styles.card}>
        <Text style={styles.h3}>How we estimate units sold</Text>
        <Text style={[styles.body, { marginBottom: 4 }]}>
          • <Text style={{ fontFamily: "Helvetica-Bold" }}>Primary source — Amazon&apos;s published purchase badge.</Text>{" "}
          When Amazon shows a &ldquo;100+ bought in past month&rdquo; or similar badge on the listing, we capture that value via Keepa&apos;s monthlySold field.{" "}
          <Text style={{ fontFamily: "Helvetica-Bold" }}>
            {withBadge} of {asinsIncluded ?? 0} included ASINs have a published badge.
          </Text>
        </Text>
        <Text style={[styles.body, { marginBottom: 4 }]}>
          • <Text style={{ fontFamily: "Helvetica-Bold" }}>Fallback — BSR curve.</Text>{" "}
          For ASINs without a published badge, we estimate monthly units from the ASIN&apos;s category sales rank using a published-research BSR-to-units curve.
        </Text>
        <Text style={[styles.body, { marginBottom: 4 }]}>
          • <Text style={{ fontFamily: "Helvetica-Bold" }}>Variation attribution.</Text>{" "}
          When sibling ASINs share a parent listing&apos;s sales rank, we split the parent&apos;s units across siblings using recent review activity (last 90 days) plus buy-box win frequency. Inactive siblings (pallets, dormant variations) receive zero.
        </Text>
        <Text style={[styles.body, { marginBottom: 0 }]}>
          • <Text style={{ fontFamily: "Helvetica-Bold" }}>Revenue formula.</Text>{" "}
          attributed monthly units x current buy-box price x 12 = trailing 12-month revenue estimate, summed across every included ASIN.
        </Text>
      </View>

      {/* Conservative-estimate disclaimer */}
      <View style={[styles.callout, { marginTop: 10 }]}>
        <Text style={[styles.h3, { marginBottom: 4 }]}>About the &ldquo;100+ bought&rdquo; badge.</Text>
        <Text style={{ fontSize: 10, lineHeight: 1.5, color: P.ink }}>
          Amazon publishes monthly purchase badges in tiers (&ldquo;50+ bought&rdquo;, &ldquo;100+ bought&rdquo;, &ldquo;1,000+ bought&rdquo;). When we see &ldquo;100+ bought,&rdquo; our model records exactly{" "}
          <Text style={{ fontFamily: "Helvetica-Bold" }}>100</Text>{" "}
          units — even though the true number could be 101, 199, or anything up to the next tier.{" "}
          <Text style={{ fontFamily: "Helvetica-Bold" }}>We are deliberately conservative.</Text>{" "}
          A brand with many &ldquo;100+&rdquo; or &ldquo;1,000+&rdquo; badged ASINs may have meaningfully higher actual TTM revenue than this report shows. Replace these estimates with the seller&apos;s actual TTM during diligence.
        </Text>
      </View>

      {/* What this report does NOT do */}
      <View style={styles.card}>
        <Text style={styles.h3}>What this report does not do</Text>
        <Text style={[styles.body, { marginBottom: 4 }]}>
          • This report does not adjust for <Text style={{ fontFamily: "Helvetica-Bold" }}>seasonality</Text> — trailing 12-month revenue is treated as flat across the year.
        </Text>
        <Text style={[styles.body, { marginBottom: 4 }]}>
          • This report does not include <Text style={{ fontFamily: "Helvetica-Bold" }}>non-Amazon channels</Text> (Walmart, Shopify, wholesale, retail).
        </Text>
        <Text style={[styles.body, { marginBottom: 4 }]}>
          • This report does not detect <Text style={{ fontFamily: "Helvetica-Bold" }}>brand-name collisions</Text> — if a brand catalog umbrellas multiple sub-brands or a hijacked listing, those ASINs may still appear as included.
        </Text>
        <Text style={[styles.body, { marginBottom: 0 }]}>
          • This report does not include <Text style={{ fontFamily: "Helvetica-Bold" }}>direct sales reporting</Text> — every per-ASIN unit number is a model estimate.
        </Text>
      </View>

      {/* Data-sources strip */}
      <Text style={[styles.small, { marginTop: 12 }]}>
        Keepa snapshot · {longDate(keepaFresh)}  ·  DataForSEO snapshot · {longDate(dfsFresh)}  ·  Buy-box history window · 90 days
      </Text>

      <PageFooter label="Methodology & Audit Scope" />
    </Page>
  );
}

function ResellerRealityPage({ narrative }: { narrative: NarrativeV2 }) {
  const r = narrative.reseller_reality;
  const max = r.top_sellers.reduce((m, s) => Math.max(m, s.share_pct ?? 0), 0) || 1;
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Reseller Reality</Text>
      <Text style={styles.h2}>Who actually sells your brand on Amazon</Text>
      <Text style={styles.source}>Keepa · 90-day window</Text>
      {r.top_sellers.length === 0 ? (
        <Text style={styles.body}>{r.note ?? "Reseller landscape — not measured."}</Text>
      ) : (
        <View style={{ marginTop: 6 }}>
          {r.top_sellers.slice(0, 10).map((s) => (
            <View key={`${s.seller_name}-${s.rank}`} style={styles.bar}>
              <Text style={styles.barRank}>{s.rank}.</Text>
              <Text style={styles.barName}>{(s.seller_name ?? "Unknown 3P seller").slice(0, 30)}</Text>
              <View style={styles.barTrack}>
                <View
                  style={[styles.barFill, { width: `${Math.max(2, Math.round(((s.share_pct ?? 0) / max) * 100))}%` }]}
                />
              </View>
              <Text style={styles.barVal}>{s.share_pct != null ? `${Math.round(s.share_pct * 100)}%` : "—"}</Text>
              <Text style={styles.barAsins}>{s.asins_won != null ? `${s.asins_won} ASINs` : ""}</Text>
            </View>
          ))}
        </View>
      )}
      {r.one_liner && <View style={styles.callout}><Text>{r.one_liner}</Text></View>}
      <PageFooter label="Reseller Reality" />
    </Page>
  );
}

function DossierPage({ narrative }: { narrative: NarrativeV2 }) {
  const d = narrative.reseller_dossier;
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Reseller Dossier</Text>
      <Text style={styles.h2}>{d ? `Inside ${d.seller_name}` : "Top sellers snapshot"}</Text>
      <Text style={styles.source}>Keepa · seller profile</Text>
      {d ? (
        <>
          <View style={styles.factGrid}>
            <View style={styles.fact}><Text style={styles.factLbl}>Seller</Text><Text style={styles.factVal}>{d.seller_name}</Text></View>
            <View style={styles.fact}><Text style={styles.factLbl}>Country</Text><Text style={styles.factVal}>{d.country ?? "— not measured"}</Text></View>
            <View style={styles.fact}><Text style={styles.factLbl}>Buy-box share</Text><Text style={styles.factVal}>{pctFmt(d.share_pct)}</Text></View>
            <View style={styles.fact}><Text style={styles.factLbl}>ASINs won</Text><Text style={styles.factVal}>{d.asins_won != null ? String(d.asins_won) : "— not measured"}</Text></View>
            <View style={styles.fact}><Text style={styles.factLbl}>Fulfilment</Text><Text style={styles.factVal}>{d.fulfilment_mix}</Text></View>
            <View style={styles.fact}><Text style={styles.factLbl}>Marketplace ID</Text><Text style={styles.factVal}>{d.seller_id ?? "— not measured"}</Text></View>
          </View>
          {d.top_asins.length > 0 && (
            <View style={[styles.card, { marginTop: 10 }]}>
              <Text style={styles.h3}>Top ASINs they win</Text>
              {d.top_asins.map((a) => (
                <Text key={a.asin} style={[styles.body, { marginBottom: 2 }]}>
                  <Text style={{ color: P.gold, fontFamily: "Helvetica-Bold" }}>{a.asin}</Text>
                  {"  "}
                  {a.title?.slice(0, 80) ?? "— not measured"}
                  {a.buy_box_price != null ? `  ·  $${Number(a.buy_box_price).toFixed(2)}` : ""}
                </Text>
              ))}
            </View>
          )}
          {d.risk_profile && (
            <View style={styles.callout}>
              {paragraphs(d.risk_profile).map((p, i) => (
                <Text key={i} style={{ marginBottom: 4 }}>{p}</Text>
              ))}
            </View>
          )}
        </>
      ) : (
        <Text style={styles.body}>
          The dominant reseller share is below 20% — see the Reseller Reality section for the full distribution.
        </Text>
      )}
      <PageFooter label="Reseller Dossier" />
    </Page>
  );
}

function CxAuditPage({ narrative }: { narrative: NarrativeV2 }) {
  const cx = narrative.cx_audit;
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Customer Experience Audit</Text>
      <Text style={styles.h2}>What customers see — and where it breaks</Text>
      <Text style={styles.source}>DataForSEO + Keepa listing signals</Text>
      <View style={styles.kpiRow}>
        <View style={styles.kpi}>
          <Text style={styles.kpiNum}>{cx.branded_search_volume != null ? volFmt(cx.branded_search_volume) : "—"}</Text>
          <Text style={styles.kpiLbl}>Branded searches/mo</Text>
        </View>
        <View style={styles.kpi}>
          <Text style={styles.kpiNum}>
            {cx.branded_trend_pct != null
              ? `${cx.branded_trend_pct > 0 ? "+" : ""}${cx.branded_trend_pct.toFixed(1)}%`
              : "—"}
          </Text>
          <Text style={styles.kpiLbl}>YoY trend</Text>
        </View>
        <View style={styles.kpi}>
          <Text style={styles.kpiNum}>{cx.asin_scores.length}</Text>
          <Text style={styles.kpiLbl}>Top ASINs scored</Text>
        </View>
      </View>
      {cx.top_keywords.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.h3}>Top non-branded keywords</Text>
          {cx.top_keywords.map((k, i) => (
            <Text key={i} style={[styles.body, { marginBottom: 2 }]}>
              {k.keyword}{"  "}
              <Text style={{ color: P.goldSoft }}>
                {k.search_volume != null ? `${volFmt(k.search_volume)}/mo` : "—"}
              </Text>
            </Text>
          ))}
        </View>
      )}
      {cx.asin_scores.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.h3}>Listing health (heuristic)</Text>
          {cx.asin_scores.map((a) => {
            const econParts: string[] = [];
            const units = unitsFmt(a.monthly_units, a.ttm_units);
            if (units !== "—") econParts.push(units);
            if (a.buy_box_price != null) econParts.push(`$${a.buy_box_price.toFixed(2)}`);
            if (a.ttm_revenue != null) econParts.push(`${moneyFmt(a.ttm_revenue)}/yr`);
            return (
              <View key={a.asin} style={{ marginBottom: 4 }}>
                <Text style={styles.body}>
                  <Text style={{ color: P.gold, fontFamily: "Helvetica-Bold" }}>{a.asin}</Text>
                  {"  "}
                  <Text style={{ color: P.gold }}>{a.score != null ? `${a.score}/100` : "—"}</Text>
                  {"  "}
                  {a.title?.slice(0, 70) ?? ""}
                </Text>
                {econParts.length > 0 && (
                  <Text style={[styles.small, { color: P.goldSoft }]}>
                    {econParts.join(" · ")}
                  </Text>
                )}
              </View>
            );
          })}
        </View>
      )}
      {cx.whats_broken.length > 0 && (
        <View style={[styles.card, { marginTop: 10 }]}>
          <Text style={styles.h3}>What&apos;s broken right now</Text>
          {cx.whats_broken.map((c, i) => (
            <Text key={i} style={[styles.body, { marginBottom: 4 }]}>• {c}</Text>
          ))}
        </View>
      )}
      {(cx.variation_disclosure?.has_variations === true ||
        cx.asin_scores.some((a) => (a.variation_group_size ?? 1) >= 2)) && (
        <View style={[styles.card, { marginTop: 10 }]}>
          <Text style={styles.h3}>Methodology · Variation handling</Text>
          <Text style={[styles.small, { lineHeight: 1.5 }]}>
            Some ASINs in this brand share a parent listing with sibling
            variations (e.g. a 4-pack and a 12-pack of the same product).
            Amazon&apos;s sales rank is often shared across variations, which
            causes raw third-party sales estimators to over-count sales on
            inactive variations. We attribute group-level sales to each
            variation using a combined signal: recent review activity
            (last 90 days) plus Buy Box win frequency (how often each
            variation actually held the Buy Box recently). When some
            siblings have Buy Box history and others don&apos;t, the
            absence of Buy Box activity is itself evidence the listing
            hasn&apos;t been selling — those variations correctly receive
            minimal attributed sales. These per-ASIN sales numbers are
            estimates derived from Keepa rank, review, and Buy Box data,
            not direct sales reporting.
          </Text>
        </View>
      )}
      <PageFooter label="CX Audit" />
    </Page>
  );
}

function CompetitorPage({ narrative }: { narrative: NarrativeV2 }) {
  const b = narrative.competitor_benchmark;
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Competitive Benchmark</Text>
      <Text style={styles.h2}>How you stack up on the same SERP</Text>
      <Text style={styles.source}>DataForSEO + Keepa</Text>
      <View style={styles.table}>
        <View style={[styles.tableRow, { backgroundColor: "#EFEBDF" }]}>
          <Text style={[styles.tableCell, styles.tableHead, { flex: 2 }]}>Brand</Text>
          <Text style={[styles.tableCell, styles.tableHead, { flex: 1 }]}># Sellers</Text>
          <Text style={[styles.tableCell, styles.tableHead, { flex: 1 }]}>Brand %</Text>
          <Text style={[styles.tableCell, styles.tableHead, { flex: 1 }]}>Branded vol</Text>
          <Text style={[styles.tableCell, styles.tableHead, { flex: 1 }]}>SERP rank</Text>
          <Text style={[styles.tableCell, styles.tableHead, { flex: 1 }]}>Listing</Text>
        </View>
        {b.rows.map((r, i) => (
          <View
            key={`${r.brand}-${i}`}
            style={[styles.tableRow, r.is_audited_brand ? { backgroundColor: "#F4ECD4" } : {}]}
          >
            <Text style={[styles.tableCell, { flex: 2 }]}>
              {r.brand}{r.is_audited_brand ? "  (You)" : ""}
            </Text>
            <Text style={[styles.tableCellNum, { flex: 1 }]}>{r.unique_seller_count != null ? String(r.unique_seller_count) : "—"}</Text>
            <Text style={[styles.tableCellNum, { flex: 1 }]}>{pctFmt(r.brand_controlled_pct)}</Text>
            <Text style={[styles.tableCellNum, { flex: 1 }]}>{volFmt(r.branded_search_volume)}</Text>
            <Text style={[styles.tableCellNum, { flex: 1 }]}>{r.organic_serp_rank != null ? `#${r.organic_serp_rank}` : "—"}</Text>
            <Text style={[styles.tableCellNum, { flex: 1 }]}>{r.listing_health != null ? `${r.listing_health}/100` : "—"}</Text>
          </View>
        ))}
      </View>
      {b.one_liner && <View style={styles.callout}><Text>{b.one_liner}</Text></View>}
      <PageFooter label="Competitive Benchmark" />
    </Page>
  );
}

function MathPage({ narrative }: { narrative: NarrativeV2 }) {
  const m = narrative.math;
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>The Math</Text>
      <Text style={styles.h2}>Every number, every assumption</Text>
      <Text style={styles.source}>Editable per deal</Text>
      <View style={styles.table}>
        <View style={[styles.tableRow, { backgroundColor: "#EFEBDF" }]}>
          <Text style={[styles.tableCell, styles.tableHead, { flex: 3 }]}>Line</Text>
          <Text style={[styles.tableCell, styles.tableHead, { flex: 1.2 }]}>Value</Text>
          <Text style={[styles.tableCell, styles.tableHead, { flex: 3 }]}>Source / Assumption</Text>
        </View>
        {m.lines.map((l) => (
          <View key={l.key} style={[styles.tableRow, l.is_total ? { backgroundColor: "#F4ECD4" } : {}]}>
            <Text style={[styles.tableCell, { flex: 3, fontFamily: l.is_total ? "Helvetica-Bold" : "Helvetica" }]}>
              {l.label}
              {l.badge === "actual" && " [Actual]"}
              {l.badge === "estimate" && " [Estimate]"}
              {l.badge === "confirmed" && " [Confirmed by user]"}
            </Text>
            <Text style={[styles.tableCellNum, { flex: 1.2, fontFamily: l.is_total ? "Helvetica-Bold" : "Helvetica" }]}>
              {l.value == null
                ? "— not measured"
                : l.format === "money"
                  ? `$${Math.round(Number(l.value)).toLocaleString("en-US")}`
                  : l.format === "percent"
                    ? `${(Number(l.value) * 100).toFixed(1)}%`
                    : String(l.value)}
            </Text>
            <Text style={[styles.tableCell, { flex: 3, color: P.muted, fontSize: 9 }]}>
              {l.source}
            </Text>
          </View>
        ))}
      </View>
      {m.notes && <View style={styles.callout}><Text>{m.notes}</Text></View>}
      <PageFooter label="The Math" />
    </Page>
  );
}

function PlanPage({ narrative }: { narrative: NarrativeV2 }) {
  const p = narrative.plan;
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>90-Day Takeover Plan</Text>
      <Text style={styles.h2}>How we run it</Text>
      {p.intro && <Text style={[styles.body, { marginBottom: 12 }]}>{p.intro}</Text>}
      <View style={styles.planRow}>
        {p.columns.map((col, i) => (
          <View key={i} style={styles.planCol}>
            <Text style={styles.planLabel}>{col.label}</Text>
            {col.bullets.map((b, j) => (
              <Text key={j} style={styles.planBullet}>• {b}</Text>
            ))}
          </View>
        ))}
      </View>
      <PageFooter label="90-Day Plan" />
    </Page>
  );
}

function WhyRcgPage({ narrative }: { narrative: NarrativeV2 }) {
  const w = narrative.why_rcg;
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Why RCG</Text>
      <Text style={styles.h2}>Operators, not consultants</Text>
      {paragraphs(w.bio).map((p, i) => (
        <Text key={i} style={styles.body}>{p}</Text>
      ))}
      {w.case_studies.map((c, i) => (
        <View key={i} style={styles.card}>
          <Text style={styles.h3}>{c.name}</Text>
          <Text style={[styles.body, { marginBottom: 4 }]}>{c.summary}</Text>
          <Text style={[styles.small, { color: P.gold, fontFamily: "Helvetica-Bold" }]}>{c.metric}</Text>
        </View>
      ))}
      <View style={styles.callout}>
        <Text style={[styles.eyebrow, { marginBottom: 4 }]}>Risk reversal</Text>
        <Text>{w.risk_reversal}</Text>
      </View>
      <PageFooter label="Why RCG" />
    </Page>
  );
}

function CtaPage({ narrative }: { narrative: NarrativeV2 }) {
  const c = narrative.cta;
  return (
    <Page size="LETTER" style={styles.page}>
      <Text style={styles.eyebrow}>Next Step</Text>
      <Text style={styles.h1}>{c.headline}</Text>
      <Text style={[styles.body, { marginBottom: 12 }]}>
        Reply to the email this audit came in on, or grab a slot directly.
      </Text>
      <Text style={[styles.body, { color: P.gold }]}>{c.secondary_email}</Text>
      {c.secondary_phone && <Text style={styles.body}>{c.secondary_phone}</Text>}
      {c.primary_cta_url && (
        <Text style={[styles.body, { color: P.gold, marginTop: 14 }]}>
          {c.primary_cta_label} → {c.primary_cta_url}
        </Text>
      )}
      <PageFooter label="Next Step" />
    </Page>
  );
}

// =====================================================================
// Document
// =====================================================================

function AuditV2Document({ narrative, brand }: { narrative: NarrativeV2; brand: BrandForReport }) {
  return (
    <Document>
      <CoverPage narrative={narrative} brand={brand} />
      <MethodologyPage narrative={narrative} brand={brand} />
      <ResellerRealityPage narrative={narrative} />
      <DossierPage narrative={narrative} />
      <CxAuditPage narrative={narrative} />
      <CompetitorPage narrative={narrative} />
      <MathPage narrative={narrative} />
      <PlanPage narrative={narrative} />
      <WhyRcgPage narrative={narrative} />
      <CtaPage narrative={narrative} />
    </Document>
  );
}

export async function renderAuditPdfV2({
  narrative,
  brand,
}: {
  narrative: NarrativeV2;
  brand: BrandForReport;
}): Promise<Buffer> {
  const buf = await renderToBuffer(<AuditV2Document narrative={narrative} brand={brand} />);
  return buf;
}
