import { notFound } from "next/navigation";
import { getStockBundle } from "@/lib/data/getStockData";
import { GateOutput } from "@/lib/finance/gate";
import { dimensionChip, buildAnalystNote } from "@/lib/finance/insightNote";
import { fmtMoney, fmtPct } from "@/lib/format";
import GradeBadge from "@/components/GradeBadge";
import InsightPeerPanel from "@/components/InsightPeerPanel";
import Term from "@/components/Term";

// Reference-site dimension ordering: Predictability, Profitability, Growth,
// Economic moat, Financial strength, Valuation.
const DIM_ORDER = ["predictability", "profitability", "growth", "moat", "finStrength", "valuation"];

const TIER_COLOR: Record<string, string> = {
  HIGH: "text-green",
  WIDE: "text-green",
  CHEAP: "text-green",
  FAIR: "text-amber",
  NARROW: "text-amber",
  WEAK: "text-red",
  NONE: "text-red",
  OVERVALUED: "text-red",
  "N/A": "text-ink2",
};
const TIER_FILL: Record<string, string> = {
  HIGH: "bg-green",
  WIDE: "bg-green",
  CHEAP: "bg-green",
  FAIR: "bg-amber",
  NARROW: "bg-amber",
  WEAK: "bg-red",
  NONE: "bg-red",
  OVERVALUED: "bg-red",
  "N/A": "bg-ink2",
};

// Pull an already-computed reading string out of the Quality Gate's factors
// (bundle.gate.factors[].readings) instead of recomputing ROIC / buyback
// yield from scratch — the numbers must match the Metrics/Gate views exactly.
function gateReading(gate: GateOutput, factorKey: string, label: string): string | null {
  const f = gate.factors.find((x) => x.key === factorKey);
  const r = f?.readings.find((x) => x.label === label);
  return r ? r.value : null;
}

function Kicker({ index, title, subtitle }: { index: string; title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink2">
        {index} · {title}
      </p>
      {subtitle && <p className="mt-1 text-sm text-ink2">{subtitle}</p>}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <section className="card p-6">{children}</section>;
}

export default async function InsightPage({
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
  const { snapshot: s, valuation: v, quality: q, gate } = bundle;
  const ccy = s.currency;

  const orderedDims = [...q.dimensions].sort(
    (a, b) => DIM_ORDER.indexOf(a.key) - DIM_ORDER.indexOf(b.key)
  );

  const roicReading = gateReading(gate, "roicVsWacc", "ROIC") ?? "n/a";
  const buybackReading = gateReading(gate, "capitalAllocation", "Buyback yield") ?? "n/a";

  // Debt/Equity isn't exposed as a gate reading (only ROIC and buyback yield
  // are), so it's read directly off the latest statement year here — same
  // one-line formula already used inline in Metrics and Grading, not a new
  // scoring computation.
  const y0 = s.years[0];
  const dte = y0 && y0.equity && y0.equity > 0 && y0.totalDebt !== null ? y0.totalDebt / y0.equity : null;
  const dteReading = dte === null ? "n/a" : `${dte.toFixed(2)}×`;

  const upside = v.composite !== null ? v.composite / s.price - 1 : null;
  const upsideClass = upside === null ? "text-ink2" : upside >= 0 ? "text-green" : "text-red";

  const noteParagraphs = buildAnalystNote(bundle);

  const fetchedDate = new Date(s.fetchedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <div className="space-y-6">
      <Card>
        <Kicker
          index="01"
          title="QUALITY PROFILE"
          subtitle="Six lenses on how durable and predictable the business is."
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {orderedDims.map((d) => {
            const chip = dimensionChip(d);
            const pct = d.score === null ? 0 : Math.max(0, Math.min(100, d.score));
            return (
              <div key={d.key} className="rounded-lg border border-line p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink2">{d.name}</p>
                  <GradeBadge grade={d.grade} />
                </div>
                <span className={`num mt-3 block text-xs font-bold ${TIER_COLOR[chip]}`}>{chip}</span>
                <div className="dim-track mt-1.5">
                  <div className={`dim-fill ${TIER_FILL[chip]}`} style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-2 text-sm text-ink3">{d.detail}</p>
              </div>
            );
          })}
        </div>
      </Card>

      <Card>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink2">Quality Composite</p>
        <div className="mt-2 flex items-center gap-4">
          <p className="num text-4xl font-bold text-ink">
            {q.overallScore !== null ? q.overallScore.toFixed(1) : "n/a"}
            <span className="text-lg font-medium text-ink2"> / 100</span>
          </p>
          <GradeBadge grade={q.overallGrade} />
        </div>
        <div className="mt-6 grid grid-cols-2 gap-4 border-t border-line pt-6 sm:grid-cols-5">
          <div>
            <p className="kpi-label">
              <Term k="roic">ROIC</Term>
            </p>
            <p className="num mt-1 font-semibold text-ink">{roicReading}</p>
          </div>
          <div>
            <p className="kpi-label">
              <Term k="debtToEquity">Debt / Equity</Term>
            </p>
            <p className="num mt-1 font-semibold text-ink">{dteReading}</p>
          </div>
          <div>
            <p className="kpi-label">
              <Term k="buybackYield">Buyback yield</Term>
            </p>
            <p className="num mt-1 font-semibold text-ink">{buybackReading}</p>
          </div>
          <div>
            <p className="kpi-label">Fair value</p>
            <p className="num mt-1 font-semibold text-ink">{fmtMoney(v.composite, ccy)}</p>
          </div>
          <div>
            <p className="kpi-label">Upside / Downside</p>
            <p className={`num mt-1 font-semibold ${upsideClass}`}>{fmtPct(upside)}</p>
          </div>
        </div>
      </Card>

      <Card>
        <Kicker index="" title="ANALYST NOTE" />
        <div className="space-y-4 text-ink3">
          {noteParagraphs.length === 0 ? (
            <p className="italic text-ink2">n/a — insufficient data for an analyst note.</p>
          ) : (
            noteParagraphs.map((p, i) => <p key={i}>{p}</p>)
          )}
        </div>
      </Card>

      <Card>
        <Kicker
          index="02"
          title="PEER COMPARISON"
          subtitle={`Composite quality vs. ${s.sector ?? "peers"}`}
        />
        <InsightPeerPanel
          ticker={s.ticker}
          name={s.name}
          ownQualityScore={q.overallScore}
          ownUpside={upside}
        />
      </Card>

      <p className="text-xs text-ink2">
        Model: InvestorMan quality engine · data: Yahoo Finance + SEC EDGAR · {fetchedDate}
      </p>
    </div>
  );
}
