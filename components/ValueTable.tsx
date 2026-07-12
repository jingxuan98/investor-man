"use client";

import { useMemo, useState } from "react";
import { computeValuation } from "@/lib/finance/valuation";
import {
  AssumptionProvenance,
  assumptionProvenance,
  classifyStock,
  revenueCagr5y,
} from "@/lib/finance/assumptions";
import { styleComposite } from "@/lib/finance/helpers";
import { Assumptions, FinancialSnapshot, Horizon, ValuationVariant } from "@/lib/finance/types";
import { fmtMoney } from "@/lib/format";
import KnobField from "@/components/KnobField";
import Term from "@/components/Term";
import SignalBadge from "@/components/SignalBadge";
import VariantToggle, { VARIANT_LABEL } from "@/components/VariantToggle";
import { useVariant } from "@/components/VariantProvider";

// Raw text state for the five knob inputs — kept as strings (not numbers) so
// the field can hold transient/partial input (e.g. "-", "1.") without losing
// keystrokes. Parsing to decimals happens in the overrides useMemo below.
interface KnobInputs {
  normalGrowth: string;
  terminalGrowth: string;
  marginExpansion: string;
  wacc: string;
  hHalfLife: string;
}

const EMPTY_KNOBS: KnobInputs = {
  normalGrowth: "",
  terminalGrowth: "",
  marginExpansion: "",
  wacc: "",
  hHalfLife: "",
};

// Reason: empty string and non-numeric input ("abc") both mean "no override"
// so the resolved assumption falls back to the auto/default value; a valid
// negative number (e.g. -5 for margin contraction) is a legitimate override.
function parsePercent(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n / 100 : undefined;
}

