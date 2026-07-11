import { epv, ownerYield } from "@/lib/finance/insights";
import { FinancialSnapshot } from "@/lib/finance/types";
import { fmtMoney, fmtPct } from "@/lib/format";
import Term from "@/components/Term";

function pricingVerdict(growthPremiumPct: number | null): { label: string; className: string } {
  if (growthPremiumPct === null) return { label: "n/a", className: "text-ink2" };
  if (growthPremiumPct < 0) return { label: "cheap", className: "text-green" };
  if (growthPremiumPct <= 50) return { label: "fair", className: "text-amber" };
  return { label: "expensive", className: "text-red" };
}

function yieldVerdict(spreadPp: number | null): { label: string; className: string } {
  if (spreadPp === null) return { label: "n/a", className: "text-ink2" };
  if (spreadPp > 2) return { label: "attractive", className: "text-green" };
  if (spreadPp >= -2) return { label: "neutral", className: "text-amber" };
  return { label: "avoid", className: "text-red" };
}

export default function EpvCard({ snapshot }: { snapshot: FinancialSnapshot }) {
  const e = epv(snapshot);
  const oy = ownerYield(snapshot);

  const pv = pricingVerdict(e.growthPremiumPct);
  const yv = yieldVerdict(oy.spreadVsTreasuryPp);

  return (
    <div className="card overflow-hidden">
      <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <div className="p-6">
          <p className="kpi-label">
            <Term k="epv">Earnings Power Value</Term> / share
          </p>
          <p className="num mt-1 text-2xl font-semibold text-ink">
            {e.epvPerShare === null ? (
              <span className="text-lg italic text-ink2">n/a</span>
            ) : (
              fmtMoney(e.epvPerShare, snapshot.currency)
            )}
          </p>
          <p className="mt-2 text-sm text-ink2">
            {e.epvPerShare === null ? (
              <span className="italic">{e.note}</span>
            ) : (
              <>
                Price embeds a{" "}
                <span className={e.growthPremiumPct! >= 0 ? "text-red" : "text-green"}>
                  {fmtPct((e.growthPremiumPct ?? 0) / 100)}
                </span>{" "}
                growth premium over no-growth <Term k="epv">EPV</Term>.
              </>
            )}
          </p>
        </div>
        <div className="p-6">
          <p className="kpi-label">
            <Term k="ownerEarnings">Owner-Earnings</Term>{" "}
            <Term k="ownerYield">yield vs 10Y treasury</Term>
          </p>
          <p className="num mt-1 text-2xl font-semibold text-ink">
            {oy.yieldPct === null ? (
              <span className="text-lg italic text-ink2">n/a</span>
            ) : (
              `${oy.yieldPct.toFixed(1)}%`
            )}
          </p>
          <p className="mt-2 text-sm text-ink2">
            {oy.spreadVsTreasuryPp === null ? (
              <span className="italic">{oy.note}</span>
            ) : (
              <>
                <span className={oy.spreadVsTreasuryPp >= 0 ? "text-green" : "text-red"}>
                  {oy.spreadVsTreasuryPp >= 0 ? "+" : ""}
                  {oy.spreadVsTreasuryPp.toFixed(1)}pp
                </span>{" "}
                spread vs 10Y treasury ({(snapshot.riskFreeRate * 100).toFixed(1)}%).
              </>
            )}
          </p>
        </div>
      </div>
      <p className="border-t border-line bg-page px-6 py-3 text-sm">
        <span className={`font-semibold ${pv.className}`}>{pv.label}</span>
        <span className="text-ink2"> · </span>
        <span className={`font-semibold ${yv.className}`}>{yv.label}</span>
      </p>
    </div>
  );
}
