"use client";

import { DimensionScore, Grade } from "@/lib/finance/types";
import { fmtMoney, fmtPct } from "@/lib/format";
import { dimensionChip } from "@/lib/finance/insightNote";
import { useVariant } from "@/components/VariantProvider";
import GradeBadge from "@/components/GradeBadge";
import InsightPeerPanel from "@/components/InsightPeerPanel";
import Term from "@/components/Term";

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

// Everything computeQuality/composite-dependent on the SuperInvestor tab — the
// six-dimension Quality Profile, the Quality Composite card (fair value,
// upside), the analyst note, and the peer panel's own-stock reading — grades
// off the GLOBALLY selected variant (task brief). `variants` is the
// pre-computed pair (both server-side, no refetch on toggle); `roicReading` /
// `dteReading` / `buybackReading` come off the variant-independent Quality
// Gate + latest statement year, so they're passed once, not per-variant.
export interface InsightVariantData {
  orderedDims: DimensionScore[];
  overallScore: number | null;
  overallGrade: Grade | null;
  fairValue: number | null;
  upside: number | null;
  noteParagraphs: string[];
}

export default function InsightClient({
  ticker,
  name,
  sector,
  currency,
  roicReading,
  dteReading,
  buybackReading,
  fetchedDate,
  variants,
}: {
  ticker: string;
  name: string;
  sector: string | null;
  currency: string;
  roicReading: string;
  dteReading: string;
  buybackReading: string;
  fetchedDate: string;
  variants: { calibrated: InsightVariantData; textbook: InsightVariantData };
}) {
  const { variant } = useVariant();
  const d = variants[variant];
  const upsideClass = d.upside === null ? "text-ink2" : d.upside >= 0 ? "text-green" : "text-red";

  return (
    <div className="space-y-6">
      <Card>
        <Kicker
          index="01"
          title="QUALITY PROFILE"
          subtitle="Six lenses on how durable and predictable the business is."
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {d.orderedDims.map((dim) => {
            const chip = dimensionChip(dim);
            const pct = dim.score === null ? 0 : Math.max(0, Math.min(100, dim.score));
            return (
              <div key={dim.key} className="rounded-lg border border-line p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink2">{dim.name}</p>
                  <GradeBadge grade={dim.grade} />
                </div>
                <span className={`num mt-3 block text-xs font-bold ${TIER_COLOR[chip]}`}>{chip}</span>
                <div className="dim-track mt-1.5">
                  <div className={`dim-fill ${TIER_FILL[chip]}`} style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-2 text-sm text-ink3">{dim.detail}</p>
              </div>
            );
          })}
        </div>
      </Card>

      <Card>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink2">Quality Composite</p>
        <div className="mt-2 flex items-center gap-4">
          <p className="num text-4xl font-bold text-ink">
            {d.overallScore !== null ? d.overallScore.toFixed(1) : "n/a"}
            <span className="text-lg font-medium text-ink2"> / 100</span>
          </p>
          <GradeBadge grade={d.overallGrade} />
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
            <p className="num mt-1 font-semibold text-ink">{fmtMoney(d.fairValue, currency)}</p>
          </div>
          <div>
            <p className="kpi-label">Upside / Downside</p>
            <p className={`num mt-1 font-semibold ${upsideClass}`}>{fmtPct(d.upside)}</p>
          </div>
        </div>
      </Card>

      <Card>
        <Kicker index="" title="ANALYST NOTE" />
        <div className="space-y-4 text-ink3">
          {d.noteParagraphs.length === 0 ? (
            <p className="italic text-ink2">n/a — insufficient data for an analyst note.</p>
          ) : (
            d.noteParagraphs.map((p, i) => <p key={i}>{p}</p>)
          )}
        </div>
      </Card>

      <Card>
        <Kicker index="02" title="PEER COMPARISON" subtitle={`Composite quality vs. ${sector ?? "peers"}`} />
        <InsightPeerPanel ticker={ticker} name={name} ownQualityScore={d.overallScore} ownUpside={d.upside} />
      </Card>

      <p className="text-xs text-ink2">
        Model: InvestorMan quality engine · data: Yahoo Finance + SEC EDGAR · {fetchedDate}
      </p>
    </div>
  );
}