function parseNumber(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// Plain (unsigned) percentage — the assumption-provenance strip shows rates
// like "18.5%", not signed deltas, so lib/format's fmtPct (which prefixes a
// "+") doesn't fit here.
function pct1(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function Bar({
  value,
  price,
  max,
  highlight,
}: {
  value: number;
  price: number;
  max: number;
  highlight?: boolean;
}) {
  const w = Math.max(2, (value / max) * 100);
  const tick = (price / max) * 100;
  const color = highlight
    ? "bg-accent"
    : value > price * 1.05
      ? "bg-green"
      : value < price * 0.95
        ? "bg-red"
        : "bg-amber";
  // Reason: capped at 2 decimals — full-precision floats (e.g. "32.93692028974771%")
  // get silently re-normalized by the browser's CSS parser when the SSR-emitted
  // style attribute is parsed back into the live DOM, which then reads back as a
  // shorter string ("32.9369%") than what React computes client-side, causing a
  // spurious hydration mismatch. Two decimals is well within CSSOM's round-trip
  // precision and is more than enough visual accuracy for a bar chart.
  const widthPct = Math.min(w, 100).toFixed(2);
  const tickPct = Math.min(tick, 100).toFixed(2);
  return (
    <div className="iv-track">
      <div className={`iv-fill ${color}`} style={{ width: `${widthPct}%` }} />
      <div className="iv-tick" style={{ left: `${tickPct}%` }} />
    </div>
  );
}

const HORIZON_LABEL: Record<Horizon, string> = {
  current: "Today",
  q1: "1Q",
  q2: "2Q",
  nextYear: "1Y",
};

const HORIZON_TOOLTIP: Record<Horizon, string> = {
  current: "Today's implied value from each method, using today's cash flows and metrics.",
  q1:
    "3 months forward: a geometrically-interpolated point 1/4 of the way along the path from today's value to the 1-year-forward value (constant-rate accretion, not a full re-projection).",
  q2:
    "6 months forward: a geometrically-interpolated point halfway along the path from today's value to the 1-year-forward value (constant-rate accretion, not a full re-projection).",
  nextYear:
    "Rolls every model forward one fiscal year: cash flows grow one year along the assumed path, multiples apply to next year's metrics. Debt, cash and multiples held constant.",
};

const HORIZON_RETURN_LABEL: Record<Horizon, string> = {
  current: "",
  q1: "3-mo",
  q2: "6-mo",
  nextYear: "1-yr",
};

// Composite-row label suffix per horizon — "current" gets none.
const HORIZON_FORWARD_SUFFIX: Record<Horizon, string> = {
  current: "",
  q1: " (1Q forward)",
  q2: " (2Q forward)",
  nextYear: " (1yr forward)",
};

// Composite-row explainer's extra sentence per horizon — "current" gets none.
const HORIZON_EXPLAINER_SUFFIX: Record<Horizon, string> = {
  current: "",
  q1: " A 3-month-forward point interpolated along the path to next year's value, not today's value.",
  q2: " A 6-month-forward point interpolated along the path to next year's value, not today's value.",
  nextYear: " Every method rolled forward one fiscal year, not today's value.",
};

const HORIZONS: Horizon[] = ["current", "q1", "q2", "nextYear"];

// Segmented horizon toggle — orthogonal to the variant toggle (above) and the
// investor-style sub-tabs (below): every combination of variant x style x
// horizon is valid, and this control's state is independent of both. Mirrors
// VariantButton's hover-tooltip pattern/markup exactly.
function HorizonButton({
  horizon,
  active,
  align,
  onClick,
}: {
  horizon: Horizon;
  active: boolean;
  align: "left" | "right";
  onClick: () => void;
}) {
  const posClass =
    align === "left"
      ? "left-0 origin-top-left"
      : "right-0 origin-top-right";
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={HORIZON_TOOLTIP[horizon]}
      className={`group relative tab-btn !px-3 !py-1.5 !text-xs ${active ? "active" : ""}`}
      onClick={onClick}
    >
      {HORIZON_LABEL[horizon]}
      <span
        role="tooltip"
        className={`pointer-events-none absolute top-full z-50 mt-1.5 w-72 max-w-[calc(100vw-2rem)] scale-95 whitespace-normal break-words rounded-lg border border-line bg-card p-2.5 text-xs font-normal normal-case leading-snug tracking-normal text-ink3 opacity-0 shadow-lg transition-all duration-150 group-hover:scale-100 group-hover:opacity-100 ${posClass}`}
      >
        {HORIZON_TOOLTIP[horizon]}
      </span>
    </button>
  );
}

const LEGEND = [
  { color: "bg-green", label: "Upside" },
  { color: "bg-amber", label: "Near fair" },
  { color: "bg-red", label: "Downside" },
  { color: "bg-ink2", label: "Market price" },
] as const;

// One-line layman explanation per method, shown under the method name.
const METHOD_EXPLAINERS: Record<string, string> = {
  dcf20:
    "Adds up 20 years of the company's operating cash in three growth stages, valued in today's money.",
  dfcf20:
    "Same idea, but uses the cash left over after equipment and investment spending (free cash flow).",
  dni20:
    "Projects 20 years of accounting profits (net income) and discounts them back to today.",
  hmodel:
    "A one-formula shortcut: values today's free cash assuming growth fades smoothly to a steady long-run rate.",
  evEbitda:
    "What the business would be worth if it traded at its own typical historical earnings (EBITDA) multiple.",
  evRevenue:
    "What its sales would be worth if priced at the typical multiple for companies in its sector.",
  pFcf:
    "What its free cash flow would be worth if priced like the average company in its sector.",
  revDcf:
    "Projects sales 20 years out, applies today's profit margin to them, then discounts those profits to today.",
  peg:
    "Fair P/E = growth rate (PEG of 1): a company growing 20%/yr deserves ~20x earnings.",
  graham:
    "Ben Graham's classic formula: earnings × (8.5 + 2×growth) against a fixed AAA bond yield.",
};
const COMPOSITE_EXPLAINER =
  "Average of all methods above after dropping the single highest and lowest.";

// Growth-fit label per method: which investor style the method suits best.
// GROWTH methods project a growth path forward (or price growth directly),
// so they capture a fast grower's upside. MATURE/VALUE methods price off a
// multiple or a fixed formula calibrated to steady, modest growth, so they
// understate a fast grower's fair value. ALL-ROUNDER methods (free-cash-flow
// DCF, EV/EBITDA) sit in between — growth-sensitive but dampened by their
// cash-flow/multiple basis.
export const GROWTH_FIT: Record<string, { label: string; className: string }> = {
  dcf20: { label: "Growth", className: "chip-pos" },
  dni20: { label: "Growth", className: "chip-pos" },
  revDcf: { label: "Growth", className: "chip-pos" },
  peg: { label: "Growth", className: "chip-pos" },
  evRevenue: { label: "Growth", className: "chip-pos" },
  dfcf20: { label: "All-rounder", className: "chip-neutral" },
  evEbitda: { label: "All-rounder", className: "chip-neutral" },
  hmodel: { label: "Mature/Value", className: "chip-accent" },
  pFcf: { label: "Mature/Value", className: "chip-accent" },
  graham: { label: "Mature/Value", className: "chip-accent" },
};

function GrowthFitChip({ methodKey }: { methodKey: string }) {
  const fit = GROWTH_FIT[methodKey];
  if (!fit) return null;
  return (
    <span className={`chip ml-2 !px-1.5 !py-0.5 !text-[10px] ${fit.className}`}>{fit.label}</span>
  );
}

// Investor-style sub-tabs above the method table. Each non-"all" tab filters
// rows to the methods carrying that GROWTH_FIT label — GROWTH_FIT is the
// single source of truth shared by the row chips (above) and this filter, so
// the two can never drift apart.
type StyleTab = "all" | "growth" | "allrounder" | "mature";

const STYLE_TABS: StyleTab[] = ["all", "growth", "allrounder", "mature"];

const TAB_LABEL: Record<StyleTab, string> = {
  all: "All",
  growth: "Growth",
  allrounder: "All-rounder",
  mature: "Mature/Value",
};

// Maps a GROWTH_FIT label back to its sub-tab id.
const FIT_LABEL_TO_TAB: Record<string, StyleTab> = {
  Growth: "growth",
  "All-rounder": "allrounder",
  "Mature/Value": "mature",
};

function defaultTabForClass(cls: "growth" | "balanced" | "mature"): StyleTab {
  if (cls === "growth") return "growth";
  if (cls === "mature") return "mature";
  return "all";
}

// Compact, always-visible provenance strip: WHAT growth/discount figure this
// variant's auto pipeline resolved to and WHERE it came from — the task
// brief's requirement that users see this, not just the resulting number.
// Pure display of assumptionProvenance()'s output; live per variant (textbook
// shows its own uncapped growth/WACC and its own terminal default).
function AssumptionsStrip({
  provenance: p,
  variant,
}: {
  provenance: AssumptionProvenance;
  variant: ValuationVariant;
}) {
  const growthSourceLabel =
    p.growthSource === "sec"
      ? "SEC annual filings"
      : p.growthSource === "yahoo"
        ? "Yahoo Finance statement history"
        : "no revenue history available — default assumed";
  const growthSpanText = p.spanYears
    ? `5Y revenue CAGR FY${p.spanYears[0]}→FY${p.spanYears[1]} from ${growthSourceLabel}`
    : growthSourceLabel;
  const growthClampText = p.clampNote ? ` (${p.clampNote})` : "";

  const waccClampText = !p.waccParts.clamped
    ? ""
    : variant === "textbook"
      ? " (floored at 0.1%)"
      : p.wacc >= 0.12 - 1e-9
        ? " (capped at 12%)"
        : " (floored at 4%)";

  const pegSourceLabel =
    p.pegSource === "sec" ? "SEC annual filings" : p.pegSource === "yahoo" ? "Yahoo Finance" : "default assumption";

  return (
    <div className="rounded-lg border border-line bg-page p-3 text-xs text-ink2">
      <p className="mb-1.5 font-semibold uppercase tracking-wide text-ink3">Assumptions</p>
      <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
        <p>
          <span className="font-medium text-ink">Growth (Y1–5): {pct1(p.growthUsed)}</span> — {growthSpanText}
          {growthClampText}.
        </p>
        <p>
          <span className="font-medium text-ink">Discount: {pct1(p.wacc)}</span> = {pct1(p.waccParts.rf)} risk-free +
          β {p.waccParts.beta.toFixed(2)} × {pct1(p.waccParts.erp)} equity premium{waccClampText}.
        </p>
        <p>
          <span className="font-medium text-ink">PEG growth: {p.pegGrowth === null ? "n/a" : pct1(p.pegGrowth)}</span>{" "}
          — 5Y net-income CAGR from {pegSourceLabel}.
        </p>
        <p>
          <span className="font-medium text-ink">Terminal: {pct1(p.terminal)}</span>{" "}
          {variant === "textbook"
            ? "— linear fade endpoint, plus a Gordon terminal value beyond year 20."
            : "— years 11–20 growth rate; no value is counted beyond year 20."}
        </p>
      </div>
      <p className="mt-2 leading-snug">
        Growth and PEG figures come from the company&apos;s own annual reports via SEC EDGAR, falling back to Yahoo
        Finance&apos;s statement history when EDGAR history is too short.{" "}
        {variant === "textbook"
          ? "This textbook view removes every cap and floor, so a volatile or hyper-growth company can price out at an extreme growth or discount rate."
          : "Calibrated caps and floors keep those figures within the range a professional analyst would typically use."}
      </p>
    </div>
  );
}

export default function ValueTable({
  snapshot,
  updatedDate,
}: {
  snapshot: FinancialSnapshot;
  updatedDate?: string;
}) {
  const [knobs, setKnobs] = useState<KnobInputs>(EMPTY_KNOBS);
  // Global calibrated/textbook selection (VariantProvider, mounted in the
  // stock layout) — the SAME state the header toggle drives, kept in sync
  // per the task brief ("it and the header toggle stay in sync").
  const { variant: activeVariant } = useVariant();
  const [activeHorizon, setActiveHorizon] = useState<Horizon>("current");

  // Pure functions of the snapshot prop — computed client-side, no network
  // request. classifyStock also picks the default sub-tab (lazy initializer
  // so switching tabs afterward doesn't get clobbered by a snapshot re-render).
  const stockClass = useMemo(() => classifyStock(snapshot), [snapshot]);
  const seedCagr = useMemo(() => revenueCagr5y(snapshot), [snapshot]);
  const [activeTab, setActiveTab] = useState<StyleTab>(() => defaultTabForClass(stockClass));

  const setKnob = (key: keyof KnobInputs) => (v: string) =>
    setKnobs((prev) => ({ ...prev, [key]: v }));

  const overrides: Partial<Assumptions> = useMemo(() => {
    const o: Partial<Assumptions> = {};
    const normalGrowth = parsePercent(knobs.normalGrowth);
    const terminalGrowth = parsePercent(knobs.terminalGrowth);
    const marginExpansion = parsePercent(knobs.marginExpansion);
    const wacc = parsePercent(knobs.wacc);
    const hHalfLife = parseNumber(knobs.hHalfLife);
    if (normalGrowth !== undefined) o.normalGrowth = normalGrowth;
    if (terminalGrowth !== undefined) o.terminalGrowth = terminalGrowth;
    if (marginExpansion !== undefined) o.marginExpansion = marginExpansion;
    if (wacc !== undefined) o.wacc = wacc;
    if (hHalfLife !== undefined) o.hHalfLife = hHalfLife;
    return o;
  }, [knobs]);

  // Pure, client-side — no network request. Recomputes on every knob change,
  // variant switch, AND horizon switch (computeValuation is a pure function
  // of all four; the horizon toggle is independent of variant/style tab).
  const out = useMemo(
    () => computeValuation(snapshot, overrides, activeVariant, activeHorizon),
    [snapshot, overrides, activeVariant, activeHorizon]
  );

  const price = snapshot.price;
  const validValues = out.models
    .map((m) => m.value)
    .filter((v): v is number => v !== null);
  const max = Math.max(price, ...validValues, out.composite ?? -Infinity);

  const invalidTerminal = out.assumptions.terminalGrowth >= out.assumptions.wacc;
  const terminalError = invalidTerminal ? "Terminal growth must be below WACC" : undefined;

  // Filtering is display-level only — every model above is still computed for
  // every tab; the "All" tab keeps today's exact composite/range behavior
  // (out.composite / out.range, gated at >=5 valid across all 10 methods).
  const visibleModels =
    activeTab === "all"
      ? out.models
      : out.models.filter((m) => FIT_LABEL_TO_TAB[GROWTH_FIT[m.key]?.label] === activeTab);
  const visibleValid = visibleModels
    .map((m) => m.value)
    .filter((v): v is number => v !== null);

  const styleComp = styleComposite(visibleValid);
  const composite = activeTab === "all" ? out.composite : styleComp.value;
  const compositeMethod = activeTab === "all" ? "trimmed" : styleComp.method;
  // "current" has no forward-looking suffix; q1/q2/nextYear each get their
  // own composite-row label suffix per the task brief ("(1Q forward)" etc).
  const compositeLabel =
    (activeTab === "all"
      ? activeVariant === "textbook"
        ? "Textbook Composite"
        : "Composite"
      : `${TAB_LABEL[activeTab]} composite`) + HORIZON_FORWARD_SUFFIX[activeHorizon];
  const compositeVariant =
    activeTab === "all"
      ? "Trimmed mean"
      : compositeMethod === "trimmed"
        ? `Trimmed mean · ${visibleValid.length} of ${visibleModels.length} methods`
        : compositeMethod === "mean"
          ? `Plain mean · ${visibleValid.length} methods`
          : "n/a";

  const rangeText =
    activeTab === "all"
      ? out.range
        ? `${fmtMoney(out.range.min, snapshot.currency)} – ${fmtMoney(out.range.max, snapshot.currency)}`
        : "n/a"
      : visibleValid.length > 0
        ? `${fmtMoney(Math.min(...visibleValid), snapshot.currency)} – ${fmtMoney(Math.max(...visibleValid), snapshot.currency)}`
        : "n/a";

  const seedCagrText = seedCagr === null ? "n/a" : `${(seedCagr * 100).toFixed(0)}%`;
  const classCaptionLabel =
    stockClass === "growth" ? "growth stock" : stockClass === "balanced" ? "balanced stock" : "mature/value stock";

  const compositeUpside = out.composite !== null ? out.composite / price - 1 : null;

  // Assumption provenance strip: WHAT growth/discount figure this variant's
  // auto pipeline resolved to and WHERE it came from — pure function of
  // snapshot + variant (unaffected by manual knob overrides below, which are
  // already visible as their own placeholder/typed values in the Assumptions
  // card at the bottom of this table).
  const provenance = useMemo(
    () => assumptionProvenance(snapshot, activeVariant),
    [snapshot, activeVariant]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <span className="text-2xl font-semibold text-ink">
              {out.composite === null ? "n/a" : fmtMoney(out.composite, snapshot.currency)}
            </span>
            <SignalBadge upside={compositeUpside} />
          </div>
          <p className="mt-1 text-xs text-ink2">
            {VARIANT_LABEL[activeVariant]} composite
            {HORIZON_FORWARD_SUFFIX[activeHorizon]}
            {activeHorizon === "current" &&
              compositeUpside !== null &&
              ` · ${compositeUpside >= 0 ? "+" : ""}${(compositeUpside * 100).toFixed(1)}% vs price`}
            {updatedDate && ` · Updated ${updatedDate}`}
          </p>
          {activeHorizon !== "current" && compositeUpside !== null && (
            <p className={`mt-0.5 text-xs font-medium ${compositeUpside >= 0 ? "text-green" : "text-red"}`}>
              Implied {HORIZON_RETURN_LABEL[activeHorizon]} return vs today&apos;s price:{" "}
              {compositeUpside >= 0 ? "+" : ""}
              {(compositeUpside * 100).toFixed(1)}%
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <VariantToggle />
          <div className="flex gap-1" role="group" aria-label="Valuation horizon">
            {HORIZONS.map((h, i) => (
              <HorizonButton
                key={h}
                horizon={h}
                active={activeHorizon === h}
                // Reason: with 4 compact buttons packed on one row, a "left"
                // anchor on the right-hand buttons pushed their w-72 tooltip
                // past the viewport edge on narrow screens — inflating
                // document.body.scrollWidth into page-level horizontal
                // scroll (this control isn't wrapped by any overflow-hidden
                // card, unlike the tables). Right half of the row opens its
                // tooltip toward the left instead, staying on-screen.
                align={i >= HORIZONS.length / 2 ? "right" : "left"}
                onClick={() => setActiveHorizon(h)}
              />
            ))}
          </div>
        </div>
      </div>

      <AssumptionsStrip provenance={provenance} variant={activeVariant} />

      <div className="flex flex-wrap items-center gap-4 text-xs text-ink2">
        {LEGEND.map((l) => (
          <span key={l.label} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-sm ${l.color}`} />
            {l.label}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="flex flex-wrap gap-1" aria-label="Filter methods by investor style">
          {STYLE_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              aria-current={activeTab === tab ? "page" : undefined}
              className={`tab-btn !px-3 !py-1.5 !text-xs ${activeTab === tab ? "active" : ""}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === "all" ? `All (${out.models.length})` : TAB_LABEL[tab]}
            </button>
          ))}
        </nav>
        <p className="text-xs text-ink2">
          Auto-detected: {classCaptionLabel} (5Y revenue CAGR {seedCagrText})
        </p>
      </div>

      <section className="card overflow-hidden">
        {/* Wide 10-method table clips on narrow viewports without this —
            min-w-max keeps the table at its natural content width so this
            div scrolls horizontally instead of squishing columns. */}
        <div className="overflow-x-auto">
        <table className="w-full min-w-max text-sm">
          <thead className="bg-page text-left text-[11px] text-ink2">
            <tr>
              <th className="px-4 py-2 font-medium uppercase tracking-wide">Method</th>
              <th className="px-4 py-2 font-medium uppercase tracking-wide">Variant</th>
              <th className="px-4 py-2 font-medium uppercase tracking-wide">Implied value</th>
              <th className="w-1/3 px-4 py-2 font-medium uppercase tracking-wide">
                Relative to price
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleModels.map((m) => (
              <tr key={m.key} className="border-t border-line">
                <td className="px-4 py-3">
                  <span className="font-semibold text-ink">{m.name}</span>
                  <GrowthFitChip methodKey={m.key} />
                  {METHOD_EXPLAINERS[m.key] && (
                    <p className="mt-0.5 max-w-xs text-xs font-normal leading-snug text-ink2">
                      {METHOD_EXPLAINERS[m.key]}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 text-ink2">{m.variant}</td>
                <td className="num px-4 py-3">
                  {m.value === null ? (
                    <span className="text-xs italic text-ink2">{m.note}</span>
                  ) : (
                    fmtMoney(m.value, snapshot.currency)
                  )}
                </td>
                <td className="px-4 py-3">
                  {m.value !== null && <Bar value={m.value} price={price} max={max} />}
                </td>
              </tr>
            ))}
            <tr className="border-t border-line bg-accent-tint">
              <td className="px-4 py-3">
                <span className="font-semibold text-accent">{compositeLabel}</span>
                <p className="mt-0.5 max-w-xs text-xs font-normal leading-snug text-ink2">
                  {COMPOSITE_EXPLAINER}
                  {HORIZON_EXPLAINER_SUFFIX[activeHorizon]}
                </p>
              </td>
              <td className="px-4 py-3 text-ink2">{compositeVariant}</td>
              <td className="num px-4 py-3 font-semibold">
                {composite === null ? (
                  <span className="text-xs italic text-ink2">
                    {activeTab === "all" ? "n/a — fewer than 5 valid methods" : "n/a — too few methods"}
                  </span>
                ) : (
                  fmtMoney(composite, snapshot.currency)
                )}
              </td>
              <td className="px-4 py-3">
                {composite !== null && <Bar value={composite} price={price} max={max} highlight />}
              </td>
            </tr>
          </tbody>
        </table>
        </div>
        <p className="border-t border-line bg-page px-4 py-2 text-xs text-ink2">
          {visibleValid.length} of {visibleModels.length} methods · range {rangeText}
        </p>
        <p className="border-t border-line bg-page px-4 pb-2 text-xs text-ink2">
          {activeVariant === "textbook" ? (
            <>
              Textbook (no caps): growth auto = own 5Y revenue CAGR, uncapped; years 1-20 fade
              linearly to the terminal rate, PLUS a terminal (Gordon) value for everything
              beyond year 20. Auto WACC = pure CAPM (10-yr treasury + beta x 5.5%), uncapped.
              Bases are audited fiscal-year figures; multiples use own-history only. PEG and
              Graham use uncapped growth. GROWTH-tagged methods handle fast growers best;
              MATURE/VALUE methods assume steady cash flows and will undervalue growth stocks.
            </>
          ) : (
            <>
              Growth auto = own 5Y revenue CAGR (cap 30%); years 6-10 fade to 70% of it, years
              11-20 grow at the terminal rate; no value is credited beyond year 20. Auto WACC =
              CAPM (10-yr treasury + beta x 5.5%) capped at 12%. PEG uses the 5Y net-income CAGR
              unless you set the growth knob. GROWTH-tagged methods handle fast growers best;
              MATURE/VALUE methods assume steady cash flows and will undervalue growth stocks.
            </>
          )}
        </p>
        <div className="border-t border-line bg-page p-4">
          <h2 className="mb-4 text-sm font-semibold text-ink3">Assumptions</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <KnobField
              label={<Term k="cagr">Normal growth %</Term>}
              value={knobs.normalGrowth}
              placeholder={`${(out.autoNormalGrowth * 100).toFixed(1)}% (auto)`}
              onChange={setKnob("normalGrowth")}
            />
            <KnobField
              label={<Term k="terminalGrowth">Terminal growth %</Term>}
              value={knobs.terminalGrowth}
              placeholder={`${(out.assumptions.terminalGrowth * 100).toFixed(1)} (auto)`}
              onChange={setKnob("terminalGrowth")}
              error={terminalError}
            />
            <KnobField
              label="Margin expansion %"
              value={knobs.marginExpansion}
              placeholder="0"
              onChange={setKnob("marginExpansion")}
            />
            <KnobField
              label={<Term k="wacc">WACC %</Term>}
              value={knobs.wacc}
              placeholder={`${(out.autoWacc * 100).toFixed(1)}% (auto)`}
              onChange={setKnob("wacc")}
              error={terminalError}
            />
            <KnobField
              label="H half-life (yrs)"
              value={knobs.hHalfLife}
              placeholder="4"
              onChange={setKnob("hHalfLife")}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
