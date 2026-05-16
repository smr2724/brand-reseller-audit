import { COST_BASIS_LINES } from "@/lib/cost/constants";

/**
 * Phase 75 — Ranked bulk-run report.
 *
 * Produces the HTML/text body for the internal summary email sent to
 * steve@rollemanagementgroup.com when a bulk run finishes, plus the
 * same shape consumed by the in-app ranked table. All styling is
 * inline so it survives every email client.
 *
 * NB: STEVE_CC is reserved for client-facing report emails — Steve is
 * the `to:` here, NOT the `cc:`. Do not add STEVE_CC.
 */

export interface BulkReportBrand {
  position: number;
  input_name: string;
  brand_id: string | null;
  status: string;
  qualified: boolean | null;
  disqualification_reason: string | null;
  selected_entity_name: string | null;
  resolved_owner_domain: string | null;
  contact_name: string | null;
  contact_email: string | null;
  email_verifier: string | null;
  email_status: string | null;
  outlook_draft_id: string | null;
  outlook_draft_web_link: string | null;
  brand_seven_x_value: number | null;
  legion_opportunity: number | null;
  economics_status: "healthy" | "low_revenue" | "tight_channel" | null;
  error_step: string | null;
  error_message: string | null;
  // Phase 81 — per-brand cost rollup populated by trackCost(). Optional
  // for back-compat with legacy rows / unit tests that don't set it.
  cost_total_usd?: number | null;
  cost_breakdown?: Record<string, number> | null;
}

function economicsBadge(
  status: BulkReportBrand["economics_status"],
): { label: string; bg: string; color: string } | null {
  if (status === "low_revenue") return { label: "Low Revenue", bg: "#eaeaea", color: "#555" };
  if (status === "tight_channel") return { label: "Tight Channel", bg: "#eaeaea", color: "#555" };
  return null;
}

export interface BulkReportInput {
  runId: string;
  totalBrands: number;
  startedAt: string | null;
  completedAt: string | null;
  appBaseUrl: string;
  brands: BulkReportBrand[];
  // Phase 81 — run-level total cost. Optional so legacy callers keep
  // working; renderer defaults to summing per-brand costs when absent.
  runCostTotalUsd?: number | null;
}

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (Math.abs(v) >= 1_000_000) {
    return `$${(v / 1_000_000).toFixed(2)}M`;
  }
  if (Math.abs(v) >= 1_000) {
    return `$${Math.round(v / 1_000).toLocaleString()}K`;
  }
  return `$${Math.round(v).toLocaleString()}`;
}

function fmtScore(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return fmtMoney(Number(n));
}

// Phase 81 — dollar formatter for tracked API costs. Per spec:
// 4 decimal places under $1, 2 decimals at $1+ — the typical per-brand
// cost is a few cents and `$0.0014` reads more honestly than `$0.00`.
function fmtCost(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "$0.0000";
  if (Math.abs(v) < 1) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

// Providers we render columns for, in display order. Per-brand outreach
// drafts use Microsoft Graph (free under M365), not Resend — so Resend
// is omitted here. It still appears in the run total via the summary
// email send (bulkRunBrandId=null).
const COST_PROVIDER_COLUMNS: { key: string; label: string }[] = [
  { key: "keepa", label: "Keepa" },
  { key: "apollo", label: "Apollo" },
  { key: "hunter", label: "Hunter" },
  { key: "million_verifier", label: "MV" },
  { key: "openai", label: "OpenAI" },
];

export function statusBadge(b: BulkReportBrand): {
  label: string;
  color: string;
  bg: string;
} {
  if (b.status === "completed" && b.qualified && b.outlook_draft_id) {
    return { label: "Draft Created", color: "#0a6b2f", bg: "#dcf5e3" };
  }
  if (b.status === "completed" && b.qualified) {
    return { label: "Qualified — No Contact", color: "#8a6a00", bg: "#fff4cc" };
  }
  if (b.status === "disqualified") {
    return {
      label: `Disqualified${b.disqualification_reason ? ` (${b.disqualification_reason})` : ""}`,
      color: "#555",
      bg: "#eaeaea",
    };
  }
  if (b.status === "keepa_not_found") {
    return { label: "Not Found on Keepa", color: "#555", bg: "#eaeaea" };
  }
  if (b.status === "error") {
    return {
      label: `Error: ${b.error_step ?? "unknown"}`,
      color: "#a02020",
      bg: "#ffe1e1",
    };
  }
  return { label: b.status, color: "#555", bg: "#eaeaea" };
}

/**
 * Sort: qualified-with-draft first, qualified-no-contact next,
 * disqualified/not-found/error last. Within each tier, descending by
 * brand_seven_x_value (nulls last).
 */
export function rankBrands(brands: BulkReportBrand[]): BulkReportBrand[] {
  function tier(b: BulkReportBrand): number {
    if (b.status === "completed" && b.qualified && b.outlook_draft_id) return 0;
    if (b.status === "completed" && b.qualified) return 1;
    if (b.status === "disqualified") return 2;
    if (b.status === "keepa_not_found") return 3;
    if (b.status === "error") return 4;
    return 5;
  }
  return [...brands].sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    const sa = a.brand_seven_x_value == null ? -Infinity : Number(a.brand_seven_x_value);
    const sb = b.brand_seven_x_value == null ? -Infinity : Number(b.brand_seven_x_value);
    if (sb !== sa) return sb - sa;
    return a.position - b.position;
  });
}

