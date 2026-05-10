/**
 * Math framework v4 — interactive Section 5 ("The Math").
 *
 * Two-tier disclosure (per Phase 18B brief):
 *   Tier 1 — 5 hero rows (always visible): Revenue · Current Profit ·
 *            New Profit with RCG · Δ Profit/yr (highlighted) · 7× Exit
 *            Multiple Lift (highlighted).
 *   Tier 2 — "Show full math ↓" reveals the 11-row P&L plus the
 *            editable input panel. On <720px the table collapses to a
 *            stacked card list (no horizontal scroll). On <375px the
 *            input panel sits below the table.
 *
 * Editable inputs live client-side, persisted to localStorage keyed by
 * report token. Recompute is fully local — `computeLegionEconomics()`
 * is the single source of truth.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  computeLegionEconomics,
  normalizePercent,
  type LegionInputs,
  type LegionOutputs,
  type OutboundShippingPayer,
} from "@/lib/math/legion-economics";

export interface LegionMathSectionProps {
  reportToken: string;
  /** Phase 34.1 — narrative_json.generated_at, used to namespace
   *  localStorage so a regenerated report invalidates any prior
   *  per-device tweaks (otherwise stale revenue / assumptions from a
   *  previous visit overwrite the fresh server values on hydrate and
   *  the math card silently drifts from the cover/PDF). */
  reportGeneratedAt: string | null;
  initialRevenue: number | null;
  initialAssumptions: LegionAssumptions;
  /** Source string for the revenue line (e.g. "Keepa, 2026-04-15"). */
  revenueSource: string;
  /** Optional badge on the revenue value. */
  revenueBadge: "actual" | "estimate" | "confirmed" | null;
  /** Phase 28 — when revenue source = "confirmed", the free-text label
   *  the user typed (e.g. "Orion data"). Surfaces under the badge. */
  revenueConfirmedSource?: string | null;
  /** Phase 28 — when revenue source = "confirmed", the estimator number
   *  we'd otherwise have shown. Renders as a small inline sub-note. */
  revenueEstimatorSuggestion?: number | null;
  /** Footnote when revenue came from the estimator. */
  revenueFootnote: string | null;
  /** LLM-generated math notes from assemble.ts. */
  notes: string | null;
  /** Phase 27 — brand-controlled share (0-1). When the brand already
   *  wins most of its own buy boxes the wholesale-leg math runs on the
   *  recoverable slice (revenue × (1 − bc)) so we don't claim margin
   *  from sales the brand already keeps. Null/0 ⇒ treat all revenue as
   *  recoverable (legacy behavior). */
  brandControlledPct?: number | null;
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

const STORAGE_PREFIX = "legion-math-inputs:";

interface PersistedState {
  revenue: number | null;
  assumptions: LegionAssumptions;
}

/** Phase 34.1 — the legacy key (token only) was vulnerable to stale
 *  hydration after a regen: a returning visitor's localStorage value
 *  would override the fresh `initialRevenue` from the server, and the
 *  whole math chain would compute off the old revenue (Terra Pure
 *  symptom: cover correct at $5.29M, math card stuck at $916k). The
 *  storage key now includes `generated_at`, so a regen produces a new
 *  key and the user-saved tweaks attached to the prior generation are
 *  cleanly orphaned (and pruned on hydrate). */
function buildStorageKey(token: string, generatedAt: string | null): string {
  const stamp = generatedAt ? `:${generatedAt}` : "";
  return `${STORAGE_PREFIX}${token}${stamp}`;
}

/** Drop any prior `legion-math-inputs:<token>...` entries left in
 *  localStorage from earlier visits / earlier generations of the same
 *  report. Keeps the active (current `generated_at`) key intact. */
function pruneStaleStorageKeys(token: string, currentKey: string) {
  try {
    const prefix = `${STORAGE_PREFIX}${token}`;
    const toDelete: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(prefix) && k !== currentKey) {
        toDelete.push(k);
      }
    }
    for (const k of toDelete) window.localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

