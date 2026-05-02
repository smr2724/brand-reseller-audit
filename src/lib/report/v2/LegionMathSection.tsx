/**
 * Math framework v4 — interactive Section 5 ("The Math").
 *
 * Two-tier disclosure:
 *   Tier 1 — 5 hero stat cards (Revenue · Current Profit · Reseller
 *            Margin Captured · New Profit · Δ + 7× exit lift).
 *   Tier 2 — "Show full math ↓" reveals the 11-row table and the
 *            editable input panel.
 *
 * Editable inputs live client-side in localStorage keyed by the report
 * token. Recompute is fully local — `computeLegionEconomics()` is the
 * single source of truth. The DB is never touched unless the prospect
 * explicitly hits "Save these assumptions" (not implemented here; out
 * of scope for the prospect-facing read flow).
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  computeLegionEconomics,
  defaultLegionInputs,
  normalizePercent,
  type LegionInputs,
  type LegionOutputs,
  type OutboundShippingPayer,
} from "@/lib/math/legion-economics";

export interface LegionMathSectionProps {
  reportToken: string;
  initialRevenue: number | null;
  initialAssumptions: LegionAssumptions;
  /** Source string for the revenue line (e.g. "Keepa, 2026-04-15"). */
  revenueSource: string;
  /** Optional badge on the revenue value. */
  revenueBadge: "actual" | "estimate" | null;
  /** Footnote when revenue came from the estimator. */
  revenueFootnote: string | null;
  /** LLM-generated math notes from assemble.ts. */
  notes: string | null;
}

/** Subset of `ReportAssumptions` actually used by the math (everything
 *  except the per-row format hints). Mirrors `LegionInputs` minus
 *  `revenue`. */
export interface LegionAssumptions {
  reseller_markup_pct: number;
  outbound_shipping_pct: number;
  outbound_shipping_payer: OutboundShippingPayer;
  reseller_net_margin_pct: number;
  current_profit_margin_pct: number;
  ebitda_multiple: number;
  labor_cost_override: number | null;
}

const STORAGE_PREFIX = "rmg_legion_v4:";

interface PersistedState {
  revenue: number | null;
  assumptions: LegionAssumptions;
}

