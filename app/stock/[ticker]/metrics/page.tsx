import { notFound } from "next/navigation";
import { getStockBundle } from "@/lib/data/getStockData";
import { YearData } from "@/lib/finance/types";
import { fmtBig, fmtPct } from "@/lib/format";
import TrendBars from "@/components/TrendBars";
import Term from "@/components/Term";

const TAX_RATE = 0.21;

// value.toFixed(2), guarding null/NaN/Infinity — never renders "NaN" or "Infinity".
function fmtRatio(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "n/a";
  return v.toFixed(2);
}

// Same as fmtRatio but treats +Infinity (no interest expense, positive op income) as "∞".
function fmtCoverage(v: number | null): string {
  if (v === Infinity) return "∞";
  if (v === null || !Number.isFinite(v)) return "n/a";
  return v.toFixed(2);
}

// YoY growth cell: blank in the first (oldest) column since there's no prior year to compare.
function fmtGrowth(v: number | null, i: number): string {
  return i === 0 ? "" : fmtPct(v);
}

// cur/prev - 1, guarding the missing/zero-prev cases; index 0 is always null (no prior year).
function yoyGrowth(years: YearData[], pick: (y: YearData) => number | null): (number | null)[] {
  return years.map((y, i) => {
    if (i === 0) return null;
    const cur = pick(y);
    const prev = pick(years[i - 1]);
    // Reason: a non-positive prior year makes the % sign flip meaninglessly
    // (e.g. -100 → +50 reads as "+150%" growth), so suppress it.
    if (cur === null || prev === null || prev <= 0) return null;
    return cur / prev - 1;
  });
}

interface Row {
  label: React.ReactNode;
  key: string; // stable identity — label may now be JSX (Term-wrapped), not always a plain string
  values: (number | null)[];
  format: (v: number | null, i: number) => string;
}

export default async function MetricsPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = await params;
  // Guard again here (not just in the layout): notFound() thrown from a
  // parent layout does not trigger a not-found.tsx in that same segment
  // (Next.js caveat), so the page itself must also validate the ticker for
  // our custom not-found UI to render instead of the framework default.
  let snapshot;
  try {
    ({ snapshot } = await getStockBundle(ticker));
  } catch {
    notFound();
  }

  // snapshot.years is NEWEST first; reverse so table columns read oldest -> newest.
  const years = [...snapshot.years].reverse();

  const revenue = years.map((y) => y.revenue);
  const netIncome = years.map((y) => y.netIncome);
  const freeCF = years.map((y) => y.freeCashFlow);
  const totalDebt = years.map((y) => y.totalDebt);

  const grossMargin = years.map((y) => (y.revenue && y.grossProfit !== null ? y.grossProfit / y.revenue : null));
  const operatingMargin = years.map((y) =>
    y.revenue && y.operatingIncome !== null ? y.operatingIncome / y.revenue : null
  );
  const netMargin = years.map((y) => (y.revenue && y.netIncome !== null ? y.netIncome / y.revenue : null));
  const debtToEquity = years.map((y) =>
    y.equity && y.equity > 0 && y.totalDebt !== null ? y.totalDebt / y.equity : null
  );
  const currentRatio = years.map((y) =>
    y.currentLiabilities && y.currentLiabilities > 0 && y.currentAssets !== null
      ? y.currentAssets / y.currentLiabilities
      : null
  );
  const interestCoverage = years.map((y) =>
    y.interestExpense && y.interestExpense > 0 && y.operatingIncome !== null
      ? y.operatingIncome / y.interestExpense
      : y.operatingIncome !== null && y.operatingIncome > 0
        ? Infinity // no interest expense = effectively infinite coverage
        : null
  );
  const roe = years.map((y) => (y.equity && y.netIncome !== null ? y.netIncome / y.equity : null));
  const roic = years.map((y) => {
    const investedCapital = y.equity !== null ? y.equity + (y.totalDebt ?? 0) - (y.cash ?? 0) : null;
    return investedCapital && investedCapital > 0 && y.operatingIncome !== null
      ? (y.operatingIncome * (1 - TAX_RATE)) / investedCapital
      : null;
  });

  const rows: Row[] = [
    { key: "revenue", label: "Revenue", values: revenue, format: fmtBig },
    { key: "revenueGrowth", label: "Revenue growth YoY", values: yoyGrowth(years, (y) => y.revenue), format: fmtGrowth },
    { key: "grossMargin", label: <Term k="grossMargin">Gross margin</Term>, values: grossMargin, format: fmtPct },
    { key: "operatingMargin", label: "Operating margin", values: operatingMargin, format: fmtPct },
    { key: "netMargin", label: "Net margin", values: netMargin, format: fmtPct },
    { key: "netIncome", label: "Net income", values: netIncome, format: fmtBig },
    { key: "ebitda", label: <Term k="ebitda">EBITDA</Term>, values: years.map((y) => y.ebitda), format: fmtBig },
    { key: "operatingCf", label: "Operating CF", values: years.map((y) => y.operatingCashFlow), format: fmtBig },
    { key: "capex", label: "Capex", values: years.map((y) => y.capex), format: fmtBig },
    { key: "freeCf", label: <Term k="fcf">Free CF</Term>, values: freeCF, format: fmtBig },
    { key: "fcfGrowth", label: "FCF growth YoY", values: yoyGrowth(years, (y) => y.freeCashFlow), format: fmtGrowth },
    { key: "totalDebt", label: "Total debt", values: totalDebt, format: fmtBig },
    { key: "cash", label: "Cash", values: years.map((y) => y.cash), format: fmtBig },
    { key: "debtToEquity", label: <Term k="debtToEquity">Debt/Equity</Term>, values: debtToEquity, format: fmtRatio },
    { key: "currentRatio", label: <Term k="currentRatio">Current ratio</Term>, values: currentRatio, format: fmtRatio },
    {
      key: "interestCoverage",
      label: <Term k="interestCoverage">Interest coverage</Term>,
      values: interestCoverage,
      format: fmtCoverage,
    },
    { key: "roe", label: <Term k="roe">ROE</Term>, values: roe, format: fmtPct },
    { key: "roic", label: <Term k="roic">ROIC</Term>, values: roic, format: fmtPct },
    { key: "sharesOutstanding", label: "Shares outstanding", values: years.map((y) => y.sharesOutstanding), format: fmtBig },
    // Skip a row entirely when every year's value is null (e.g. tickers missing a field).
  ].filter((row) => row.values.some((v) => v !== null));

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card p-4">
          <TrendBars values={revenue} label="Revenue" />
        </div>
        <div className="card p-4">
          <TrendBars values={netIncome} label="Net income" />
        </div>
        <div className="card p-4">
          <TrendBars values={freeCF} label="Free CF" />
        </div>
        <div className="card p-4">
          <TrendBars values={totalDebt} label="Total debt" />
        </div>
      </section>

      <section className="card overflow-x-auto">
        <table className="w-full min-w-max text-sm">
          <thead className="bg-page text-left text-[11px] text-ink2">
            <tr>
              <th className="px-4 py-2 font-medium uppercase tracking-wide">Metric</th>
              {years.map((y) => (
                <th key={y.year} className="px-4 py-2 text-right font-medium uppercase tracking-wide">
                  {y.year}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-line">
                <td className="px-4 py-2 font-medium text-ink">{row.label}</td>
                {row.values.map((v, i) => (
                  <td key={i} className="num px-4 py-2 text-right text-ink3">
                    {row.format(v, i)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