export function LegionMathSection(props: LegionMathSectionProps) {
  const storageKey = buildStorageKey(props.reportToken, props.reportGeneratedAt);

  const [revenue, setRevenue] = useState<number | null>(props.initialRevenue);
  const [assumptions, setAssumptions] = useState<LegionAssumptions>(props.initialAssumptions);
  const [showFullMath, setShowFullMath] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // On mount: hydrate from localStorage if present (overrides server-supplied
  // initials so a returning visitor sees their tweaks). The key includes
  // `generated_at` so a regen produces a fresh slot — any prior keys for
  // this token (older generations) are pruned before hydrate to keep
  // localStorage from accumulating dead entries.
  useEffect(() => {
    pruneStaleStorageKeys(props.reportToken, storageKey);
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
  }, [storageKey, props.reportToken]);

  // Persist on change (debounced 200ms) — only after first hydration so we
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
    }, 200);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [revenue, assumptions, hydrated, storageKey]);

  const brandControlledPct = props.brandControlledPct ?? null;
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
      brand_controlled_pct: brandControlledPct,
    };
    return computeLegionEconomics(inputs);
  }, [revenue, assumptions, brandControlledPct]);

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
        <div className="rv2-eyebrow">Estimated Financial Opportunity</div>
        <h2 className="rv2-h2">What the channel could be worth under brand control</h2>
        <div className="rv2-source">Directional estimates · transparent line-by-line bridge</div>
      </div>

      {/* Phase 58 — the always-visible BridgeBody was the duplicate "top
          static card" called out in the spec: it surfaced the same
          delta_profit / exit_lift values as the Tier 1 hero stats below
          plus the Tier 2 full P&L. Deleted in Phase 58; the expandable
          card below is now the single source of math truth. */}

      {/* Tier 1 — exactly 5 hero rows. */}
      <div className="rv4-tier1">
        <HeroStat
          label={
            props.revenueBadge === "confirmed"
              ? "Annual Amazon revenue (confirmed)"
              : "Annual Amazon revenue (estimated)"
          }
          value={revenue}
          badge={props.revenueBadge}
          source={props.revenueSource}
          subNote={
            props.revenueBadge === "confirmed" &&
            typeof props.revenueEstimatorSuggestion === "number"
              ? `Estimator suggested ${money(props.revenueEstimatorSuggestion)} — using your confirmed value.`
              : null
          }
        />
        <HeroStat
          label={`Current profit (at ${pct(assumptions.current_profit_margin_pct, 0)} margin)`}
          value={v(out.current_profit)}
          source="current margin × effective wholesale"
        />
        <HeroStat
          label="New profit with RCG"
          value={v(out.new_profit)}
          source="current + reseller margin captured + recouped − labor"
        />
        <HeroStat
          label="Δ Additional profit / year"
          value={v(out.delta_profit)}
          source="new profit − current profit"
          big
          accent
        />
        <HeroStat
          label={`${assumptions.ebitda_multiple}× EBITDA exit-value lift`}
          value={v(out.exit_lift)}
          source={`${assumptions.ebitda_multiple}× × Δ profit`}
          big
          accent
        />
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
              <FullMath
                revenue={revenue}
                out={out}
                assumptions={assumptions}
                revenueSource={props.revenueSource}
                revenueBadge={props.revenueBadge}
                brandControlledPct={brandControlledPct}
              />
              {props.notes && <p className="rv2-prose rv2-prose-callout">{props.notes}</p>}
              {props.revenueFootnote && (
                <p className="rv2-muted-small rv4-footnote">{props.revenueFootnote}</p>
              )}
              {props.revenueBadge === "confirmed" &&
                typeof props.revenueEstimatorSuggestion === "number" && (
                  <p className="rv2-muted-small rv4-footnote">
                    Revenue confirmed by user
                    {props.revenueConfirmedSource
                      ? ` — source: ${props.revenueConfirmedSource}`
                      : ""}
                    . Estimator suggested {money(props.revenueEstimatorSuggestion)}.
                  </p>
                )}
            </div>

            <div className="rv4-tier2-inputs">
              <InputPanel
                assumptions={assumptions}
                setAssumptions={setAssumptions}
                onReset={resetAll}
              />
            </div>
          </div>
        </div>
      )}

      <LegionMathStyles />
    </section>
  );
}

