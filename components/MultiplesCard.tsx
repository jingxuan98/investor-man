import { multiplesComparison, pegMultipleRow, MultipleRow } from "@/lib/finance/insights";
import { FinancialSnapshot } from "@/lib/finance/types";
import { fmtMoney, fmtRatio } from "@/lib/format";
import Term from "@/components/Term";

function fmtMult(n: number | null): string {
  return n === null ? "n/a" : `${n.toFixed(1)}x`;
}

// Wraps the glossary-eligible piece of each row's multiple name (EV, P/E,
// FCF) in a hover Term — "EV / EBITDA" and "EV / Revenue" both hover on the
// "EV" half; "P / FCF" hovers on the "FCF" half; "P / E" hovers as a whole.
function MultipleName({ r }: { r: MultipleRow }) {
  if (r.key === "pe") return <Term k="pe">{r.name}</Term>;
  if (r.key === "evEbitda" || r.key === "evRev") {
    const rest = r.name.replace(/^EV \/ /, "");
    return (
      <>
        <Term k="ev">EV</Term> / {rest}
      </>
    );
  }
  if (r.key === "pFcf") {
    return (
      <>
        P / <Term k="fcf">FCF</Term>
      </>
    );
  }
  return <>{r.name}</>;
}

export default function MultiplesCard({ snapshot }: { snapshot: FinancialSnapshot }) {
  const rows = multiplesComparison(snapshot);
  const peg = pegMultipleRow(snapshot);

  return (
    <div className="card overflow-hidden">
      {/* overflow-x-auto + min-w-max so this wide table scrolls within the
          card on narrow viewports instead of clipping/squishing. */}
      <div className="overflow-x-auto">
      <table className="w-full min-w-max text-sm">
        <thead className="bg-page text-left text-[11px] text-ink2">
          <tr>
            <th className="px-4 py-2 font-medium uppercase tracking-wide">Multiple</th>
            <th className="px-4 py-2 font-medium uppercase tracking-wide">Current</th>
            <th className="px-4 py-2 font-medium uppercase tracking-wide">Own 5Y median</th>
            <th className="px-4 py-2 font-medium uppercase tracking-wide">Sector median</th>
            <th className="px-4 py-2 font-medium uppercase tracking-wide">Premium to sector</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-line">
              <td className="px-4 py-3 font-semibold text-ink">
                <MultipleName r={r} />
              </td>
              <td className="num px-4 py-3">{fmtMult(r.current)}</td>
              <td className="num px-4 py-3">
                {fmtMult(r.ownHistoryMedian)}
                {r.ownImpliedPrice !== null && (
                  <span className="ml-1 text-xs text-ink2">
                    ({fmtMoney(r.ownImpliedPrice, snapshot.currency)})
                  </span>
                )}
              </td>
              <td className="num px-4 py-3">
                {fmtMult(r.sectorMedian)}
                {r.sectorImpliedPrice !== null && (
                  <span className="ml-1 text-xs text-ink2">
                    ({fmtMoney(r.sectorImpliedPrice, snapshot.currency)})
                  </span>
                )}
              </td>
              <td className="num px-4 py-3">
                {r.premiumToSectorPct === null ? (
                  <span className="text-xs italic text-ink2">n/a</span>
                ) : (
                  <span className={r.premiumToSectorPct <= 0 ? "text-green" : "text-red"}>
                    {r.premiumToSectorPct >= 0 ? "+" : ""}
                    {r.premiumToSectorPct.toFixed(1)}%
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <p className="border-t border-line bg-page px-4 py-2 text-xs text-ink2">
        Own 5Y median from the company&apos;s own trading history; sector median is a fixed
        lookup table by sector. Implied price shown in parentheses. n/a when the underlying
        metric or sector isn&apos;t available.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-max text-sm">
          <thead className="bg-page text-left text-[11px] text-ink2">
            <tr>
              <th className="px-4 py-2 font-medium uppercase tracking-wide">Multiple</th>
              <th className="px-4 py-2 font-medium uppercase tracking-wide">Current</th>
              <th className="px-4 py-2 font-medium uppercase tracking-wide">Fair (PEG = 1.0)</th>
              <th className="px-4 py-2 font-medium uppercase tracking-wide">Sector-implied</th>
              <th className="px-4 py-2 font-medium uppercase tracking-wide">Premium to sector</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-line">
              <td className="px-4 py-3 font-semibold text-ink">
                <Term k="peg">PEG</Term>
              </td>
              <td className="num px-4 py-3">{fmtRatio(peg.current)}</td>
              <td className="num px-4 py-3">
                {peg.fairImpliedPrice === null ? (
                  "n/a"
                ) : (
                  <>
                    {fmtRatio(1.0)}
                    <span className="ml-1 text-xs text-ink2">
                      ({fmtMoney(peg.fairImpliedPrice, snapshot.currency)})
                    </span>
                  </>
                )}
              </td>
              <td className="num px-4 py-3">{fmtRatio(peg.sectorImpliedPeg)}</td>
              <td className="num px-4 py-3">
                {peg.premiumToSectorPct === null ? (
                  <span className="text-xs italic text-ink2">n/a</span>
                ) : (
                  <span className={peg.premiumToSectorPct <= 0 ? "text-green" : "text-red"}>
                    {peg.premiumToSectorPct >= 0 ? "+" : ""}
                    {peg.premiumToSectorPct.toFixed(1)}%
                  </span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="border-t border-line bg-page px-4 py-2 text-xs text-ink2">
        PEG = P/E ÷ expected growth. Peter Lynch&apos;s rule of thumb treats PEG ≈ 1 as roughly
        fair value; &quot;Sector-implied&quot; shows what this stock&apos;s PEG would be if it
        traded at the sector&apos;s median P/E instead of its own.
      </p>
    </div>
  );
}
