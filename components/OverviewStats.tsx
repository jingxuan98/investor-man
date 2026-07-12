"use client";

import { useVariant } from "@/components/VariantProvider";
import SignalBadge, { getSignal, SIGNAL_VALUATION_PHRASE } from "@/components/SignalBadge";
import { fmtMoney, fmtPct } from "@/lib/format";

function StatCell({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="kpi-cell flex-1">
      <p className="kpi-label">{label}</p>
      <p className={`num kpi-value ${valueClass ?? ""}`}>{value}</p>
    </div>
  );
}

interface VariantStat {
  composite: number | null;
  range: { min: number; max: number } | null;
}

// Overview's signal badge/verdict/stat row, made variant-aware: picking
// "Textbook" in the header must change these numbers too, without a
// server round-trip — `stats` is the pre-computed pair (both variants
// server-side, see lib/data/getStockData.ts's variantPair), and this leaf
// just selects half of it via useVariant(). `qualityLabel` (High-quality /
// Decent / Low-quality) comes from the Quality GATE, which is deliberately
// variant-independent (see StockBundle.gate), so it's passed in as a plain
// string rather than a pair.
export default function OverviewStats({
  price,
  currency,
  qualityLabel,
  stats,
}: {
  price: number;
  currency: string;
  qualityLabel: string;
  stats: { calibrated: VariantStat; textbook: VariantStat };
}) {
  const { variant } = useVariant();
  const v = stats[variant];

  const upside = v.composite !== null ? v.composite / price - 1 : null;
  const signal = getSignal(upside);

  const verdict =
    v.composite === null
      ? "We couldn't compute a fair value estimate for this stock — see Intrinsic Value for details."
      : `${qualityLabel} business trading ${SIGNAL_VALUATION_PHRASE[signal]}.`;

  const rangeText = v.range ? `${fmtMoney(v.range.min, currency)} – ${fmtMoney(v.range.max, currency)}` : "n/a";
  const upsideClass = upside === null ? undefined : upside > 0 ? "text-green" : "text-red";

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SignalBadge upside={upside} />
        <p className="text-ink3">{verdict}</p>
      </div>
      <div className="card flex flex-col divide-y divide-line overflow-hidden sm:flex-row sm:divide-x sm:divide-y-0">
        <StatCell label="Composite Fair Value" value={fmtMoney(v.composite, currency)} valueClass={upsideClass} />
        <StatCell label="Market Price" value={fmtMoney(price, currency)} />
        <StatCell label="Implied Upside" value={fmtPct(upside)} valueClass={upsideClass} />
        <StatCell label="Method Range" value={rangeText} />
      </div>
    </>
  );
}