// Phase 58 — BridgeBody / BridgePill / BridgeRow / BridgeConfidence were
// removed (they were the duplicate "top static card" called out in the
// Phase 58 spec). The expandable Tier 1 + Tier 2 card below remains the
// single source of math truth.

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
  subNote,
}: {
  label: string;
  value: number | null;
  source: string;
  badge?: "actual" | "estimate" | "confirmed" | null;
  accent?: boolean;
  big?: boolean;
  /** Phase 28 — sanity-check sub-note shown beneath the source line when
   *  revenue is user-confirmed: "Estimator suggested $X". */
  subNote?: string | null;
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
        {badge === "confirmed" && (
          <span className="rv2-rev-badge rv2-rev-badge-confirmed">Confirmed by user</span>
        )}
      </div>
      <div className="rv4-hero-value">{value != null ? money(value) : "— not measured"}</div>
      <div className="rv4-hero-source">{source}</div>
      {subNote && <div className="rv4-hero-source rv4-hero-subnote">{subNote}</div>}
    </div>
  );
}

// ====================================================================
// Tier 2 — full 11-row P&L
//   Desktop / ≥720px: table.
//   <720px: stacked card list (no horizontal scroll).
// ====================================================================

interface MathRow {
  key: string;
  label: string;
  value: number | null;
  source: string;
  format: "money" | "percent";
  total?: boolean;
  badge?: "actual" | "estimate" | "confirmed" | null;
  estimate?: boolean;
}