export function LegionMathSection(props: LegionMathSectionProps) {
  const storageKey = `${STORAGE_PREFIX}${props.reportToken}`;

  const [revenue, setRevenue] = useState<number | null>(props.initialRevenue);
  const [assumptions, setAssumptions] = useState<LegionAssumptions>(props.initialAssumptions);
  const [showFullMath, setShowFullMath] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  // Track edited fields purely for UI affordance (label badge); state is
  // entirely local and stored in localStorage.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // On mount: hydrate from localStorage if present (overrides server-supplied
  // initials so a returning visitor sees their tweaks).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedState;
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.revenue === "number" || parsed.revenue === null) {
            setRevenue(parsed.revenue);
          }
          if (parsed.assumptions) {
            setAssumptions((prev) => ({ ...prev, ...parsed.assumptions }));
          }
        }
      }
    } catch {
      /* ignore corrupted storage */
    }
    setHydrated(true);
  }, [storageKey]);

  // Persist on change (debounced) — only after first hydration so we
  // don't overwrite saved state with the server's defaults.
  useEffect(() => {
    if (!hydrated) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      try {
        const state: PersistedState = { revenue, assumptions };
        window.localStorage.setItem(storageKey, JSON.stringify(state));
      } catch {
        /* quota / private mode */
      }
    }, 150);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [revenue, assumptions, hydrated, storageKey]);

  const out: LegionOutputs = useMemo(() => {
    const inputs: LegionInputs = {
      revenue: revenue ?? 0,
      reseller_markup_pct: assumptions.reseller_markup_pct,
      outbound_shipping_pct: assumptions.outbound_shipping_pct,
      outbound_shipping_payer: assumptions.outbound_shipping_payer,
      reseller_net_margin_pct: assumptions.reseller_net_margin_pct,
      current_profit_margin_pct: assumptions.current_profit_margin_pct,
      ebitda_multiple: assumptions.ebitda_multiple,
      labor_cost_override: assumptions.labor_cost_override,
    };
    return computeLegionEconomics(inputs);
  }, [revenue, assumptions]);

  const haveRevenue = revenue != null && revenue > 0;
  const v = (n: number): number | null => (haveRevenue ? n : null);

  const resetAll = () => {
    setRevenue(props.initialRevenue);
    setAssumptions(props.initialAssumptions);
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  };

  return (
    <section id="s-math" className="rv2-section">
      <div className="rv2-section-head">
        <div className="rv2-eyebrow">The Math</div>
        <h2 className="rv2-h2">Every number, every assumption</h2>
        <div className="rv2-source">Editable per deal · saved on this device</div>
      </div>

      {/* Tier 1 — five hero stat cards. */}
      <div className="rv4-tier1">
        <HeroStat
          label="Annual Amazon revenue"
          value={revenue}
          badge={props.revenueBadge}
          source={props.revenueSource}
        />
        <HeroStat
          label="Current manufacturer profit"
          value={v(out.current_profit)}
          source="20% × effective wholesale (today)"
        />
        <HeroStat
          label="Reseller margin captured (recoverable)"
          value={v(out.reseller_margin_captured)}
          source={`${pct(assumptions.reseller_net_margin_pct, 1)} × revenue`}
          accent
        />
        <HeroStat
          label="New profit (brand-direct)"
          value={v(out.new_profit)}
          source="current + reseller + recouped − labor"
        />
        <div className="rv4-tier1-pair">
          <HeroStat
            label="Δ Additional profit / yr"
            value={v(out.delta_profit)}
            source="new − current"
            big
          />
          <HeroStat
            label={`${assumptions.ebitda_multiple}× EBITDA exit-value lift`}
            value={v(out.exit_lift)}
            source={`${assumptions.ebitda_multiple}× × Δ profit`}
            big
          />
        </div>
      </div>

      <div className="rv4-toggle-wrap">
        <button
          type="button"
          className="rv4-toggle"
          aria-expanded={showFullMath}
          onClick={() => setShowFullMath((s) => !s)}
        >
          {showFullMath ? "Hide full math ↑" : "Show full math ↓"}
        </button>
      </div>

      {showFullMath && (
        <div className="rv4-tier2">
          <div className="rv4-tier2-grid">
            <div className="rv4-tier2-table">
              <FullMathTable
                revenue={revenue}
                out={out}
                assumptions={assumptions}
                revenueSource={props.revenueSource}
                revenueBadge={props.revenueBadge}
              />
              {props.notes && <p className="rv2-prose rv2-prose-callout">{props.notes}</p>}
              {props.revenueFootnote && (
                <p className="rv2-muted-small rv4-footnote">{props.revenueFootnote}</p>
              )}
            </div>

            <div className="rv4-tier2-inputs">
              <InputPanel
                revenue={revenue}
                setRevenue={setRevenue}
                assumptions={assumptions}
                setAssumptions={setAssumptions}
                onReset={resetAll}
                computedLabor={out.labor_cost}
              />
            </div>
          </div>
        </div>
      )}

      <LegionMathStyles />
    </section>
  );
}

// ====================================================================
// Tier 1 hero stat cards
// ====================================================================

function HeroStat({
  label,
  value,
  source,
  badge,
  accent,
  big,
}: {
  label: string;
  value: number | null;
  source: string;
  badge?: "actual" | "estimate" | null;
  accent?: boolean;
  big?: boolean;
}) {
  return (
    <div className={`rv4-hero${accent ? " rv4-hero-accent" : ""}${big ? " rv4-hero-big" : ""}`}>
      <div className="rv4-hero-label">
        {label}
        {badge === "actual" && (
          <span className="rv2-rev-badge rv2-rev-badge-actual">Actual</span>
        )}
        {badge === "estimate" && (
          <span className="rv2-rev-badge rv2-rev-badge-est">Estimate</span>
        )}
      </div>
      <div className="rv4-hero-value">{value != null ? money(value) : "— not measured"}</div>
      <div className="rv4-hero-source">{source}</div>
    </div>
  );
}

