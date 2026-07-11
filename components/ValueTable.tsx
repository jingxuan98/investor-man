"use client";

import { useMemo, useState } from "react";
import { computeValuation } from "@/lib/finance/valuation";
import { classifyStock, revenueCagr5y } from "@/lib/finance/assumptions";
import { styleComposite } from "@/lib/finance/helpers";
import { Assumptions, FinancialSnapshot, ValuationVariant } from "@/lib/finance/types";
import { fmtMoney } from "@/lib/format";
import KnobField from "@/components/KnobField";
import Term from "@/components/Term";
import SignalBadge from "@/components/SignalBadge";

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

const VARIANT_LABEL: Record<ValuationVariant, string> = {
  calibrated: "Calibrated",
  textbook: "Textbook (no caps)",
};

const VARIANT_TOOLTIP: Record<ValuationVariant, string> = {
  calibrated:
    "Calibrated to a professional reference calculator: growth capped 30%, discount capped 12%, no value counted beyond year 20, TTM cash flows, sector multiples.",
  textbook:
    "Classic finance-textbook DCF: uncapped CAPM discount, uncapped growth, linear fade PLUS a terminal value for the business beyond year 20, audited fiscal-year figures, own-history multiples only. Punishes volatile stocks harder and rewards durable ones more.",
};

// Segmented variant toggle. Mirrors Term.tsx's hover-tooltip pattern (same
// group/tooltip CSS classes) so the popover matches the app's design system.
// The custom card is the only tooltip UI — `aria-label` (not `title`) carries
// the text for assistive tech so we never double up with a native browser
// tooltip. `align` flips the card's anchor/origin so it opens toward the
// inside of the toggle group instead of running off the edge of the section.
function VariantButton({
  variant,
  active,
  align,
  onClick,
}: {
  variant: ValuationVariant;
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
      aria-label={VARIANT_TOOLTIP[variant]}
      className={`group relative tab-btn !px-3 !py-1.5 !text-xs ${active ? "active" : ""}`}
      onClick={onClick}
    >
      {VARIANT_LABEL[variant]}
      <span
        role="tooltip"
        className={`pointer-events-none absolute top-full z-50 mt-1.5 w-72 max-w-[calc(100vw-2rem)] scale-95 whitespace-normal break-words rounded-lg border border-line bg-card p-2.5 text-xs font-normal normal-case leading-snug tracking-normal text-ink3 opacity-0 shadow-lg transition-all duration-150 group-hover:scale-100 group-hover:opacity-100 ${posClass}`}
      >
        {VARIANT_TOOLTIP[variant]}
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

export default function ValueTable({
  snapshot,
  updatedDate,
}: {
  snapshot: FinancialSnapshot;
  updatedDate?: string;
}) {
  const [knobs, setKnobs] = useState<KnobInputs>(EMPTY_KNOBS);
  const [activeVariant, setActiveVariant] = useState<ValuationVariant>("calibrated");

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

  // Pure, client-side — no network request. Recomputes on every knob change
  // AND on variant switch (computeValuation is a pure function of all three).
  const out = useMemo(
    () => computeValuation(snapshot, overrides, activeVariant),
    [snapshot, overrides, activeVariant]
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
  const compositeLabel =
    activeTab === "all"
      ? activeVariant === "textbook"
        ? "Textbook Composite"
        : "Composite"
      : `${TAB_LABEL[activeTab]} composite`;
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
            {compositeUpside !== null &&
              ` · ${compositeUpside >= 0 ? "+" : ""}${(compositeUpside * 100).toFixed(1)}% vs price`}
            {updatedDate && ` · Updated ${updatedDate}`}
          </p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Valuation methodology variant">
          <VariantButton
            variant="calibrated"
            active={activeVariant === "calibrated"}
            align="left"
            onClick={() => setActiveVariant("calibrated")}
          />
          <VariantButton
            variant="textbook"
            active={activeVariant === "textbook"}
            align="right"
            onClick={() => setActiveVariant("textbook")}
          />
        </div>
      </div>

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
        <table className="w-full text-sm">
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