function FullMath({
  revenue,
  out,
  assumptions,
  revenueSource,
  revenueBadge,
  brandControlledPct,
}: {
  revenue: number | null;
  out: LegionOutputs;
  assumptions: LegionAssumptions;
  revenueSource: string;
  revenueBadge: "actual" | "estimate" | "confirmed" | null;
  brandControlledPct: number | null;
}) {
  const haveRev = revenue != null && revenue > 0;
  const v = (n: number) => (haveRev ? n : null);
  const isEst = revenueBadge === "estimate";
  const payerSource =
    assumptions.outbound_shipping_payer === "reseller"
      ? "Brand pays: NO (not recoupable)"
      : assumptions.outbound_shipping_payer === "unknown"
        ? "Brand pays: unknown — assumed YES"
        : "Brand pays: YES (recoupable)";
  const hasBcGate = brandControlledPct != null && brandControlledPct > 0;
  const recoverableLabel = hasBcGate ? "recoverable revenue" : "revenue";
  const resellerSharePct =
    hasBcGate
      ? Math.max(0, Math.min(1, 1 - (brandControlledPct as number)))
      : 1;

  // 11 rows + the 3 total/headline rows below (still inside Tier 2 per
  // the brief).
  const rows: MathRow[] = [
    { key: "reseller_markup_pct", label: "Reseller markup %", value: assumptions.reseller_markup_pct, source: "editable — see input panel", format: "percent" },
    { key: "implied_retail", label: "Reseller's implied retail price", value: revenue, source: "what the reseller charges on Amazon (= revenue)", format: "money", badge: revenueBadge, estimate: isEst },
    ...(hasBcGate
      ? ([
          {
            key: "recoverable_revenue",
            label: "Recoverable revenue (reseller-controlled slice)",
            value: v(out.recoverable_revenue),
            source: `revenue × ${pct(resellerSharePct, 1)} reseller share (1 − brand-controlled ${pct(brandControlledPct as number, 1)})`,
            format: "money" as const,
            estimate: isEst,
          },
        ] satisfies MathRow[])
      : []),
    { key: "wholesale_invoice", label: "Wholesale invoice (your current price)", value: v(out.wholesale_invoice), source: `${recoverableLabel} ÷ (1 + ${pct(assumptions.reseller_markup_pct, 0)} markup)`, format: "money", estimate: isEst },
    { key: "outbound_shipping_pct", label: "Outbound shipping %", value: assumptions.outbound_shipping_pct, source: "editable — see input panel", format: "percent" },
    { key: "wholesale_outbound_shipping", label: "Outbound shipping $", value: v(out.wholesale_outbound_shipping), source: `${pct(assumptions.outbound_shipping_pct, 1)} × wholesale invoice · ${payerSource}`, format: "money", estimate: isEst },
    { key: "effective_markup_pct", label: "Effective markup %", value: v(out.effective_markup_pct), source: `${recoverableLabel} ÷ (wholesale − outbound shipping) − 1`, format: "percent", estimate: isEst },
    { key: "effective_wholesale", label: "Effective wholesale (true COGS)", value: v(out.effective_wholesale), source: "wholesale invoice − outbound shipping", format: "money", estimate: isEst },
    { key: "reseller_net_margin_pct", label: "Reseller net margin %", value: assumptions.reseller_net_margin_pct, source: "editable — incl. inbound shipping (~3%)", format: "percent" },
    { key: "reseller_margin_captured", label: "Reseller margin captured $", value: v(out.reseller_margin_captured), source: `${pct(assumptions.reseller_net_margin_pct, 1)} × ${recoverableLabel}`, format: "money", estimate: isEst },
    { key: "recouped_shipping", label: "Recouped shipping $", value: v(out.recouped_shipping), source: payerSource, format: "money", estimate: isEst },
    { key: "labor_cost", label: "Labor cost $", value: haveRev ? -Math.abs(out.labor_cost) : null, source: laborSource(out.labor_tier, assumptions.labor_cost_override), format: "money" },
  ];

  const finalRows: MathRow[] = [
    { key: "new_profit", label: "New profit $", value: v(out.new_profit), source: "current + reseller margin + recouped − labor", format: "money", estimate: isEst },
    { key: "delta_profit", label: "Δ Additional profit / year", value: v(out.delta_profit), source: "new profit − current profit", format: "money", total: true, estimate: isEst },
    { key: "exit_lift", label: `${assumptions.ebitda_multiple}× EBITDA exit-value lift`, value: v(out.exit_lift), source: `${assumptions.ebitda_multiple}× × Δ profit`, format: "money", total: true, estimate: isEst },
  ];

  return (
    <>
      {/* Desktop / tablet table */}
      <div className="rv4-table-wrap">
        <table className="rv2-table rv2-math-table">
          <thead>
            <tr>
              <th>Line</th>
              <th>Value</th>
              <th>Source / Assumption</th>
            </tr>
          </thead>
          <tbody>
            {[...rows, ...finalRows].map((r) => (
              <tr key={r.key} className={r.total ? "rv2-math-total" : ""}>
                <td>
                  {r.label}
                  {r.badge === "actual" && <span className="rv2-rev-badge rv2-rev-badge-actual">Actual</span>}
                  {r.badge === "estimate" && <span className="rv2-rev-badge rv2-rev-badge-est">Estimate</span>}
                  {r.badge === "confirmed" && <span className="rv2-rev-badge rv2-rev-badge-confirmed">Confirmed by user</span>}
                </td>
                <td className="rv2-num">
                  {formatCell(r.value, r.format)}
                  {r.estimate && r.value != null && r.badge == null && (
                    <span className="rv2-rev-badge rv2-rev-badge-est rv4-inline-est">Est.</span>
                  )}
                </td>
                <td>
                  <span className="rv2-muted-small">{r.source}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile stacked cards (<720px). No horizontal scroll. */}
      <ol className="rv4-cards" aria-label="Full math (11-row P&L)">
        {[...rows, ...finalRows].map((r) => (
          <li key={r.key} className={`rv4-card${r.total ? " rv4-card-total" : ""}`}>
            <div className="rv4-card-label">
              <span>{r.label}</span>
              {r.badge === "actual" && <span className="rv2-rev-badge rv2-rev-badge-actual">Actual</span>}
              {r.badge === "estimate" && <span className="rv2-rev-badge rv2-rev-badge-est">Estimate</span>}
              {r.badge === "confirmed" && <span className="rv2-rev-badge rv2-rev-badge-confirmed">Confirmed by user</span>}
            </div>
            <div className="rv4-card-value">
              {formatCell(r.value, r.format)}
              {r.estimate && r.value != null && r.badge == null && (
                <span className="rv2-rev-badge rv2-rev-badge-est rv4-inline-est">Est.</span>
              )}
            </div>
            <div className="rv4-card-source">{r.source}</div>
          </li>
        ))}
      </ol>
    </>
  );
}

// ====================================================================
// Editable input panel
// ====================================================================

const HELP_RESELLER_MARKUP =
  "Compare the price your reseller currently charges on Amazon to the wholesale price you invoice them. The difference, as a percentage, is the reseller's markup. For example: invoice $25, sells on Amazon for $50 = 100% markup.";
const SUB_PAYER =
  "If the brand pays for outbound shipping, it can be recouped. If the reseller pays, it cannot.";
const SUB_RESELLER_NET_MARGIN = "Includes inbound shipping (~3%).";

function InputPanel({
  assumptions,
  setAssumptions,
  onReset,
}: {
  assumptions: LegionAssumptions;
  setAssumptions: (a: LegionAssumptions) => void;
  onReset: () => void;
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

      <Field
        label="Reseller markup %"
        help={HELP_RESELLER_MARKUP}
      >
        <PercentInput
          value={assumptions.reseller_markup_pct}
          onChange={(n) => setA({ reseller_markup_pct: n })}
          max={5}
          placeholder="103%"
          ariaLabel="Reseller markup percent"
        />
      </Field>

      <Field label="Outbound shipping %">
        <PercentInput
          value={assumptions.outbound_shipping_pct}
          onChange={(n) => setA({ outbound_shipping_pct: n })}
          max={0.25}
          placeholder="5%"
          ariaLabel="Outbound shipping percent"
        />
      </Field>

      <Field label="Outbound shipping payer" sub={SUB_PAYER}>
        <Segmented
          value={assumptions.outbound_shipping_payer}
          onChange={(v) =>
            setA({ outbound_shipping_payer: v as OutboundShippingPayer })
          }
          options={[
            { value: "brand", label: "Brand pays", short: "Brand" },
            { value: "reseller", label: "Reseller pays", short: "Reseller" },
            { value: "unknown", label: "Unknown", short: "?" },
          ]}
        />
        {assumptions.outbound_shipping_payer === "unknown" && (
          <div className="rv4-caveat">
            Assuming brand pays — toggle if your reseller absorbs this cost.
          </div>
        )}
      </Field>

      <Field label="Reseller net margin %" sub={SUB_RESELLER_NET_MARGIN}>
        <PercentInput
          value={assumptions.reseller_net_margin_pct}
          onChange={(n) => setA({ reseller_net_margin_pct: n })}
          max={0.30}
          placeholder="10.5%"
          ariaLabel="Reseller net margin percent"
        />
      </Field>

      <Field label="Current profit margin %">
        <PercentInput
          value={assumptions.current_profit_margin_pct}
          onChange={(n) => setA({ current_profit_margin_pct: n })}
          max={0.60}
          placeholder="20%"
          ariaLabel="Current profit margin percent"
        />
      </Field>

      <Field label="EBITDA multiple">
        <NumberInput
          value={assumptions.ebitda_multiple}
          onChange={(n) => setA({ ebitda_multiple: n })}
          min={3}
          max={15}
          step={0.5}
          placeholder="7"
          ariaLabel="EBITDA multiple"
        />
      </Field>
    </div>
  );
}

function Field({
  label,
  sub,
  help,
  children,
}: {
  label: string;
  sub?: string;
  help?: string;
  children: React.ReactNode;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <div className="rv4-field">
      <div className="rv4-field-label">
        <span>{label}</span>
        {help && (
          <button
            type="button"
            className="rv4-info"
            aria-label={`Help for ${label}`}
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen((h) => !h)}
          >
            i
          </button>
        )}
      </div>
      {sub && <div className="rv4-field-sub">{sub}</div>}
      {help && helpOpen && <div className="rv4-help" role="note">{help}</div>}
      <div className="rv4-field-input">{children}</div>
    </div>
  );
}

function PercentInput({
  value,
  onChange,
  max,
  placeholder,
  ariaLabel,
}: {
  value: number;
  onChange: (n: number) => void;
  max: number;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const display = (n: number): string => {
    const pctValue = n * 100;
    return Number.isInteger(pctValue) ? `${pctValue}%` : `${pctValue.toFixed(2)}%`;
  };
  const [text, setText] = useState(display(value));
  useEffect(() => {
    setText(display(value));
  }, [value]);

  const commit = (raw: string) => {
    const n = normalizePercent(raw);
    const clamped = Math.max(0, Math.min(max, n));
    onChange(clamped);
    setText(display(clamped));
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      className="rv4-input"
      placeholder={placeholder}
      aria-label={ariaLabel}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        // Live recompute while typing — but only when the value parses
        // to a finite number we can clamp. Keeps the displayed text raw
        // so partial typing ("0.10") doesn't get clobbered.
        const cleaned = e.target.value.replace(/[%\s,]/g, "").trim();
        if (cleaned === "") return;
        const n = Number(cleaned);
        if (!Number.isFinite(n)) return;
        const decimal = n >= 5 ? n / 100 : n;
        onChange(Math.max(0, Math.min(max, decimal)));
      }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
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
  ariaLabel,
}: {
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step: number;
  placeholder?: string;
  ariaLabel?: string;
}) {
  return (
    <input
      type="text"
      inputMode="decimal"
      className="rv4-input"
      placeholder={placeholder}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => {
        const raw = e.target.value.replace(/[×x\s,]/g, "").trim();
        if (raw === "") return;
        const n = Number(raw);
        if (Number.isFinite(n)) {
          onChange(Math.max(min, Math.min(max, n)));
        }
      }}
      // step/min/max kept for completeness even on text inputs — assistive
      // tech will read them, and on Android numeric keypad respects them.
      data-min={min}
      data-max={max}
      data-step={step}
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
  options: { value: string; label: string; short?: string }[];
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
          <span className="rv4-seg-full">{o.label}</span>
          {o.short && <span className="rv4-seg-short">{o.short}</span>}
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
// Styles — extends the v2 dark theme. Mobile-first; tablet/desktop
// breakpoints layer on top.
// ====================================================================

function LegionMathStyles() {
  return (
    <style>{`
      /* Phase 41b — bridge body. Sits between the section header and
         the existing Tier 1 hero cards. Mobile-first: stacks each row,
         label on top with value/conf inline. ≥720px: 4-column grid. */
      .rv4-bridge {
        margin: 4px 0 22px;
        border: 1px solid var(--border-soft);
        border-radius: 12px;
        background: rgba(255,255,255,0.02);
        overflow: hidden;
      }
      .rv4-bridge-head {
        display: none;
      }
      @media (min-width: 720px) {
        .rv4-bridge-head {
          display: grid;
          grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr);
          gap: 14px;
          padding: 10px 16px;
          border-bottom: 1px solid var(--border-soft);
          font-size: 11px; color: var(--text-muted);
          text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;
        }
      }
      .rv4-bridge-row {
        display: grid;
        grid-template-columns: 1fr;
        gap: 4px;
        padding: 12px 16px;
        border-top: 1px solid var(--border-soft);
      }
      .rv4-bridge-row:first-of-type { border-top: 0; }
      @media (min-width: 720px) {
        .rv4-bridge-row {
          grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr);
          gap: 14px;
          align-items: center;
        }
      }
      .rv4-bridge-row-total {
        background: rgba(201,169,106,0.08);
      }
      .rv4-bridge-label {
        font-size: 13px; font-weight: 600; color: var(--text);
        line-height: 1.35; word-break: break-word;
      }
      .rv4-bridge-row-total .rv4-bridge-label { color: var(--gold); }
      .rv4-bridge-value {
        font-size: 16px; font-weight: 700; color: var(--gold);
        font-variant-numeric: tabular-nums; line-height: 1.2;
      }
      .rv4-bridge-row-total .rv4-bridge-value {
        font-size: 18px;
      }
      .rv4-bridge-note {
        font-size: 12px; color: var(--text-muted);
        line-height: 1.4; word-break: break-word;
      }
      .rv4-bridge-conf {
        display: flex; align-items: center;
      }
      .rv4-bridge-footnote {
        margin: 0; padding: 10px 16px 12px;
        border-top: 1px dashed var(--border-soft);
        font-size: 11px; color: var(--text-muted);
      }

      .rv4-tier1 {
        display: grid; gap: 12px;
        grid-template-columns: 1fr;
        margin: 8px 0 24px;
      }
      @media (min-width: 560px) {
        .rv4-tier1 { grid-template-columns: 1fr 1fr; gap: 14px; }
      }
      @media (min-width: 980px) {
        .rv4-tier1 {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        /* Bottom two are the highlighted hero pair — span the full row. */
        .rv4-tier1 > .rv4-hero-big:nth-last-of-type(2) {
          grid-column: 1 / span 2;
        }
        .rv4-tier1 > .rv4-hero-big:last-of-type {
          grid-column: 3 / span 1;
        }
      }
      .rv4-hero {
        padding: 16px 16px 14px; border-radius: 12px;
        border: 1px solid var(--border-soft);
        background: rgba(255,255,255,0.02);
        min-width: 0;
      }
      .rv4-hero-accent {
        background: linear-gradient(180deg, rgba(201,169,106,0.10), rgba(201,169,106,0.03));
        border-color: rgba(201,169,106,0.32);
      }
      .rv4-hero-big {
        background: rgba(201,169,106,0.10);
        border-color: rgba(201,169,106,0.40);
        padding: 18px 18px 16px;
      }
      .rv4-hero-label {
        font-size: 11px; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
        line-height: 1.3;
      }
      .rv4-hero-value {
        margin-top: 6px;
        font-size: clamp(22px, 6vw, 30px); font-weight: 700;
        color: var(--gold); font-variant-numeric: tabular-nums; line-height: 1.15;
        word-break: break-word;
      }
      .rv4-hero-big .rv4-hero-value {
        font-size: clamp(28px, 7vw, 40px);
      }
      .rv4-hero-source {
        margin-top: 6px; font-size: 11px; color: var(--text-muted);
        line-height: 1.4;
      }

      .rv4-toggle-wrap { text-align: center; margin: 8px 0 18px; }
      .rv4-toggle {
        display: inline-block; padding: 10px 18px; border-radius: 8px;
        background: rgba(201,169,106,0.10); color: var(--gold);
        border: 1px solid rgba(201,169,106,0.32);
        font-size: 13px; font-weight: 600; cursor: pointer;
        transition: all 0.15s; min-height: 44px;
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
          align-items: start;
        }
      }
      .rv4-tier2-table { min-width: 0; }

      /* Table: visible ≥720px. Wraps long text — never scroll. */
      .rv4-table-wrap { display: none; }
      @media (min-width: 720px) {
        .rv4-table-wrap { display: block; }
        .rv4-table-wrap .rv2-math-table { width: 100%; table-layout: auto; }
        .rv4-table-wrap .rv2-math-table th,
        .rv4-table-wrap .rv2-math-table td {
          word-break: break-word; overflow-wrap: anywhere;
        }
      }

      /* Stacked cards: visible <720px. No horizontal scroll. */
      .rv4-cards {
        list-style: none; padding: 0; margin: 0;
        display: grid; gap: 10px;
      }
      @media (min-width: 720px) { .rv4-cards { display: none; } }
      .rv4-card {
        padding: 12px 14px; border-radius: 10px;
        border: 1px solid var(--border-soft);
        background: rgba(255,255,255,0.02);
        display: grid; gap: 4px; min-width: 0;
      }
      .rv4-card-total {
        background: rgba(201,169,106,0.08);
        border-color: rgba(201,169,106,0.30);
      }
      .rv4-card-label {
        font-size: 12px; color: var(--text-muted);
        font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
        display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
        line-height: 1.3;
      }
      .rv4-card-value {
        font-size: 18px; font-weight: 700; color: var(--gold);
        font-variant-numeric: tabular-nums;
        display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
      }
      .rv4-card-total .rv4-card-value { font-size: 22px; }
      .rv4-card-source {
        font-size: 11px; color: var(--text-muted);
        line-height: 1.4; word-break: break-word;
      }

      .rv4-inline-est {
        font-size: 9px; padding: 1px 5px;
      }

      .rv4-input-panel {
        padding: 16px; border-radius: 12px;
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
        background: transparent; color: var(--gold);
        border: 0; padding: 4px 0;
        font-size: 11px; font-weight: 600; cursor: pointer;
        text-transform: uppercase; letter-spacing: 0.06em;
        text-decoration: underline; text-underline-offset: 3px;
      }
      .rv4-reset:hover { color: var(--gold-soft); }

      .rv4-field {
        padding: 10px 0;
        border-top: 1px solid var(--border-soft);
      }
      .rv4-field:first-of-type { border-top: none; padding-top: 4px; }
      .rv4-field-label {
        display: flex; align-items: center; gap: 6px;
        font-size: 12px; color: var(--text);
        font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
        margin-bottom: 2px;
      }
      .rv4-field-sub {
        font-size: 11px; color: var(--text-muted);
        margin-bottom: 8px; line-height: 1.4;
      }
      .rv4-field-input { margin-top: 6px; }

      .rv4-info {
        display: inline-flex; align-items: center; justify-content: center;
        width: 16px; height: 16px; border-radius: 50%;
        background: rgba(201,169,106,0.16); color: var(--gold);
        border: 0; font-size: 10px; font-weight: 700;
        cursor: pointer; font-style: italic; line-height: 1; padding: 0;
      }
      .rv4-help {
        margin: 6px 0 8px; padding: 10px 12px;
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
        width: 100%; padding: 10px 12px; border-radius: 6px;
        background: rgba(0,0,0,0.30); color: var(--text);
        border: 1px solid var(--border); font-size: 14px;
        font-variant-numeric: tabular-nums;
        font-family: ui-monospace, SFMono-Regular, monospace;
        min-height: 40px;
      }
      .rv4-input:focus { outline: none; border-color: var(--gold); box-shadow: 0 0 0 2px rgba(201,169,106,0.18); }

      /* Segmented control — 3-state, always 3-up; on very narrow widths
         the long label hides and the short label takes over. */
      .rv4-seg {
        display: grid; grid-auto-flow: column; grid-auto-columns: 1fr;
        gap: 4px; padding: 4px; background: rgba(0,0,0,0.30);
        border-radius: 8px; border: 1px solid var(--border);
      }
      .rv4-seg-btn {
        background: transparent; border: 0; cursor: pointer;
        color: var(--text); padding: 8px 6px; border-radius: 6px;
        font-size: 12px; font-weight: 500;
        transition: background 0.12s, color 0.12s;
        min-height: 36px;
        white-space: nowrap;
      }
      .rv4-seg-on {
        background: var(--gold); color: #1a1408; font-weight: 600;
      }
      .rv4-seg-full { display: inline; }
      .rv4-seg-short { display: none; }
      @media (max-width: 380px) {
        .rv4-seg-btn { font-size: 11px; padding: 8px 2px; }
      }
      @media (max-width: 340px) {
        .rv4-seg-full { display: none; }
        .rv4-seg-short { display: inline; }
      }
    `}</style>
  );
}