// ====================================================================
// Tier 2 full 11-row table
// ====================================================================

function FullMathTable({
  revenue,
  out,
  assumptions,
  revenueSource,
  revenueBadge,
}: {
  revenue: number | null;
  out: LegionOutputs;
  assumptions: LegionAssumptions;
  revenueSource: string;
  revenueBadge: "actual" | "estimate" | null;
}) {
  const haveRev = revenue != null && revenue > 0;
  const v = (n: number) => (haveRev ? n : null);
  const payerSource =
    assumptions.outbound_shipping_payer === "reseller"
      ? "Brand pays: NO (not recoupable)"
      : assumptions.outbound_shipping_payer === "unknown"
        ? "Brand pays: unknown — assumed YES"
        : "Brand pays: YES (recoupable)";

  const rows: { key: string; label: string; value: number | null; source: string; format: "money" | "percent"; total?: boolean; badge?: "actual" | "estimate" | null }[] = [
    { key: "revenue", label: "Trailing 12mo Amazon revenue", value: revenue, source: revenueSource, format: "money", badge: revenueBadge },
    { key: "wholesale_invoice", label: "Wholesale invoice (manuf → reseller)", value: v(out.wholesale_invoice), source: `revenue ÷ (1 + ${pct(assumptions.reseller_markup_pct, 0)} markup)`, format: "money" },
    { key: "wholesale_outbound_shipping", label: "Wholesale outbound shipping", value: v(out.wholesale_outbound_shipping), source: `${pct(assumptions.outbound_shipping_pct, 1)} × wholesale invoice`, format: "money" },
    { key: "effective_markup_pct", label: "Effective markup % (incl. shipping)", value: v(out.effective_markup_pct), source: "revenue ÷ (wholesale − shipping) − 1", format: "percent" },
    { key: "effective_wholesale", label: "Effective wholesale price (COGS)", value: v(out.effective_wholesale), source: "wholesale invoice − outbound shipping", format: "money" },
    { key: "current_profit", label: "Current manufacturer profit", value: v(out.current_profit), source: `${pct(assumptions.current_profit_margin_pct, 0)} × effective wholesale`, format: "money" },
    { key: "reseller_margin", label: "Reseller net margin captured (recoverable)", value: v(out.reseller_margin_captured), source: `${pct(assumptions.reseller_net_margin_pct, 1)} × revenue`, format: "money" },
    { key: "recouped_shipping", label: "Recouped outbound shipping", value: v(out.recouped_shipping), source: payerSource, format: "money" },
    { key: "labor_cost", label: "Labor cost (in-house Amazon team)", value: haveRev ? -Math.abs(out.labor_cost) : null, source: laborSource(out.labor_tier, assumptions.labor_cost_override), format: "money" },
    { key: "new_profit", label: "New profit (under brand-direct model)", value: v(out.new_profit), source: "current + reseller + recouped − labor", format: "money" },
    { key: "delta_profit", label: "Δ Additional profit per year", value: v(out.delta_profit), source: "new profit − current profit", format: "money", total: true },
    { key: "exit_lift", label: `${assumptions.ebitda_multiple}× EBITDA exit-value lift`, value: v(out.exit_lift), source: `${assumptions.ebitda_multiple}× × Δ profit`, format: "money", total: true },
  ];

  return (
    <div className="rv2-table-wrap">
      <table className="rv2-table rv2-math-table">
        <thead>
          <tr>
            <th>Line</th>
            <th>Value</th>
            <th>Source / Assumption</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.total ? "rv2-math-total" : ""}>
              <td>
                {r.label}
                {r.badge === "actual" && <span className="rv2-rev-badge rv2-rev-badge-actual">Actual</span>}
                {r.badge === "estimate" && <span className="rv2-rev-badge rv2-rev-badge-est">Estimate</span>}
              </td>
              <td className="rv2-num">{formatCell(r.value, r.format)}</td>
              <td>
                <span className="rv2-muted-small">{r.source}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ====================================================================
// Editable input panel
// ====================================================================

const HELP: Record<string, string> = {
  revenue:
    "The seller's trailing twelve-month Amazon revenue. Replace with the real SP-API or invoice number once verified — the estimate is directional only.",
  reseller_markup_pct:
    "Compare the price your reseller currently charges on Amazon to the wholesale price you invoice them. The difference, as a percentage, is the reseller's markup. For example: invoice $25, sells on Amazon for $50 = 100% markup.",
  outbound_shipping_pct:
    "Outbound freight cost from manufacturer to the reseller, as a % of the wholesale invoice. ~5% is a common ballpark for case-pack ground shipments.",
  outbound_shipping_payer:
    "Who covers outbound freight today? If your invoice is FOB-destination, you pay (recoverable). If FOB-origin, the reseller pays (not recoverable).",
  reseller_net_margin_pct:
    "Reseller's net profit after Amazon referral fees, FBA, advertising, returns, and inbound shipping (~3%). 10.5% is the consolidated default.",
  current_profit_margin_pct:
    "Your current manufacturing profit margin on the wholesale leg, as a % of effective wholesale (cost-of-goods-equivalent).",
  ebitda_multiple:
    "Multiple applied to incremental annual EBITDA to estimate enterprise-value lift. 7× is mid-market default; private equity often runs 6×–10×.",
  labor_cost_override:
    "Optional override for the in-house Amazon team cost. Leave blank to use the tier rule (under $2M → $30k, $2–10M → $130k, $10M+ → $250k).",
};

function InputPanel({
  revenue,
  setRevenue,
  assumptions,
  setAssumptions,
  onReset,
  computedLabor,
}: {
  revenue: number | null;
  setRevenue: (n: number | null) => void;
  assumptions: LegionAssumptions;
  setAssumptions: (a: LegionAssumptions) => void;
  onReset: () => void;
  computedLabor: number;
}) {
  const setA = (patch: Partial<LegionAssumptions>) =>
    setAssumptions({ ...assumptions, ...patch });

  return (
    <div className="rv4-input-panel">
      <div className="rv4-input-head">
        <div className="rv4-input-title">Adjust assumptions</div>
        <button type="button" className="rv4-reset" onClick={onReset}>
          Reset to defaults
        </button>
      </div>
      <div className="rv4-input-sub">
        Live recompute. Saved on this device only — no server round-trip.
      </div>

      <Accordion
        id="revenue"
        label="Trailing 12mo revenue"
        help={HELP.revenue}
        value={revenue != null ? money(revenue) : "— not measured"}
      >
        <DollarInput
          value={revenue}
          onChange={setRevenue}
          placeholder="$1,048,539"
        />
      </Accordion>

      <Accordion
        id="reseller_markup_pct"
        label="Reseller's markup"
        help={HELP.reseller_markup_pct}
        value={pct(assumptions.reseller_markup_pct, 0)}
      >
        <PercentInput
          value={assumptions.reseller_markup_pct}
          onChange={(n) => setA({ reseller_markup_pct: n })}
          max={5}
          placeholder="103%"
        />
      </Accordion>

      <Accordion
        id="outbound_shipping_pct"
        label="Outbound shipping % (manuf → reseller)"
        help={HELP.outbound_shipping_pct}
        value={pct(assumptions.outbound_shipping_pct, 1)}
      >
        <PercentInput
          value={assumptions.outbound_shipping_pct}
          onChange={(n) => setA({ outbound_shipping_pct: n })}
          max={0.25}
          placeholder="5%"
        />
      </Accordion>

      <Accordion
        id="outbound_shipping_payer"
        label="Who pays outbound shipping today?"
        help={HELP.outbound_shipping_payer}
        value={
          assumptions.outbound_shipping_payer === "brand"
            ? "Brand pays"
            : assumptions.outbound_shipping_payer === "reseller"
              ? "Reseller pays"
              : "Unknown"
        }
      >
        <Segmented
          value={assumptions.outbound_shipping_payer}
          onChange={(v) =>
            setA({ outbound_shipping_payer: v as OutboundShippingPayer })
          }
          options={[
            { value: "brand", label: "Brand pays" },
            { value: "reseller", label: "Reseller pays" },
            { value: "unknown", label: "Unknown" },
          ]}
        />
        {assumptions.outbound_shipping_payer === "unknown" && (
          <div className="rv4-caveat">
            Assuming brand pays — toggle if your reseller absorbs this cost.
          </div>
        )}
      </Accordion>

      <Accordion
        id="reseller_net_margin_pct"
        label="Reseller net margin"
        help={HELP.reseller_net_margin_pct}
        value={pct(assumptions.reseller_net_margin_pct, 1)}
      >
        <PercentInput
          value={assumptions.reseller_net_margin_pct}
          onChange={(n) => setA({ reseller_net_margin_pct: n })}
          max={0.30}
          placeholder="10.5%"
        />
      </Accordion>

      <Accordion
        id="current_profit_margin_pct"
        label="Current profit margin"
        help={HELP.current_profit_margin_pct}
        value={pct(assumptions.current_profit_margin_pct, 0)}
      >
        <PercentInput
          value={assumptions.current_profit_margin_pct}
          onChange={(n) => setA({ current_profit_margin_pct: n })}
          max={0.60}
          placeholder="20%"
        />
      </Accordion>

      <Accordion
        id="ebitda_multiple"
        label="Exit multiple (EBITDA)"
        help={HELP.ebitda_multiple}
        value={`${assumptions.ebitda_multiple}×`}
      >
        <NumberInput
          value={assumptions.ebitda_multiple}
          onChange={(n) => setA({ ebitda_multiple: n })}
          min={3}
          max={15}
          step={0.5}
          placeholder="7"
        />
      </Accordion>

      <Accordion
        id="labor_cost_override"
        label="Labor cost (optional override)"
        help={HELP.labor_cost_override}
        value={
          assumptions.labor_cost_override != null
            ? money(assumptions.labor_cost_override)
            : `tier: ${money(computedLabor)}`
        }
      >
        <DollarInput
          value={assumptions.labor_cost_override}
          onChange={(n) => setA({ labor_cost_override: n })}
          placeholder={`tier default: ${money(computedLabor)}`}
        />
      </Accordion>
    </div>
  );
}

function Accordion({
  id,
  label,
  help,
  value,
  children,
}: {
  id: string;
  label: string;
  help: string;
  value: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <div className={`rv4-acc${open ? " rv4-acc-open" : ""}`}>
      <button
        type="button"
        className="rv4-acc-head"
        aria-expanded={open}
        aria-controls={`rv4-acc-body-${id}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="rv4-acc-label">
          {label}
          <button
            type="button"
            className="rv4-info"
            aria-label={`Help for ${label}`}
            onClick={(e) => {
              e.stopPropagation();
              setHelpOpen((h) => !h);
            }}
          >
            i
          </button>
        </span>
        <span className="rv4-acc-val">{value}</span>
        <span className="rv4-acc-chev" aria-hidden>
          ▾
        </span>
      </button>
      {helpOpen && <div className="rv4-help" role="note">{help}</div>}
      {open && (
        <div className="rv4-acc-body" id={`rv4-acc-body-${id}`}>
          {children}
        </div>
      )}
    </div>
  );
}

function DollarInput({
  value,
  onChange,
  placeholder,
}: {
  value: number | null;
  onChange: (n: number | null) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(value != null ? String(value) : "");
  useEffect(() => {
    setText(value != null ? String(value) : "");
  }, [value]);
  return (
    <input
      type="text"
      inputMode="decimal"
      className="rv4-input"
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const cleaned = e.target.value.replace(/[$,\s]/g, "").trim();
        if (cleaned === "") {
          onChange(null);
        } else {
          const n = Number(cleaned);
          if (Number.isFinite(n)) onChange(n);
        }
      }}
    />
  );
}

function PercentInput({
  value,
  onChange,
  max,
  placeholder,
}: {
  value: number;
  onChange: (n: number) => void;
  max: number;
  placeholder?: string;
}) {
  // Display in the same form the user typed (% form preferred). Keep an
  // editable text buffer so partial input ("0.10") doesn't clobber.
  const display = (n: number): string => {
    const pctValue = n * 100;
    return Number.isInteger(pctValue) ? `${pctValue}%` : `${pctValue.toFixed(2)}%`;
  };
  const [text, setText] = useState(display(value));
  useEffect(() => {
    setText(display(value));
  }, [value]);
  return (
    <input
      type="text"
      inputMode="decimal"
      className="rv4-input"
      placeholder={placeholder}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const n = normalizePercent(text);
        const clamped = Math.max(0, Math.min(max, n));
        onChange(clamped);
        setText(display(clamped));
      }}
    />
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
}: {
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step: number;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      className="rv4-input"
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) {
          onChange(Math.max(min, Math.min(max, n)));
        }
      }}
    />
  );
}

function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="rv4-seg" role="radiogroup">
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          className={`rv4-seg-btn${value === o.value ? " rv4-seg-on" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ====================================================================
// Helpers
// ====================================================================

function money(n: number | null | undefined): string {
  if (n == null) return "— not measured";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(Math.round(Number(n)));
  return `${sign}$${abs.toLocaleString("en-US")}`;
}

function pct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

function formatCell(value: number | null, format: "money" | "percent"): string {
  if (value == null) return "— not measured";
  if (format === "money") return money(value);
  return pct(value, 1);
}

function laborSource(
  tier: "under_2m" | "2m_to_10m" | "over_10m",
  override: number | null,
): string {
  if (override != null) return "Override: in-house team cost (annual)";
  if (tier === "under_2m") return "Tier: revenue < $2M → $30,000/yr";
  if (tier === "2m_to_10m") return "Tier: $2M ≤ revenue < $10M → $130,000/yr";
  return "Tier: revenue ≥ $10M → $250,000/yr";
}

// ====================================================================
// Styles — extends the v2 dark theme for the new tier-1/tier-2 surface
// ====================================================================

function LegionMathStyles() {
  return (
    <style>{`
      .rv4-tier1 {
        display: grid; gap: 14px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        margin: 8px 0 28px;
      }
      .rv4-tier1-pair {
        grid-column: 1 / -1;
        display: grid; gap: 14px;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      }
      .rv4-hero {
        padding: 18px 18px 16px; border-radius: 12px;
        border: 1px solid var(--border-soft);
        background: rgba(255,255,255,0.02);
      }
      .rv4-hero-accent {
        background: linear-gradient(180deg, rgba(201,169,106,0.10), rgba(201,169,106,0.03));
        border-color: rgba(201,169,106,0.28);
      }
      .rv4-hero-big { background: rgba(201,169,106,0.08); border-color: rgba(201,169,106,0.32); }
      .rv4-hero-label {
        font-size: 12px; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      }
      .rv4-hero-value {
        margin-top: 6px;
        font-size: clamp(22px, 4vw, 30px); font-weight: 700;
        color: var(--gold); font-variant-numeric: tabular-nums; line-height: 1.15;
      }
      .rv4-hero-big .rv4-hero-value {
        font-size: clamp(28px, 5vw, 38px);
      }
      .rv4-hero-source { margin-top: 6px; font-size: 11px; color: var(--text-muted); }

      .rv4-toggle-wrap { text-align: center; margin: 12px 0 20px; }
      .rv4-toggle {
        display: inline-block; padding: 10px 18px; border-radius: 8px;
        background: rgba(201,169,106,0.10); color: var(--gold);
        border: 1px solid rgba(201,169,106,0.32);
        font-size: 13px; font-weight: 600; cursor: pointer;
        transition: all 0.15s;
      }
      .rv4-toggle:hover { background: rgba(201,169,106,0.18); }

      .rv4-tier2 {
        margin-top: 16px; padding-top: 20px;
        border-top: 1px dashed var(--border-soft);
      }
      .rv4-tier2-grid {
        display: grid; gap: 22px;
        grid-template-columns: minmax(0, 1fr);
      }
      @media (min-width: 980px) {
        .rv4-tier2-grid {
          grid-template-columns: minmax(0, 1.4fr) minmax(280px, 1fr);
        }
      }
      .rv4-tier2-table { min-width: 0; }

      .rv4-input-panel {
        padding: 18px; border-radius: 12px;
        border: 1px solid var(--border-soft);
        background: rgba(255,255,255,0.02);
      }
      .rv4-input-head {
        display: flex; justify-content: space-between; align-items: baseline;
        gap: 12px; flex-wrap: wrap;
      }
      .rv4-input-title { font-weight: 600; color: var(--text); font-size: 15px; }
      .rv4-input-sub { font-size: 11px; color: var(--text-muted); margin: 4px 0 14px; }
      .rv4-reset {
        background: transparent; color: var(--gold); border: 1px solid rgba(201,169,106,0.4);
        padding: 6px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer;
        text-transform: uppercase; letter-spacing: 0.06em;
      }
      .rv4-reset:hover { background: rgba(201,169,106,0.10); }

      .rv4-acc {
        border-top: 1px solid var(--border-soft); padding: 0;
      }
      .rv4-acc:first-of-type { border-top: none; }
      .rv4-acc-head {
        display: flex; align-items: center; gap: 10px; width: 100%;
        background: transparent; border: 0;
        padding: 12px 0; cursor: pointer;
        color: var(--text); text-align: left;
        font-size: 13px;
      }
      .rv4-acc-label { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .rv4-acc-val {
        color: var(--gold-soft); font-variant-numeric: tabular-nums; font-weight: 600;
        white-space: nowrap;
      }
      .rv4-acc-chev {
        color: var(--text-muted); transition: transform 0.15s;
        font-size: 12px;
      }
      .rv4-acc-open .rv4-acc-chev { transform: rotate(180deg); }
      .rv4-acc-body { padding: 8px 0 14px; }
      .rv4-info {
        display: inline-flex; align-items: center; justify-content: center;
        width: 16px; height: 16px; border-radius: 50%;
        background: rgba(201,169,106,0.16); color: var(--gold);
        border: 0; font-size: 10px; font-weight: 700;
        cursor: pointer; font-style: italic; line-height: 1; padding: 0;
      }
      .rv4-help {
        margin: 0 0 10px; padding: 10px 12px;
        background: rgba(201,169,106,0.08); border-left: 2px solid var(--gold);
        border-radius: 0 6px 6px 0; font-size: 12px; color: var(--text);
        line-height: 1.5;
      }
      .rv4-caveat {
        margin-top: 8px; font-size: 12px; color: var(--text-muted);
        font-style: italic;
      }
      .rv4-footnote { margin-top: 10px; }

      .rv4-input {
        width: 100%; padding: 9px 12px; border-radius: 6px;
        background: rgba(0,0,0,0.30); color: var(--text);
        border: 1px solid var(--border); font-size: 14px;
        font-variant-numeric: tabular-nums;
        font-family: ui-monospace, SFMono-Regular, monospace;
      }
      .rv4-input:focus { outline: none; border-color: var(--gold); box-shadow: 0 0 0 2px rgba(201,169,106,0.18); }

      .rv4-seg {
        display: grid; grid-auto-flow: column; grid-auto-columns: 1fr;
        gap: 6px; padding: 4px; background: rgba(0,0,0,0.30);
        border-radius: 8px; border: 1px solid var(--border);
      }
      .rv4-seg-btn {
        background: transparent; border: 0; cursor: pointer;
        color: var(--text); padding: 8px 10px; border-radius: 6px;
        font-size: 12px; font-weight: 500;
        transition: background 0.12s, color 0.12s;
      }
      .rv4-seg-on {
        background: var(--gold); color: #1a1408; font-weight: 600;
      }

      @media (max-width: 720px) {
        .rv4-tier1 { grid-template-columns: 1fr; }
        .rv4-tier1-pair { grid-template-columns: 1fr; }
        .rv4-seg { grid-auto-flow: row; }
        .rv4-seg-btn { width: 100%; padding: 10px; font-size: 13px; }
        .rv4-acc-head { flex-wrap: wrap; }
        .rv4-acc-val { width: 100%; padding-top: 2px; }
        .rv4-help {
          position: relative;
        }
      }
      @media (max-width: 480px) {
        .rv4-hero { padding: 16px; }
        .rv4-input-panel { padding: 14px; }
      }
    `}</style>
  );
}
