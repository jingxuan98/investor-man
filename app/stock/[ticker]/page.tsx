import { notFound } from "next/navigation";
import { getStockBundle } from "@/lib/data/getStockData";
import { fmtMoney, fmtPct } from "@/lib/format";
import SignalBadge, { getSignal, SIGNAL_VALUATION_PHRASE } from "@/components/SignalBadge";
import CompetitorsPanel from "@/components/CompetitorsPanel";
import GateCard from "@/components/GateCard";

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

export default async function StockOverviewPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = await params;
  // Guard again here (not just in the layout): notFound() thrown from a
  // parent layout does not trigger a not-found.tsx in that same segment
  // (Next.js caveat), so the page itself must also validate the ticker for
  // our custom not-found UI to render instead of the framework default.
  let bundle;
  try {
    bundle = await getStockBundle(ticker);
  } catch {
    notFound();
  }
  const { snapshot: s, valuation: v, gate } = bundle;

  const upside = v.composite !== null ? v.composite / s.price - 1 : null;
  const signal = getSignal(upside);

  // Quality word for the verdict now comes from the Quality Gate grade:
  // A/B → High-quality, C → Decent, D/F → Low-quality.
  const qualityLabel =
    gate.grade === "A" || gate.grade === "B"
      ? "High-quality"
      : gate.grade === "C"
        ? "Decent"
        : "Low-quality";

  const verdict =
    v.composite === null
      ? "We couldn't compute a fair value estimate for this stock — see Intrinsic Value for details."
      : `${qualityLabel} business trading ${SIGNAL_VALUATION_PHRASE[signal]}.`;

  const rangeText = v.range
    ? `${fmtMoney(v.range.min, s.currency)} – ${fmtMoney(v.range.max, s.currency)}`
    : "n/a";

  const upsideClass = upside === null ? undefined : upside > 0 ? "text-green" : "text-red";

  return (
    <div className="space-y-10">
      <section>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <SignalBadge upside={upside} />
          <p className="text-ink3">{verdict}</p>
        </div>
        <div className="card flex flex-col divide-y divide-line overflow-hidden sm:flex-row sm:divide-x sm:divide-y-0">
          <StatCell
            label="Composite Fair Value"
            value={fmtMoney(v.composite, s.currency)}
            valueClass={upsideClass}
          />
          <StatCell label="Market Price" value={fmtMoney(s.price, s.currency)} />
          <StatCell label="Implied Upside" value={fmtPct(upside)} valueClass={upsideClass} />
          <StatCell label="Method Range" value={rangeText} />
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-xl font-semibold text-ink">Quality</h2>
        <GateCard gate={gate} />
      </section>

      <section>
        <h2 className="mb-4 text-xl font-semibold text-ink">Competitors</h2>
        <CompetitorsPanel ticker={s.ticker} />
      </section>
    </div>
  );
}