export function renderBulkRunReportHtml(input: BulkReportInput): {
  subject: string;
  html: string;
  text: string;
} {
  const ranked = rankBrands(input.brands);
  const total = input.totalBrands;
  const completedCount = ranked.filter((b) => b.status === "completed").length;
  const draftCount = ranked.filter((b) => b.outlook_draft_id).length;
  const disqualifiedCount = ranked.filter((b) => b.status === "disqualified").length;
  const notFoundCount = ranked.filter((b) => b.status === "keepa_not_found").length;
  const errorCount = ranked.filter((b) => b.status === "error").length;

  const reportUrl = `${input.appBaseUrl.replace(/\/+$/, "")}/bulk/${input.runId}`;

  const headerCellStyle =
    'padding:8px 10px;text-align:left;border-bottom:2px solid #ccc;font-size:12px;color:#555;text-transform:uppercase;letter-spacing:0.04em;';
  const cellStyle =
    'padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top;';

  const rowsHtml = ranked
    .map((b, idx) => {
      const badge = statusBadge(b);
      const draftCell = b.outlook_draft_id
        ? b.outlook_draft_web_link
          ? `<a href="${escapeHtml(b.outlook_draft_web_link)}" style="color:#1a55a3;text-decoration:underline;">Open</a>`
          : "Created"
        : "—";
      const eb = economicsBadge(b.economics_status);
      const economicsBadgeHtml = eb
        ? ` <span style="display:inline-block;background:${eb.bg};color:${eb.color};padding:1px 6px;font-size:10px;border-radius:3px;vertical-align:middle;margin-left:4px;">${escapeHtml(eb.label)}</span>`
        : "";
      return `<tr>
        <td style="${cellStyle}">${idx + 1}</td>
        <td style="${cellStyle}"><strong>${escapeHtml(b.input_name)}</strong>${economicsBadgeHtml}${
          b.selected_entity_name && b.selected_entity_name !== b.input_name
            ? `<br/><span style="color:#888;font-size:11px;">${escapeHtml(b.selected_entity_name)}</span>`
            : ""
        }</td>
        <td style="${cellStyle}"><span style="display:inline-block;background:${badge.bg};color:${badge.color};padding:3px 8px;font-size:11px;border-radius:3px;">${escapeHtml(badge.label)}</span></td>
        <td style="${cellStyle}">${b.qualified == null ? "—" : b.qualified ? "Yes" : "No"}</td>
        <td style="${cellStyle}">${escapeHtml(b.resolved_owner_domain ?? "—")}</td>
        <td style="${cellStyle}">${escapeHtml(b.contact_name ?? "—")}</td>
        <td style="${cellStyle}">${escapeHtml(b.contact_email ?? "—")}</td>
        <td style="${cellStyle}">${escapeHtml(b.email_verifier ?? "—")}</td>
        <td style="${cellStyle}">${draftCell}</td>
        <td style="${cellStyle};text-align:right;">${fmtScore(b.brand_seven_x_value)}</td>
        <td style="${cellStyle};text-align:right;">${fmtMoney(b.legion_opportunity)}</td>
      </tr>`;
    })
    .join("");

  // Phase 81 — cost breakdown rows + run total. The aggregate falls back
  // to summing per-brand costs when `runCostTotalUsd` isn't supplied
  // (e.g. legacy callers / tests).
  const perBrandTotals = ranked.map((b) => Number(b.cost_total_usd ?? 0) || 0);
  const summedBrandTotal = perBrandTotals.reduce((s, v) => s + v, 0);
  const runCostTotal =
    typeof input.runCostTotalUsd === "number" &&
    Number.isFinite(input.runCostTotalUsd)
      ? input.runCostTotalUsd
      : summedBrandTotal;

  const costRowsHtml = ranked
    .map((b) => {
      const breakdown = (b.cost_breakdown ?? {}) as Record<string, number>;
      const cells = COST_PROVIDER_COLUMNS.map(
        (p) =>
          `<td style="${cellStyle};text-align:right;">${fmtCost(Number(breakdown[p.key] ?? 0) || 0)}</td>`,
      ).join("");
      return `<tr>
        <td style="${cellStyle}">${escapeHtml(b.input_name)}</td>
        ${cells}
        <td style="${cellStyle};text-align:right;"><strong>${fmtCost(Number(b.cost_total_usd ?? 0) || 0)}</strong></td>
      </tr>`;
    })
    .join("");

  const costBasisHtml = COST_BASIS_LINES
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("");

  const costSectionHtml = `
      <h2 style="font-size:16px;margin:32px 0 6px;font-weight:500;letter-spacing:-0.005em;">Run cost breakdown</h2>
      <p style="margin:0 0 12px;color:#555;font-size:12px;">All values in USD. Per-brand costs are observed at call time using the unit prices in the legend below.</p>
      <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin-bottom:8px;">
        <thead>
          <tr>
            <th style="${headerCellStyle}">Brand</th>
            ${COST_PROVIDER_COLUMNS.map((p) => `<th style="${headerCellStyle};text-align:right;">${escapeHtml(p.label)}</th>`).join("")}
            <th style="${headerCellStyle};text-align:right;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${costRowsHtml}
          <tr>
            <td style="${cellStyle};text-align:right;font-weight:600;" colspan="${COST_PROVIDER_COLUMNS.length + 1}">Run total:</td>
            <td style="${cellStyle};text-align:right;font-weight:600;">${fmtCost(runCostTotal)}</td>
          </tr>
        </tbody>
      </table>
      <p style="margin:8px 0 4px;color:#555;font-size:12px;font-weight:600;">Cost basis (per call, USD):</p>
      <ul style="margin:0;padding:0 0 0 20px;color:#555;font-size:12px;line-height:1.6;">${costBasisHtml}</ul>
  `;

  const subject = `Bulk Brand Run Complete — ${total} brand${total === 1 ? "" : "s"} processed`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f7f6f3;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <div style="max-width:1040px;margin:0 auto;padding:24px 16px;">
    <div style="background:#fff;border:1px solid #e5e1d8;padding:24px;">
      <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#7a6a4f;margin-bottom:6px;">Rolle Consulting Group</div>
      <h1 style="font-size:22px;margin:0 0 6px;font-weight:500;">Bulk brand run complete</h1>
      <p style="margin:0 0 18px;color:#555;font-size:13px;">
        ${total} brand${total === 1 ? "" : "s"} processed —
        ${completedCount} completed,
        ${draftCount} draft${draftCount === 1 ? "" : "s"} created,
        ${disqualifiedCount} disqualified,
        ${notFoundCount} not found on Keepa,
        ${errorCount} error${errorCount === 1 ? "" : "s"}.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${escapeHtml(reportUrl)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:10px 18px;font-size:13px;letter-spacing:0.04em;">Open run in dashboard</a>
      </p>

      <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th style="${headerCellStyle}">#</th>
            <th style="${headerCellStyle}">Brand</th>
            <th style="${headerCellStyle}">Status</th>
            <th style="${headerCellStyle}">Qualified</th>
            <th style="${headerCellStyle}">Owner</th>
            <th style="${headerCellStyle}">Contact</th>
            <th style="${headerCellStyle}">Email</th>
            <th style="${headerCellStyle}">Verifier</th>
            <th style="${headerCellStyle}">Draft</th>
            <th style="${headerCellStyle};text-align:right;">7x Opportunity ($)</th>
            <th style="${headerCellStyle};text-align:right;">Opportunity ($)</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>

      ${costSectionHtml}

      <p style="margin:24px 0 0;color:#888;font-size:11px;">
        Run id: ${escapeHtml(input.runId)} · started ${escapeHtml(input.startedAt ?? "")} · completed ${escapeHtml(input.completedAt ?? "")}
      </p>
    </div>
  </div>
</body></html>`;

  const textLines: string[] = [];
  textLines.push(`Bulk brand run complete — ${total} brands processed.`);
  textLines.push(
    `${completedCount} completed, ${draftCount} drafts created, ${disqualifiedCount} disqualified, ${notFoundCount} not found, ${errorCount} errors.`,
  );
  textLines.push(`Open: ${reportUrl}`);
  textLines.push("");
  for (let i = 0; i < ranked.length; i++) {
    const b = ranked[i];
    const badge = statusBadge(b);
    textLines.push(
      `${i + 1}. ${b.input_name} — ${badge.label}` +
        (b.contact_email ? ` — ${b.contact_email}` : "") +
        (b.legion_opportunity != null ? ` — opp ${fmtMoney(b.legion_opportunity)}` : ""),
    );
  }
  // Phase 81 — cost summary in the plain-text body so terminal clients
  // still see the breakdown legend.
  textLines.push("");
  textLines.push(`RUN COST BREAKDOWN (run total: ${fmtCost(runCostTotal)})`);
  for (const b of ranked) {
    const breakdown = (b.cost_breakdown ?? {}) as Record<string, number>;
    const parts = COST_PROVIDER_COLUMNS.map(
      (p) => `${p.label} ${fmtCost(Number(breakdown[p.key] ?? 0) || 0)}`,
    );
    textLines.push(
      `${b.input_name}: ${parts.join(", ")} — Total ${fmtCost(Number(b.cost_total_usd ?? 0) || 0)}`,
    );
  }
  textLines.push("");
  textLines.push("Cost basis (per call, USD):");
  for (const line of COST_BASIS_LINES) textLines.push(`- ${line}`);

  return { subject, html, text: textLines.join("\n") };
}
